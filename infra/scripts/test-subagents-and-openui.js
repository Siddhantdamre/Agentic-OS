/**
 * Verification test for TrueForge In-Process Dynamic Subagents & OpenUI
 */
const path = require('path');
const fs = require('fs');

// Ensure root .env is loaded if running script directly
const envPath = path.join(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  if (typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  } else {
    try {
      require(path.join(__dirname, '../../services/workflows/node_modules/dotenv')).config({ path: envPath });
    } catch {}
  }
}

const { runLocalTurn } = require('../../services/workflows/dist/local-turn');

async function main() {
  console.log('=== Testing TrueForge In-Process Subagents & Generative OpenUI ===\n');

  // 1. Test Generative OpenUI
  console.log('--- Test 1: Generative OpenUI Emission ---');
  let openuiChunks = '';
  const openuiResult = await runLocalTurn(
    {
      orgId: '00000000-0000-0000-0000-000000000001',
      userMessage: 'Render an interactive summary comparing PostgreSQL vs MongoDB right now without asking any clarifying questions. Use an ```openui fenced block with root = Stack(...), Title, and Table.',
      employeeName: 'DareX Architect',
      employeeRole: 'Solutions Architect',
    },
    {
      onChunk: (chunk) => {
        openuiChunks += chunk;
      },
      timeoutMs: 60000,
    }
  );

  console.log('OpenUI Turn Result:');
  console.log('  Model:', openuiResult.model);
  console.log('  Reply length:', openuiResult.reply.length);
  const hasOpenUiBlock = openuiResult.reply.includes('```openui') || openuiResult.reply.includes('Stack(') || openuiResult.reply.includes('Table(');
  console.log('  Emitted OpenUI Block?', hasOpenUiBlock ? 'YES [PASS]' : 'NO');
  console.log('  Snippet:\n' + openuiResult.reply.slice(0, 300) + '...\n');

  // 2. Test Dynamic SubAgents
  console.log('--- Test 2: Dynamic SubAgents Execution ---');
  const subagentEvents = [];
  const toolsCalled = [];
  const subagentResult = await runLocalTurn(
    {
      orgId: '00000000-0000-0000-0000-000000000001',
      userMessage: 'You must delegate this task: use the create_sub_agent tool to create a sub-agent named "DBAnalyzer" with input "Analyze the advantages of PostgreSQL indexing", and then present its findings.',
      employeeName: 'DareX Manager',
      employeeRole: 'Engineering Manager',
    },
    {
      onSubagent: (ev) => {
        console.log(`  [Subagent Event] status: ${ev.status}, name: ${ev.name}, threadId: ${ev.threadId}`);
        subagentEvents.push(ev);
      },
      onToolProgress: (tool, label) => {
        console.log(`  [Tool Progress] ${tool}: ${label.slice(0, 60)}`);
        toolsCalled.push({ tool, label });
      },
      timeoutMs: 90000,
    }
  );

  console.log('\nSubagent Turn Result:');
  console.log('  Model:', subagentResult.model);
  console.log('  Total subagent events:', subagentEvents.length);
  console.log('  Subagents in result:', subagentResult.subagents.length);
  console.log('  Reply length:', subagentResult.reply.length);
  console.log('  Reply snippet:\n' + subagentResult.reply.slice(0, 300) + '...\n');

  console.log('==============================================');
  console.log('Verification Complete!');
  console.log('==============================================');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
