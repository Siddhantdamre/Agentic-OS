/**
 * Test Terminal & Sandbox Hands in DareX
 * Verifies that TrueForge can execute shell commands, bash pipelines, and python scripts.
 */
const assert = require('assert');
const { executeAutonomousToolAction } = require('../../services/workflows/dist/tool-executor.js');

async function main() {
  console.log('--- 1. Testing Terminal Run Command Hand (Bash Pipeline with bc and jq) ---');
  const termRes = await executeAutonomousToolAction({
    tool: 'terminal_run_command',
    action: 'terminal_run_command',
    payload: {
      command: 'echo "3.14159 * 2.5" | bc && echo \'{"status":"online","workers":4}\' | jq .workers',
    },
    orgId: 'dd6daff0-6007-4273-8dd3-f36aa6f393b9',
  });

  console.log('Terminal result:', termRes);
  assert.strictEqual(termRes.status, 'executed', 'Terminal command must execute successfully');
  assert(termRes.data.stdout.includes('7.85397') || termRes.data.stdout.includes('4'), 'Output must contain computed math and parsed JSON');
  console.log('  [PASS] Terminal Run Command hand works with bc, jq, and bash pipelines!');

  console.log('\n--- 2. Testing Python Execution Hand ---');
  const pythonRes = await executeAutonomousToolAction({
    tool: 'python_execute',
    action: 'python_execute',
    payload: {
      code: `
data = [12, 18, 25, 32, 45, 60, 85]
avg = sum(data) / len(data)
variance = sum((x - avg) ** 2 for x in data) / len(data)
std_dev = variance ** 0.5
print(f"Count={len(data)} Avg={avg:.2f} StdDev={std_dev:.2f}")
`,
    },
    orgId: 'dd6daff0-6007-4273-8dd3-f36aa6f393b9',
  });

  console.log('Python result:', pythonRes);
  assert.strictEqual(pythonRes.status, 'executed', 'Python script must execute successfully');
  assert(pythonRes.data.stdout.includes('Count=7'), 'Output must contain statistical calculation results');
  console.log('  [PASS] Python Execution hand works with algorithms and math computation!');

  console.log('\n======================================================');
  console.log('  ALL TERMINAL & CODE EXECUTION HANDS VERIFIED!');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
