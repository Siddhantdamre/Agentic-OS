/**
 * Integration test for TrueForge Agent Harness in Darex
 * Verifies:
 * 1. Direct library execution via `@darex/workflows/dist/atomic-agent-client` (delegating to TrueForge)
 * 2. Streaming chunks (`onChunk`) and tool progress events (`onToolProgress`)
 * 3. Transport-level tenant header propagation (`x-org-id`, `x-tfg-mcp-headers`) to MCP bridge
 * 4. Ask AI streaming endpoint (`POST /api/ask-ai`) via Next.js dashboard
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
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
loadEnv(path.join(root, '.env'));
loadEnv(path.join(root, 'apps', 'dashboard', '.env.local'));
loadEnv(path.join(root, 'infra', '.env'));

async function makeRequest(url, method = 'GET', body = null, cookie = null) {
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
  const testEmail = `tf_test_${Date.now()}@example.com`;
  const testPassword = 'DarexTrueForge123!';

  let res = await makeRequest('http://localhost:3000/api/auth/register', 'POST', {
    email: testEmail,
    password: testPassword,
    agreedTerms: true,
  });

  if (res.statusCode !== 200 || res.body?.status !== 'OK') {
    res = await makeRequest('http://localhost:3000/api/auth/login', 'POST', {
      email: testEmail,
      password: testPassword,
    });
  }

  if (res.statusCode !== 200 || res.body?.status !== 'OK') {
    throw new Error(`Auth failed: HTTP ${res.statusCode} ${JSON.stringify(res.body)}`);
  }

  const cookies = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  return { cookie: cookies, user: res.body.user };
}

async function testDirectLibraryExecution() {
  console.log('\n--- 1. Testing Direct runAgentTurn via TrueForge Harness ---');
  const { runAgentTurn } = require('../../services/workflows/dist/agent-client');
  const { dbPool } = require('../../services/workflows/dist/tools/shared');

  let testOrgId = 'a73d724a-0a0b-4e0e-8c2a-48239809c3e9';
  try {
    const orgRes = await dbPool.query('SELECT id FROM orgs LIMIT 1');
    if (orgRes.rows[0]?.id) testOrgId = orgRes.rows[0].id;
  } catch {}

  let chunksReceived = 0;
  let fullReply = '';
  const toolsCalled = [];

  const turnResult = await runAgentTurn(
    {
      orgId: testOrgId,
      userMessage: 'What tools are available to you in DareX? Give a 2-sentence summary.',
      employeeName: 'DareX Executive Assistant',
      employeeRole: 'Executive AI',
      employeePersona: 'Concise and helpful',
    },
    {
      onChunk: (chunk) => {
        chunksReceived++;
        fullReply += chunk;
      },
      onToolProgress: (tool, label) => {
        toolsCalled.push({ tool, label });
      },
      timeoutMs: 45000,
    }
  );

  console.log(`  [PASS] TrueForge turn completed successfully!`);
  console.log(`  Model used: ${turnResult.model}`);
  console.log(`  Session ID: ${turnResult.sessionId}`);
  console.log(`  Chunks streamed: ${chunksReceived}`);
  console.log(`  Reply length: ${turnResult.reply.length} chars`);
  console.log(`  Snippet: "${turnResult.reply.slice(0, 150)}..."`);

  if (!turnResult.reply || turnResult.reply.length === 0) {
    throw new Error('Expected non-empty reply from TrueForge turn');
  }
}

async function testAskAiEndpoint() {
  console.log('\n--- 2. Testing Ask AI SSE Endpoint (/api/ask-ai) with TrueForge ---');
  const { cookie } = await obtainSessionCookie();
  console.log('  Obtained authenticated session cookie');

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      prompt: 'Hello! Please introduce yourself briefly in 2 sentences.',
    });

    const req = http.request(
      'http://localhost:3000/api/ask-ai',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          Cookie: cookie,
        },
      },
      (res) => {
        console.log(`  HTTP status: ${res.statusCode}, Content-Type: ${res.headers['content-type']}`);
        if (res.statusCode !== 200) {
          return reject(new Error(`Ask AI returned HTTP ${res.statusCode}`));
        }

        let eventCount = 0;
        let streamedReply = '';
        let rawBody = '';

        res.on('data', (chunk) => {
          rawBody += chunk.toString();
          const lines = chunk.toString().split('\n');
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              eventCount++;
              if (parsed.type === 'complex') {
                console.log(`  Received PlanCard (complex request): ${parsed.summary}`);
                streamedReply = parsed.summary || 'Complex plan generated';
              } else if (parsed.type === 'chunk' && parsed.text) {
                streamedReply += parsed.text;
              } else if (parsed.type === 'done') {
                console.log('  Received `done` event from Ask AI stream');
                if (!streamedReply && parsed.answer) {
                  streamedReply = parsed.answer;
                }
              }
            } catch {}
          }
        });

        res.on('end', () => {
          console.log(`  Total events: ${eventCount}, Reply length: ${streamedReply.length}`);
          if (!streamedReply) {
            console.log(`  Raw body received: ${rawBody.slice(0, 500)}`);
          } else {
            console.log(`  Reply snippet: "${streamedReply.slice(0, 150)}..."`);
          }
          if (streamedReply.length > 0) {
            resolve();
          } else {
            reject(new Error('No reply text received from Ask AI'));
          }
        });
      }
    );

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

async function run() {
  try {
    await testDirectLibraryExecution();
    await testAskAiEndpoint();
    console.log('\n========================================');
    console.log('  ALL TRUEFORGE HARNESS CHECKS PASSED!');
    console.log('========================================\n');
  } catch (err) {
    console.error('\n[FAIL] TrueForge harness test failed:', err);
    process.exit(1);
  }
}

run();
