/**
 * MCP bridge launcher — merges root .env (API keys), dashboard .env.local (DB creds)
 * and infra/.env into the bridge process env, then starts the atomic-agent MCP
 * connector bridge (SSE server on port 8790).
 * Usage: node infra/scripts/bridge-launcher.js
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
loadEnvFile(path.join(root, 'services', 'connectors', '.env'));

const bridgePath = path.join(root, 'services', 'workflows', 'dist', 'mcp-bridge.js');
console.log('[bridge-launcher] Launching DareX MCP connector bridge with merged env...');
console.log('   Nango:', process.env.NANGO_HOST || 'http://localhost:3003');
console.log('   DB:', `${process.env.DB_USER || 'darex'}@${process.env.DB_HOST || '127.0.0.1'}${process.env.DB_PASSWORD ? ' (password set)' : ' (NO PASSWORD)'}`);

const child = spawn(process.execPath, [bridgePath], {
  cwd: path.join(root, 'services', 'workflows'),
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', (d) => process.stdout.write(d));
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => {
  console.log(`[bridge-launcher] bridge exited with code ${code}`);
  process.exit(code ?? 1);
});
