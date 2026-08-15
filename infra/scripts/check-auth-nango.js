const http = require('http');

const PORT = process.env.DASHBOARD_PORT || 3000;
const BASE = `http://localhost:${PORT}`;

console.log('\n=== Testing SuperTokens Auth & Nango OAuth Integration ===\n');

function makeRequest(url, method = 'GET', body = null, cookie = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const postData = body ? JSON.stringify(body) : null;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(data), headers: res.headers });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: data, headers: res.headers });
        }
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function testAuthAndNango() {
  let pass = 0;
  let fail = 0;

  try {
    const testEmail = `owner_${Date.now()}@example.com`;
    const testPassword = 'Password123!';

    // 1. Test Registration
    console.log('1. Testing User Registration (/api/auth/register)...');
    const regRes = await makeRequest(`${BASE}/api/auth/register`, 'POST', {
      email: testEmail,
      password: testPassword,
    });

    if (regRes.statusCode === 200 && regRes.body.status === 'OK' && regRes.body.userId) {
      console.log(`   [PASS] Registered user: ${regRes.body.userId}`);
      pass++;
    } else {
      console.log(`   [FAIL] Registration failed — HTTP ${regRes.statusCode}:`, regRes.body);
      fail++;
    }

    // 2. Test Login
    console.log('\n2. Testing User Login (/api/auth/login)...');
    const loginRes = await makeRequest(`${BASE}/api/auth/login`, 'POST', {
      email: testEmail,
      password: testPassword,
    });

    let cookie = '';
    if (loginRes.statusCode === 200 && loginRes.body.status === 'OK' && loginRes.body.userId) {
      console.log(`   [PASS] Authenticated user: ${loginRes.body.email}`);
      pass++;
      cookie = (loginRes.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    } else {
      console.log(`   [FAIL] Login failed — HTTP ${loginRes.statusCode}:`, loginRes.body);
      fail++;
    }

    // 3. Test Integrations Page (authenticated)
    console.log('\n3. Testing Integrations Nango OAuth API (/api/integrations)...');
    const intRes = await makeRequest(`${BASE}/api/integrations`, 'GET', null, cookie);
    if (intRes.statusCode === 200 && intRes.body.integrations) {
      console.log(`   [PASS] Integrations API working. Total apps: ${intRes.body.integrations.length}`);
      pass++;
    } else {
      console.log(`   [FAIL] Integrations API failed — HTTP ${intRes.statusCode}`);
      fail++;
    }

    console.log('\n--- Auth & Nango Verification Summary ---');
    if (fail === 0) {
      console.log(`  ALL ${pass}/${pass} CHECKS PASSED!\n`);
    } else {
      console.log(`  ${fail} CHECKS FAILED\n`);
      process.exit(1);
    }
  } catch (err) {
    console.error('Test error:', err);
    process.exit(1);
  }
}

testAuthAndNango();
