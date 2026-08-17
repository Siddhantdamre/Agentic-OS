/**
 * Worker launcher — merges root .env (API keys), dashboard .env.local (DB creds)
 * and infra/.env into the worker process env, then starts the Temporal worker.
 * Usage: node infra/scripts/worker-launcher.js
 */
// NOTE: 127.0.0.1, never 'localhost'. Node resolves localhost to IPv6 ::1 first;
// Docker publishes on [::] but that path resets the connection, producing
// intermittent ECONNRESET / "fetch failed" that looks like random flakiness.
// curl hides this by falling back to IPv4 — Node's fetch and pg do not.
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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

const workerPath = path.join(root, 'services', 'workflows', 'dist', 'worker.js');
console.log('🚀 Launching DareX Temporal Worker with merged env...');
console.log('   API keys present:', ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY']
  .filter((k) => process.env[k]).join(', ') || 'NONE');
console.log(`   Atomic agent: ${process.env.ATOMIC_AGENT_URL || 'http://localhost:8787'} (api-key ${process.env.ATOMIC_AGENT_API_KEY ? 'set' : 'dev default'})`);
console.log(`   DB: ${process.env.DB_USER || 'darex'}@${process.env.DB_HOST || '127.0.0.1'}:${process.env.DB_PORT || '5432'}/${process.env.DB_NAME || 'darex'}${process.env.DB_PASSWORD ? ' (password set)' : ' (NO PASSWORD)'}`);

const child = spawn(process.execPath, [workerPath], {
  cwd: path.join(root, 'services', 'workflows'),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => {
  console.log(`[worker-launcher] worker exited with code ${code}`);
  process.exit(code ?? 1);
});
