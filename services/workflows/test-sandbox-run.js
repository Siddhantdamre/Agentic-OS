const { SandboxClient } = require('./node_modules/@agent-infra/sandbox/dist/cjs/index.js');

async function main() {
  const sandbox = new SandboxClient({ environment: 'http://127.0.0.1:8080' });
  console.log('Connected to sandbox at http://127.0.0.1:8080');

  // Test 1: Python code execution
  console.log('\n--- Test 1: Python ---');
  const pyResult = await sandbox.code.executeCode({
    language: 'python',
    code: [
      'print("Hello from sandbox!")',
      'import math',
      'print("pi =", math.pi)',
      'print("2^10 =", 2**10)',
    ].join('\n'),
  });
  console.log('Python result:', JSON.stringify(pyResult, null, 2));

  // Test 2: JavaScript code execution
  console.log('\n--- Test 2: JavaScript ---');
  const jsResult = await sandbox.code.executeCode({
    language: 'javascript',
    code: [
      'console.log("Hello from JS sandbox!");',
      'console.log("Sum 1..100 =", Array.from({length:100},(_,i)=>i+1).reduce((a,b)=>a+b,0));',
    ].join('\n'),
  });
  console.log('JS result:', JSON.stringify(jsResult, null, 2));

  // Test 3: Bash
  console.log('\n--- Test 3: Bash ---');
  const bashResult = await sandbox.bash.exec({ command: 'echo "Sandbox host: $(hostname)" && python3 --version && node --version' });
  console.log('Bash result:', JSON.stringify(bashResult, null, 2));

  console.log('\n All sandbox tests passed!');
}

main().catch(e => {
  console.error('\n Sandbox test FAILED:', e.message);
  if (e.stack) console.error(e.stack);
  process.exit(1);
});
