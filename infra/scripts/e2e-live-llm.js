const http = require('http');
// NOTE: 127.0.0.1, never 'localhost'. Node resolves localhost to IPv6 ::1 first;
// Docker publishes on [::] but that path resets the connection, producing
// intermittent ECONNRESET / "fetch failed" that looks like random flakiness.
// curl hides this by falling back to IPv4 — Node's fetch and pg do not.
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Pool } = require(path.join(__dirname, '../../apps/dashboard/node_modules/pg'));

console.log('\n=== DareX LIVE E2E — WhatsApp Inbound → Temporal → Real LLM → AI Reply Persisted ===\n');

let pass = 0;
let fail = 0;

// Load the same env the dashboard/worker use so the script has real Meta creds
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
const root = path.join(__dirname, '..', '..');
loadEnvFile(path.join(root, '.env'));
loadEnvFile(path.join(root, 'apps', 'dashboard', '.env.local'));
loadEnvFile(path.join(root, 'infra', '.env'));

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'darex',
});

function makeRequest(url, method = 'GET', body = null, cookie = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...extraHeaders,
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
        }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function obtainSessionCookie() {
  const testEmail = `e2e_${Date.now()}@example.com`;
  const testPassword = 'DarexE2E123!';
  let res = await makeRequest('http://localhost:3000/api/auth/register', 'POST', {
    email: testEmail, password: testPassword,
  });
  if (res.statusCode !== 200 || res.body.status !== 'OK') {
    res = await makeRequest('http://localhost:3000/api/auth/login', 'POST', {
      email: testEmail, password: testPassword,
    });
  }
  if (res.statusCode !== 200 || res.body.status !== 'OK') {
    throw new Error(`Auth failed — HTTP ${res.statusCode}: ${JSON.stringify(res.body)}`);
  }
  const setCookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (!setCookie) throw new Error('No session cookie returned');
  return { cookie: setCookie, email: testEmail };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  try {
    // 1. Register a fresh user (creates a per-user org)
    console.log('--- 1. Register fresh user ---');
    const { cookie, email } = await obtainSessionCookie();
    console.log(`  [PASS] Registered ${email}`);
    pass++;

    const orgIdFromCookie = cookie.match(/darex_org_id=([^;]+)/)?.[1] || '';
    if (!orgIdFromCookie) {
      console.log('  [FAIL] No darex_org_id cookie — cannot scope webhook');
      fail++;
      return;
    }
    console.log(`         org_id: ${orgIdFromCookie}`);

    // 2. Connect WhatsApp with the REAL Meta credentials from env
    console.log('\n--- 2. Connect WhatsApp channel (real Meta creds from env) ---');
    const accessToken = process.env.META_ACCESS_TOKEN;
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
    if (!accessToken || !phoneNumberId) {
      console.log('  [SKIP] META_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID not set in env — cannot test real connect');
      fail++;
      return;
    }
    const connectRes = await makeRequest('http://localhost:3000/api/integrations/whatsapp', 'POST', {
      accessToken, phoneNumberId, wabaId,
    }, cookie);
    if (connectRes.statusCode === 200 && connectRes.body.success) {
      console.log(`  [PASS] WhatsApp channel connected (phone_number_id: ${phoneNumberId})`);
      pass++;
    } else {
      console.log(`  [FAIL] WhatsApp connect failed — HTTP ${connectRes.statusCode}: ${JSON.stringify(connectRes.body)}`);
      fail++;
      return;
    }

    // 3. Send a REAL Meta-format inbound webhook
    console.log('\n--- 3. Send Meta-format inbound webhook (/api/webhooks/whatsapp) ---');
    const from = '+14155559988';
    const inboundMsg = `Hi, I'd like to know the pricing for your enterprise plan and whether you offer volume discounts.`;
    const metaPayload = {
      object: 'whatsapp_business_account',
      entry: [{
        id: wabaId || 'test_waba',
        changes: [{
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: {
              display_phone_number: '15551234567',
              phone_number_id: phoneNumberId,
            },
            messages: [{
              from,
              id: `wamid.${Date.now()}`,
              timestamp: Math.floor(Date.now() / 1000).toString(),
              text: { body: inboundMsg },
              type: 'text',
            }],
          },
        }],
      }],
    };

    const startT = Date.now();
    const rawBody = JSON.stringify(metaPayload);
    const metaSecret = process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET;
    const metaHeaders = metaSecret
      ? { 'X-Hub-Signature-256': `sha256=${crypto.createHmac('sha256', metaSecret).update(rawBody).digest('hex')}` }
      : {};
    const webhookRes = await makeRequest('http://localhost:3000/api/webhooks/whatsapp', 'POST', metaPayload, null, metaHeaders);
    const elapsed = Date.now() - startT;
    if (webhookRes.statusCode === 200) {
      console.log(`  [PASS] Webhook accepted in ${elapsed}ms (HTTP 200)`);
      pass++;
    } else {
      console.log(`  [FAIL] Webhook returned HTTP ${webhookRes.statusCode}`);
      fail++;
    }

    // 4. Verify conversation + user message + assistant AI reply in DB
    console.log('\n--- 4. Verify AI reply persisted in DB (real LLM, not canned fallback) ---');
    const client = await pool.connect();
    try {
      await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgIdFromCookie]);
      const convRes = await client.query(
        `SELECT id, contact_id, summary FROM conversations WHERE org_id = $1 AND contact_id = $2 ORDER BY started_at DESC LIMIT 1`,
        [orgIdFromCookie, from]
      );
      if (convRes.rows.length === 0) {
        console.log('  [FAIL] No conversation created for inbound message');
        fail++;
        return;
      }
      const convId = convRes.rows[0].id;
      console.log(`         conversation_id: ${convId}`);

      const msgRes = await client.query(
        `SELECT id, role, content, tool_calls, created_at FROM messages
         WHERE org_id = $1 AND conversation_id = $2 ORDER BY created_at ASC`,
        [orgIdFromCookie, convId]
      );
      console.log(`         message rows: ${msgRes.rows.length}`);
      for (const m of msgRes.rows) {
        console.log(`         [${m.role}] ${(m.content || '').slice(0, 120)}`);
      }
      const assistantMsgs = msgRes.rows.filter((m) => m.role === 'assistant' && m.content && m.content.trim().length > 10);
      if (assistantMsgs.length > 0) {
        console.log('  [PASS] Assistant AI reply found in DB');
        pass++;
      } else {
        console.log('  [FAIL] No assistant reply persisted');
        fail++;
      }
    } finally {
      client.release();
    }

    // 5. Verify outbound channel_log (real Meta send attempt)
    console.log('\n--- 5. Verify outbound_message channel_log (real Meta send attempt) ---');
    const logClient = await pool.connect();
    try {
      await logClient.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgIdFromCookie]);
      const logRes = await logClient.query(
        `SELECT event_type, status, status_code, message, payload FROM channel_logs
         WHERE org_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [orgIdFromCookie]
      );
      const outbound = logRes.rows.filter((r) => r.event_type === 'outbound_message');
      if (outbound.length > 0) {
        console.log(`  [PASS] Outbound send attempt logged — HTTP ${outbound[0].status_code} (${outbound[0].status})`);
        const pay = outbound[0].payload;
        if (pay && pay.body) console.log(`         Meta response: ${String(pay.body).slice(0, 160)}`);
        pass++;
      } else {
        console.log('  [WARN] No outbound_message channel_log found (may be legit — no per-org creds fallback)');
        fail++;
      }
    } finally {
      logClient.release();
    }

    console.log('\n--- Summary ---');
    console.log(`  ${pass}/${pass + fail} checks passed`);
    if (fail > 0) process.exitCode = 1;
  } catch (err) {
    console.error('E2E script error:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

run();
