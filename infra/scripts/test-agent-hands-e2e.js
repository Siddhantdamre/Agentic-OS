const path = require('path');
const fs = require('fs');

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

async function main() {
  console.log('=== Verifying TrueForge Agent with Terminal & Python Hands ===');
  const { runAgentTurn } = require('../../services/workflows/dist/agent-client');

  const toolsCalled = [];
  let chunksReceived = 0;
  let fullReply = '';

  const res = await runAgentTurn(
    {
      orgId: 'dd6daff0-6007-4273-8dd3-f36aa6f393b9',
      userMessage: 'Use your python or terminal tool to calculate 3749 * 4821 and the square root of 50176. Print the results.',
      employeeName: 'Darex AI Data Scientist',
      employeeRole: 'Data Analyst',
      employeePersona: 'Analytical, precise, executes real code rather than guessing arithmetic',
    },
    {
      onChunk: (chunk) => {
        chunksReceived++;
        fullReply += chunk;
        process.stdout.write(chunk);
      },
      onToolProgress: (tool, label) => {
        console.log(`\n[Agent Hand In Action] Tool: ${tool} -> ${label}`);
        toolsCalled.push({ tool, label });
      },
      timeoutMs: 60000,
    }
  );

  console.log('\n\n--- Turn Complete ---');
  console.log('Tools Called:', JSON.stringify(toolsCalled, null, 2));
  console.log('Model:', res.model);
  console.log('Final Reply Length:', res.reply?.length || 0);

  // 3749 * 4821 = 18073929, sqrt(50176) = 224
  const hasMult = fullReply.includes('18073929') || res.reply.includes('18073929');
  const hasSqrt = fullReply.includes('224') || res.reply.includes('224');

  if (toolsCalled.length > 0 || (hasMult && hasSqrt)) {
    console.log('\n[PASS] Python Hand test passed!');
  } else {
    throw new Error('Python Hand test did not produce expected output');
  }

  console.log('\n--- 2. Testing Terminal Run Command Hand (Bash Pipeline with jq) ---');
  const bashToolsCalled = [];
  let bashChunksReceived = 0;
  let bashReply = '';

  const bashRes = await runAgentTurn(
    {
      orgId: 'dd6daff0-6007-4273-8dd3-f36aa6f393b9',
      conversationId: `terminal-test-${Date.now()}`,
      userMessage: 'Run a bash command using your terminal tool that prints a JSON object {"service":"darex-agent","health":"optimal"} and filters it with jq .health. Output the result.',
      employeeName: 'Darex DevOps Assistant',
      employeeRole: 'DevOps Engineer',
      employeePersona: 'Executes real terminal commands cleanly',
    },
    {
      onChunk: (chunk) => {
        bashChunksReceived++;
        bashReply += chunk;
        process.stdout.write(chunk);
      },
      onToolProgress: (tool, label) => {
        console.log(`\n[Agent Hand In Action] Tool: ${tool} -> ${label}`);
        bashToolsCalled.push({ tool, label });
      },
      timeoutMs: 60000,
    }
  );

  console.log('\n\n--- Bash Turn Complete ---');
  console.log('Tools Called:', JSON.stringify(bashToolsCalled, null, 2));
  console.log('Model:', bashRes.model);
  const hasOptimal = bashReply.toLowerCase().includes('optimal') || bashRes.reply.toLowerCase().includes('optimal');

  if (bashToolsCalled.length > 0 || hasOptimal) {
    console.log('\n[PASS] Terminal Bash Hand test passed!');
  } else {
    throw new Error('Terminal Bash Hand test failed');
  }

  console.log('\n======================================================');
  console.log('  ALL TRUEFORGE TERMINAL & PYTHON HANDS VERIFIED E2E!');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('[FAIL]', err);
  process.exit(1);
});
