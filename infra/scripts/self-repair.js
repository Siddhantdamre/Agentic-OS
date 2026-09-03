#!/usr/bin/env node
'use strict';
/**
 * THE BUG TRIAGE LOOP — read a red gate, work out what it means, propose a fix.
 *
 * This repo has fifty-odd deterministic checkers, and each one knows what
 * invariant it protects and says so in its own header. What it never had is
 * anything that reads a red gate and decides what to do. So a failure sat in a
 * terminal until a person read it — and in this repo's own history, repeatedly,
 * nobody did: CI was red on four consecutive pushes, `demo-ai-employee.js` went
 * red unnoticed, and `check-config-drift.js` correctly reported an empty model
 * key to an empty room.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * It never edits a file, commits, pushes or runs a migration. The dangerous
 * output of an automated repair loop is not a bad patch — a bad patch gets
 * caught. It is a plausible patch that makes the checker pass by removing the
 * invariant the checker existed to protect, which is unreviewable by
 * construction because the thing that would have caught it is what changed.
 *
 * Proposals are written to a file for a person. That is the whole product.
 *
 * ── WHY MOST OF THIS COSTS NOTHING ──────────────────────────────────────────
 *
 * Triage is deterministic (ADR 14) and needs no model. In this repo's measured
 * history most red lines were never code at all — a missing credential, a
 * package manager that could not launch itself, a provider throttling. Sorting
 * those out is the majority of the value and it is free. Only a confirmed code
 * defect reaches a model.
 *
 * Usage:
 *   node infra/scripts/self-repair.js               triage the gate, propose fixes
 *   node infra/scripts/self-repair.js --triage-only never call a model
 *   node infra/scripts/self-repair.js --fast        gate without the containers
 *   node infra/scripts/self-repair.js --self-test   no gate, no network
 *
 * Exit: 0 when no code defect was found, 1 when one was.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
require('./lib/env').loadRepoEnv();

const ROOT = path.join(__dirname, '..', '..');
const TRIAGE_ONLY = process.argv.includes('--triage-only');
const FAST = process.argv.includes('--fast');
const SELF_TEST = process.argv.includes('--self-test');

const REPAIR = require(path.join(ROOT, 'services/workflows/dist/self-repair.js'));

/**
 * Run the gate and return its failure lines.
 *
 * Reads the runner's own output rather than re-implementing any check. The gate
 * is the authority on what failed; this script's only job is deciding what that
 * means.
 */
function parseFailures(out) {
  const lines = String(out || '').split('\n');
  const failures = [];

  // The runner prints "FAILED — <suite>", a BLANK LINE, then its evidence; and
  // "COULD NOT RUN" with the reason on the following line. Both are failures
  // worth triaging; they simply classify differently.
  //
  // The blank line after the heading is why this is a function and not two
  // copies: the first version broke on the first empty line and therefore
  // captured nothing at all, while its self-test — holding its own copy of the
  // same loop — agreed with it. Leading blanks are skipped, and a blank only
  // ends the block once evidence has been captured. Without that boundary the
  // next suite's evidence is attributed to the previous suite, and a proposal
  // gets written about the wrong file.
  for (let i = 0; i < lines.length; i += 1) {
    const failed = /^\s*FAILED — (.+)$/.exec(lines[i]);
    if (failed) {
      const suite = failed[1].trim();
      let captured = 0;
      for (let j = i + 1; j < Math.min(i + 16, lines.length); j += 1) {
        const l = lines[j].trim();
        if (/^FAILED — /.test(l) || /^─+$/.test(l) || /^NOT CHECKED HERE/.test(l)) break;
        if (!l) {
          if (captured) break;
          continue;
        }
        if (/^\(no recognised failure line/.test(l)) continue;
        failures.push({ suite, detail: l });
        captured += 1;
      }
    }
    const blocked = /^\s*\[ \?{5} \]\s+(.+?)\s+— COULD NOT RUN/.exec(lines[i]);
    if (blocked && lines[i + 1] && lines[i + 1].trim()) {
      failures.push({ suite: blocked[1].trim(), detail: lines[i + 1].trim() });
    }
  }
  return failures;
}

function collectFailures() {
  const args = [path.join(__dirname, 'verify.js')];
  if (FAST) args.push('--fast');
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: ROOT,
    timeout: 1_800_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { failures: parseFailures(out), exitCode: r.status, sawOutput: out.length > 0 };
}

/**
 * The header comment of the script that reported a failure.
 *
 * This is the single most useful context available and it is already written:
 * every checker in this repo opens by stating what it protects and what went
 * wrong the day it was written. A model given that will argue about the
 * invariant; a model given only "FAIL" will guess.
 */
function checkerHeaderFor(suiteName) {
  const slug = suiteName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dir = __dirname;
  const candidates = fs.readdirSync(dir).filter((f) => /^(check|lint)-.*\.js$/.test(f));
  const hit = candidates.find((f) => {
    const base = f.replace(/^(check|lint)-/, '').replace(/\.js$/, '');
    return slug.includes(base) || base.includes(slug.split('-')[0]);
  });
  if (!hit) return '';
  const body = fs.readFileSync(path.join(dir, hit), 'utf8');
  const m = /\/\*\*([\s\S]*?)\*\//.exec(body);
  return m ? `(from ${hit})\n${m[1].replace(/^\s*\*ic?/gm, '').replace(/^\s*\*/gm, '')}` : '';
}

/** Ask the model for a proposal. Returns null when no model is reachable. */
async function proposeFix(finding) {
  const base = process.env.LITELLM_BASE_URL || 'http://127.0.0.1:4000';
  const key = process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY;
  if (!key) return null;

  const prompt = REPAIR.buildRepairPrompt(finding, checkerHeaderFor(finding.suite));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify({
        model: 'atomic-agent',
        temperature: 0,
        max_tokens: 700,
        messages: [
          {
            role: 'system',
            content:
              'You diagnose failing verification checks in a production codebase. '
              + 'You never propose a change that makes a check pass without restoring '
              + 'what it protects. You say when the evidence is insufficient.',
          },
          { role: 'user', content: prompt },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (SELF_TEST) return selfTest();

  console.log('bug triage — reading the gate\n');
  const { failures, sawOutput } = collectFailures();

  if (!sawOutput) {
    console.log('  the gate produced no output at all — nothing to triage.');
    console.log('  This is not a clean run. Run verify.js directly and see why.');
    process.exit(1);
  }

  const t = REPAIR.triage(failures);
  console.log(`  ${t.verdict}\n`);

  if (t.findings.length === 0) {
    console.log('  PASS — the gate is green.');
    process.exit(0);
  }

  const byKind = { code: [], unknown: [], environment: [], upstream: [] };
  for (const f of t.findings) byKind[f.kind].push(f);

  for (const kind of ['code', 'unknown', 'environment', 'upstream']) {
    if (!byKind[kind].length) continue;
    console.log(`  ${kind.toUpperCase()} (${byKind[kind].length})`);
    for (const f of byKind[kind]) {
      console.log(`    ${f.suite}`);
      console.log(`      ${f.detail.slice(0, 150)}`);
      console.log(`      -> ${f.because}`);
    }
    console.log('');
  }

  const proposals = [];
  if (t.repairable.length && !TRIAGE_ONLY) {
    console.log(`  diagnosing ${t.repairable.length} code defect(s)...\n`);
    for (const f of t.repairable) {
      const raw = await proposeFix(f);
      if (raw === null) {
        console.log(`    ${f.suite}: no model reachable — triage only`);
        continue;
      }
      const verdict = REPAIR.proposalIsUseful(raw);
      if (!verdict.useful) {
        console.log(`    ${f.suite}: proposal withheld — ${verdict.reason}`);
        continue;
      }
      proposals.push({ finding: f, proposal: raw });
      console.log(`    ${f.suite}: proposal recorded`);
    }
  }

  if (proposals.length) {
    const outPath = path.join(ROOT, 'REPAIR_PROPOSALS.md');
    const body = [
      '# Repair proposals',
      '',
      `Generated ${new Date().toISOString()} by \`infra/scripts/self-repair.js\`.`,
      '',
      '**Nothing here has been applied.** These are diagnoses for a person to',
      'review. A patch that makes a check pass without restoring what the check',
      'protects is unreviewable by construction — read the INVARIANT section',
      'first, and reject anything that changes the check itself.',
      '',
      ...proposals.flatMap(({ finding, proposal }) => [
        `## ${finding.suite}`,
        '',
        '```',
        finding.detail,
        '```',
        '',
        proposal.trim(),
        '',
      ]),
    ].join('\n');
    fs.writeFileSync(outPath, body, 'utf8');
    console.log(`\n  ${proposals.length} proposal(s) written to REPAIR_PROPOSALS.md`);
    console.log('  Nothing was applied. Review before acting.');
  }

  process.exit(t.counts.code > 0 ? 1 : 0);
}

/** No gate, no network. Asserts the parsing this script owns. */
function selfTest() {
  let pass = 0;
  const fail = [];
  const check = (label, cond) => { if (cond) pass += 1; else fail.push(label); };

  const sample = [
    '  FAILED — typecheck (all workspaces)',
    '',
    "    src/a.ts(1,1): error TS2554: Expected 3 arguments",
    '',
    '  [ ????? ]  lint  — COULD NOT RUN      ',
    '            pnpm is not installed on this machine.',
  ].join('\n');

  // Calls the real parser. An earlier version held its own copy of the loop
  // and agreed with the bug in it — two copies of a parser is the same defect
  // this repo keeps finding, and a self-test is the worst place for it.
  const found = parseFailures(sample);

  check('a FAILED block skips the blank line before its evidence', found.length === 2);
  check('the type error is captured', found.some((x) => /error TS2554/.test(x.detail)));
  check('a COULD NOT RUN block is captured', found.some((x) => x.suite === 'lint'));

  // Evidence must not leak across suites: two failures in a row, each with its
  // own line, must stay attributed to their own suite.
  const twoSuites = parseFailures([
    '  FAILED — alpha',
    '',
    '    AssertionError: alpha broke',
    '',
    '  FAILED — beta',
    '',
    '    error TS1005: beta broke',
  ].join('\n'));
  check('evidence stays with its own suite',
    twoSuites.length === 2
    && twoSuites[0].suite === 'alpha' && /alpha broke/.test(twoSuites[0].detail)
    && twoSuites[1].suite === 'beta' && /beta broke/.test(twoSuites[1].detail));

  const t = REPAIR.triage(found);
  check('the type error is triaged as code', t.counts.code === 1);
  check('the missing tool is triaged as environment', t.counts.environment === 1);
  check('only the code defect is repairable', t.repairable.length === 1);
  check('a header is found for a real checker', checkerHeaderFor('tenant scope lint').length > 0);

  console.log(`self-test: ${pass} passed, ${fail.length} failed`);
  for (const f of fail) console.log(`  FAIL ${f}`);
  process.exit(fail.length ? 1 : 0);
}

main().catch((err) => {
  console.error(`self-repair failed: ${err && err.message}`);
  process.exit(1);
});
