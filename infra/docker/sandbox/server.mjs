#!/usr/bin/env node
/**
 * Isolated code-exec HTTP server.
 * Called by services/workflows/src/tool-executor.ts POST {SANDBOX_API_URL}/execute
 * Compose: infra/docker-compose.yml service `sandbox`.
 *
 * Request:  { language: "python"|"node"|"bash", code: string, timeoutMs?: number }
 * Response: { result: { ok, stdout, stderr, exitCode, error } }
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = parseInt(process.env.SANDBOX_PORT || '8080', 10);
const MAX_CONCURRENT = parseInt(process.env.SANDBOX_MAX_CONCURRENT || '2', 10);
const DEFAULT_TIMEOUT_MS = parseInt(process.env.SANDBOX_DEFAULT_TIMEOUT_MS || '10000', 10);

let inFlight = 0;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 256 * 1024) {
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function resolveRuntime(language) {
  const lang = String(language || 'python').toLowerCase();
  switch (lang) {
    case 'python':
    case 'py':
      return { cmd: 'python3', ext: '.py' };
    case 'node':
    case 'javascript':
    case 'js':
      return { cmd: 'node', ext: '.js' };
    case 'bash':
    case 'sh':
    case 'shell':
      return { cmd: 'bash', ext: '.sh' };
    default: {
      const _exhaustive = lang;
      void _exhaustive;
      return { cmd: 'python3', ext: '.py' };
    }
  }
}

function executeCode(language, code, timeoutMs) {
  return new Promise((resolve) => {
    const runtime = resolveRuntime(language);
    const dir = mkdtempSync(join(tmpdir(), 'darex-sbx-'));
    const file = join(dir, `main${runtime.ext}`);
    writeFileSync(file, code, 'utf8');

    const child = spawn(runtime.cmd, [file], {
      cwd: dir,
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({
        ok: false,
        stdout,
        stderr,
        exitCode: 124,
        error: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8');
      if (stdout.length > 64 * 1024) stdout = stdout.slice(0, 64 * 1024);
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8');
      if (stderr.length > 64 * 1024) stderr = stderr.slice(0, 64 * 1024);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, stdout, stderr, exitCode: 1, error: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const exitCode = code ?? 1;
      finish({
        ok: exitCode === 0,
        stdout,
        stderr,
        exitCode,
        error: exitCode === 0 ? null : stderr.slice(0, 500) || `exit ${exitCode}`,
      });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    json(res, 200, { ok: true, service: 'sandbox' });
    return;
  }

  if (req.method !== 'POST' || url !== '/execute') {
    json(res, 404, { error: 'not found' });
    return;
  }

  if (inFlight >= MAX_CONCURRENT) {
    json(res, 429, { result: { ok: false, stdout: '', stderr: '', exitCode: 1, error: 'sandbox busy' } });
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { result: { ok: false, stdout: '', stderr: '', exitCode: 1, error: 'invalid json' } });
    return;
  }

  const code = typeof parsed.code === 'string' ? parsed.code : '';
  if (!code) {
    json(res, 400, { result: { ok: false, stdout: '', stderr: '', exitCode: 1, error: 'code is required' } });
    return;
  }

  const timeoutMs = Math.min(
    Math.max(parseInt(String(parsed.timeoutMs || DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS, 500),
    30_000
  );

  inFlight += 1;
  try {
    const result = await executeCode(parsed.language, code, timeoutMs);
    json(res, 200, { result });
  } finally {
    inFlight -= 1;
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[sandbox] listening on ${PORT}`);
});
