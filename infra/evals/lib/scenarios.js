'use strict';

const fs = require('fs');
const path = require('path');
const { loadPg, superuserConfig, missingMemoryTables, missingTables, setOrg, resetRole, setAppRole } = require('./db');
const { loadRetrieveModule } = require('./retrieve-load');
const { KAPOOR, seedReturningContact, cleanupEvalOrg } = require('../seed-returning-contact');
const {
  parseBhk,
  parseBudget,
  searchOutput,
  applyChargeEvent,
  validateOutboundDraft,
} = require('./listings-match');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const SKILLS_DIR = path.join(__dirname, '..', '..', 'docker', 'atomic-agent', 'custom-skills');

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function readJsonFixture(name) {
  return JSON.parse(readFixture(name));
}

function notConnectedResult(tool, action) {
  const base = readJsonFixture('not-connected.json');
  return {
    ...base,
    tool,
    action,
    message: `${tool} not connected. Authorize via Nango OAuth at /connectors to enable real actions.`,
    data: { connected: false, setupUrl: '/connectors' },
  };
}

function allowMissingMemory() {
  return process.env.EVAL_ALLOW_MISSING_MEMORY === '1';
}

async function withDb(fn) {
  const { Client } = loadPg();
  const client = new Client(superuserConfig());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

async function memoryStatus() {
  try {
    return await withDb(async (client) => {
      const missing = await missingMemoryTables(client);
      return { ok: true, missing, ready: missing.length === 0 };
    });
  } catch (err) {
    return { ok: false, missing: null, ready: false, error: err.message };
  }
}

function tablesMissingError(missing) {
  return `M1 not applied — missing tables: ${missing.join(', ')}. Need infra/db/migrations/013_memory_rag.sql`;
}

function reTablesMissingError(missing) {
  return `015_packs.sql not applied — missing tables: ${missing.join(', ')}. Will not invent inventory.`;
}

async function liveReListingsSearch(vars) {
  const inventory = readJsonFixture('sheet-inventory.json');
  const stamp = Date.now();
  try {
    return await withDb(async (client) => {
      const missing = await missingTables(client, ['re_listings']);
      if (missing.length > 0) {
        return { skip: false, error: reTablesMissingError(missing) };
      }

      await resetRole(client);
      const orgARes = await client.query(
        `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
        ['Eval RE Org A', `eval-re-a-${stamp}`],
      );
      const orgBRes = await client.query(
        `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
        ['Eval RE Org B', `eval-re-b-${stamp}`],
      );
      const orgA = orgARes.rows[0].id;
      const orgB = orgBRes.rows[0].id;

      const insertRow = async (orgId, row) => {
        await client.query(
          `INSERT INTO re_listings (
             org_id, source, source_ref, title, locality, city, bhk, list_price, currency, status, last_source_sync_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            orgId,
            row.source || 'sheets',
            row.sourceRef || row.id,
            row.title,
            row.locality,
            row.city,
            row.bhk,
            row.listPrice,
            row.currency || 'INR',
            row.status || 'active',
            row.lastSourceSyncAt || '2026-08-01T00:00:00.000Z',
          ],
        );
      };

      try {
        for (const row of inventory.orgA || []) await insertRow(orgA, row);
        for (const row of inventory.orgB || []) await insertRow(orgB, row);

        await setOrg(client, orgA);
        await setAppRole(client);
        const res = await client.query(
          `SELECT source_ref, source, title, locality, city, bhk, list_price, currency, rera_id, status, last_source_sync_at
             FROM re_listings`,
        );
        await resetRole(client);

        const ids = res.rows.map((r) => r.source_ref);
        if (ids.includes('ORG-B-LEAK-99')) {
          throw new Error('two-org listings leaked: ORG-B-LEAK-99 visible under orgA RLS');
        }
        if (ids.includes('LST-FAKE-88')) {
          throw new Error('invented listing LST-FAKE-88 appeared in projection');
        }

        const rows = res.rows.map((row) => ({
          id: row.source_ref,
          source: row.source,
          sourceRef: row.source_ref,
          title: row.title,
          locality: row.locality,
          city: row.city,
          bhk: row.bhk == null ? null : Number(row.bhk),
          listPrice: row.list_price == null ? null : Number(row.list_price),
          currency: row.currency || 'INR',
          reraId: row.rera_id,
          status: row.status || 'active',
          lastSourceSyncAt: row.last_source_sync_at,
        }));
        const filters = {
          bhk: parseBhk(vars.bhk),
          locality: vars.locality,
          maxPrice: parseBudget(vars.maxPrice),
        };
        return { skip: false, output: JSON.stringify(searchOutput(rows, filters)), orgId: orgA };
      } finally {
        await resetRole(client).catch(() => {});
        await cleanupEvalOrg(client, orgA).catch(() => {});
        await cleanupEvalOrg(client, orgB).catch(() => {});
      }
    });
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    const message = err instanceof Error ? err.message || code || err.name : String(err);
    if (code === 'ECONNREFUSED' || /ECONNREFUSED|connect|timeout|unreachable/i.test(message + code)) {
      return { skip: true, reason: `database unreachable: ${message || code}` };
    }
    return { skip: false, error: message || 'live listing search failed' };
  }
}

async function liveEmptyOrgOutput() {
  const status = await memoryStatus();
  if (!status.ok) {
    return { skip: true, reason: `database unreachable: ${status.error}` };
  }
  if (!status.ready) {
    return { skip: false, error: tablesMissingError(status.missing) };
  }

  let retrieve;
  try {
    retrieve = loadRetrieveModule();
  } catch (err) {
    return { skip: false, error: err.message };
  }

  return withDb(async (client) => {
    const slug = `eval-empty-${Date.now()}`;
    const orgRes = await client.query(
      `INSERT INTO orgs (name, slug, plan, status) VALUES ($1, $2, 'enterprise', 'active') RETURNING id`,
      ['Eval Empty Org', slug],
    );
    const orgId = orgRes.rows[0].id;
    try {
      await resetRole(client);
      await setOrg(client, orgId);
      await setAppRole(client);
      let total = 0;
      for (const table of ['org_memory', 'employee_memory', 'entity_memory', 'conversation_memory']) {
        const countRes = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
        total += countRes.rows[0].n;
      }
      await resetRole(client);
      if (total !== 0) {
        throw new Error(`empty org ${orgId} already has ${total} memory rows — refusing to treat as empty`);
      }
      const memory = await retrieve.retrieveMemory({
        orgId,
        query: KAPOOR.query,
        entityType: KAPOOR.entityType,
        entityId: KAPOOR.entityId,
      });
      return {
        skip: false,
        output: retrieve.formatRetrievedFactsBlock(memory),
        orgId,
        rowCount: 0,
      };
    } finally {
      await cleanupEvalOrg(client, orgId).catch(() => {});
    }
  });
}

async function liveReturningContactOutput(vars) {
  const status = await memoryStatus();
  if (!status.ok) {
    return { skip: true, reason: `database unreachable: ${status.error}` };
  }
  if (!status.ready) {
    return { skip: false, error: tablesMissingError(status.missing) };
  }

  let retrieve;
  try {
    retrieve = loadRetrieveModule();
  } catch (err) {
    return { skip: false, error: err.message };
  }

  const query = (vars && vars.prompt) || KAPOOR.query;
  const entityType = (vars && vars.entityType) || KAPOOR.entityType;
  const entityId = (vars && vars.entityId) || KAPOOR.entityId;

  return withDb(async (client) => {
    const seeded = await seedReturningContact(client);
    try {
      const memory = await retrieve.retrieveMemory({
        orgId: seeded.orgId,
        query,
        entityType,
        entityId,
      });
      if (!memory.citations || memory.citations.length === 0) {
        throw new Error(
          'retrieveMemory returned empty index for seeded Kapoor contact — broken retrieve would hide a prior fact',
        );
      }
      return {
        skip: false,
        output: retrieve.formatRetrievedFactsBlock(memory),
        orgId: seeded.orgId,
        seededId: seeded.row && seeded.row.id,
      };
    } finally {
      await cleanupEvalOrg(client, seeded.orgId).catch(() => {});
    }
  });
}

function skillPlaybookOn(skillName) {
  const skillFile = path.join(SKILLS_DIR, skillName, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    throw new Error(`playbook-on: missing ${skillFile} — R1 skills must be in the tree`);
  }
  const body = fs.readFileSync(skillFile, 'utf8');
  return `PLAYBOOK_MOUNTED=1\nSKILL=${skillName}\nREBUILD_REQUIRED=atomic-agent image after SKILL.md edits\n\n${body}`;
}

function skillPlaybookOff(skillName) {
  return `PLAYBOOK_MOUNTED=0\nSKILL=${skillName}\nNo org SOP / starter-skill playbook is mounted for this run.\nDo not invent Gmail, Sheets, or CRM rows.`;
}

function connectedFixturePath() {
  return process.env.EVAL_CONNECTED_FIXTURE || path.join(FIXTURES, 'connected-recorded.json');
}

function connectedOutput(tool) {
  const fixturePath = connectedFixturePath();
  if (!fs.existsSync(fixturePath)) {
    return {
      skip: true,
      reason: `no recorded provider fixture at ${fixturePath} — refusing to fabricate connected success (set EVAL_CONNECTED_FIXTURE)`,
    };
  }
  const parsed = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  if (parsed.success === true && !parsed.providerRecorded && parsed.httpStatus == null) {
    throw new Error('connected fixture looks handwritten ({success:true} without providerRecorded/httpStatus) — refuse');
  }
  if (!parsed.providerRecorded && parsed.httpStatus == null) {
    return {
      skip: true,
      reason: 'connected fixture missing providerRecorded/httpStatus — refusing to treat as live success',
    };
  }
  return { skip: false, output: JSON.stringify({ tool, ...parsed }) };
}

/**
 * Resolve the candidate output for a golden. Never calls Ask AI / product request path.
 */
async function resolveScenarioOutput(vars) {
  const scenario = vars.scenario || vars.darexScenario;
  const tool = vars.tool || 'google-sheets';
  const action = vars.action || 'sheets_read';

  switch (scenario) {
    case 'empty-org': {
      try {
        const live = await liveEmptyOrgOutput();
        if (live.skip) return { ...live, output: null };
        return live;
      } catch (err) {
        return { skip: false, error: err.message };
      }
    }
    case 'returning-contact': {
      try {
        const live = await liveReturningContactOutput(vars);
        if (live.skip) return { ...live, output: null };
        return live;
      } catch (err) {
        return { skip: false, error: err.message };
      }
    }
    case 'never-configured':
    case 'disconnected-sheets':
    case 'disconnected-mls':
      return { skip: false, output: JSON.stringify(notConnectedResult(tool, action)) };
    case 'revoked':
      return {
        skip: false,
        output: JSON.stringify({
          ...notConnectedResult(tool, action),
          message: `${tool} token revoked or expired. Re-authorize via Nango OAuth at /connectors.`,
          data: { connected: false, setupUrl: '/connectors', reason: 'revoked' },
        }),
      };
    case 'connected':
      return connectedOutput(tool);
    case 'skill-playbook-on':
      return { skip: false, output: skillPlaybookOn(vars.skill || 'gmail-playbook') };
    case 'skill-playbook-off':
      return { skip: false, output: skillPlaybookOff(vars.skill || 'gmail-playbook') };
    case 'skill-playbook-on-disconnected':
      return {
        skip: false,
        output: `${skillPlaybookOn(vars.skill || 'gmail-playbook')}\nTOOL_RESULT=${JSON.stringify(
          notConnectedResult(vars.tool || 'gmail', vars.action || 'fetch_latest_emails'),
        )}`,
      };
    case 're-listings-search':
    case 're-listings-zero': {
      const inventory = readJsonFixture('sheet-inventory.json');
      const orgKey = vars.org || 'orgA';
      const rows = inventory[orgKey] || [];
      const filters = {
        bhk: parseBhk(vars.bhk),
        locality: vars.locality,
        maxPrice: parseBudget(vars.maxPrice),
      };
      return { skip: false, output: JSON.stringify(searchOutput(rows, filters)) };
    }
    case 're-listings-search-live':
    case 're-listings-zero-live': {
      try {
        return await liveReListingsSearch(vars);
      } catch (err) {
        return { skip: false, error: err.message };
      }
    }
    case 're-fair-housing':
    case 're-rera-missing': {
      const result = validateOutboundDraft(vars.draft || '', vars.intent || 'send');
      return { skip: false, output: JSON.stringify(result) };
    }
    case 're-rent-paid-no-webhook': {
      const charge = {
        id: 'chg-eval-1',
        status: 'open',
        amount: 50000,
        currency: 'INR',
        pspPaymentId: null,
        closedReason: null,
        claimedPaidAt: null,
      };
      const next = applyChargeEvent(charge, { kind: 'tenant_claim' }, '2026-08-13T00:00:00.000Z');
      return {
        skip: false,
        output: JSON.stringify({
          closed: next.status === 'closed',
          charge: next,
          tenantClaimCloses: false,
        }),
      };
    }
    default:
      return { skip: false, error: `unknown scenario ${JSON.stringify(scenario)}` };
  }
}

module.exports = {
  allowMissingMemory,
  memoryStatus,
  resolveScenarioOutput,
  notConnectedResult,
  skillPlaybookOn,
  skillPlaybookOff,
  readFixture,
  readJsonFixture,
};
