const http = require('http');

console.log('\n=== Darex Phase 2 — Connector Layer Exit Criteria Check ===\n');

let pass = 0;
let fail = 0;

const ALL_PROVIDERS = [
  'whatsapp',
  'gmail',
  'google-calendar',
  'hubspot',
  'razorpay',
  'meta-ads',
  'google-ads',
];

function makeRequest(url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const postData = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data });
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function runPhase2Checks() {
  try {
    // 1. Connect all 7 integrations via API
    console.log('--- Connecting 7 Integrations ---');
    for (const provider of ALL_PROVIDERS) {
      const res = await makeRequest('http://localhost:3000/api/integrations', 'POST', {
        provider,
        action: 'connect',
      });
      if (res.statusCode === 200 && res.body.success) {
        console.log(`  [PASS] ${provider} connected successfully`);
        pass++;
      } else {
        console.log(`  [FAIL] ${provider} connect failed — HTTP ${res.statusCode}`);
        fail++;
      }
    }

    // 2. Fetch GET /api/integrations & verify live status
    console.log('\n--- Verifying Integrations Live Status ---');
    const getRes = await makeRequest('http://localhost:3000/api/integrations', 'GET');
    if (getRes.statusCode === 200 && getRes.body.integrations) {
      const connectedCount = getRes.body.integrations.filter((i) => i.connected).length;
      if (connectedCount === 7) {
        console.log(`  [PASS] All 7/7 integrations showing "Connected" + live status`);
        pass++;
      } else {
        console.log(`  [FAIL] Only ${connectedCount}/7 integrations showing connected`);
        fail++;
      }
    } else {
      console.log(`  [FAIL] GET /api/integrations failed — HTTP ${getRes.statusCode}`);
      fail++;
    }

    console.log('\n--- Summary ---');
    const total = pass + fail;
    if (fail === 0) {
      console.log(`  ALL CHECKS PASSED (${pass}/${total}) — Phase 2 exit criteria MET!\n`);
    } else {
      console.log(`  ${fail}/${total} CHECKS FAILED`);
      process.exit(1);
    }
  } catch (err) {
    console.error('Phase 2 test script error:', err);
    process.exit(1);
  }
}

runPhase2Checks();
