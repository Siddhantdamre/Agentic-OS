'use strict';

/**
 * Darex I3 / H7 — two-replica SSE bus probe.
 *
 * Always: two child processes both SUBSCRIBE `org:{id}` and receive one PUBLISH.
 * That is the Redis contract two `next start` replicas rely on.
 *
 * Optional full toast path (two dashboard processes + Chatwoot inbound):
 *
 *   REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @darex/dashboard exec next start -p 3000
 *   REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @darex/dashboard exec next start -p 3001
 *   DASHBOARD_REPLICA_A=http://127.0.0.1:3000 \
 *     DASHBOARD_REPLICA_B=http://127.0.0.1:3001 \
 *     node infra/scripts/check-two-replica-sse.js
 *
 * Cookie auth is unchanged: darex_session via register/login. Org is never
 * taken from a JSON body.
 *
 * REDIS_URL must be the Nango redis (localhost:6379 / redis:6379), never
 * langfuse-redis.
 */

const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const REPLICA_A = process.env.DASHBOARD_REPLICA_A || '';
const REPLICA_B = process.env.DASHBOARD_REPLICA_B || '';
const CHATWOOT_SECRET = process.env.CHATWOOT_WEBHOOK_SECRET || 'darex-chatwoot-webhook-secret-dev';

let pass = 0;
let fail = 0;
let skip = 0;

function record(ok, label, detail) {
  if (ok) {
    console.log(`  [PASS] ${label}${detail ? ` — ${detail}` : ''}`);
    pass++;
  } else {
    console.log(`  [FAIL] ${label}${detail ? ` — ${detail}` : ''}`);
    fail++;
  }
}

function skipCheck(label, detail) {
  console.log(`  [SKIP] ${label}${detail ? ` — ${detail}` : ''}`);
  skip++;
}

function parseRedisUrl(urlString) {
  const url = new URL(urlString);
  return {
    host: url.hostname || '127.0.0.1',
    port: url.port ? Number(url.port) : 6379,
    password: decodeURIComponent(url.password || ''),
    username: decodeURIComponent(url.username || ''),
  };
}

function encodeCommand(args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const data = Buffer.from(String(arg), 'utf8');
    out += `$${data.length}\r\n${arg}\r\n`;
  }
  return out;
}

function parseResp(buf, pos) {
  const start = pos.i;
  if (pos.i >= buf.length) return undefined;
  const type = buf[pos.i];
  const headerEnd = buf.indexOf('\r\n', pos.i);
  if (headerEnd === -1) return undefined;
  const reset = () => {
    pos.i = start;
    return undefined;
  };
  if (type === 0x2b || type === 0x2d) {
    const value = buf.subarray(pos.i + 1, headerEnd).toString('utf8');
    pos.i = headerEnd + 2;
    return type === 0x2d ? { error: value } : value;
  }
  if (type === 0x3a) {
    const value = Number(buf.subarray(pos.i + 1, headerEnd).toString('ascii'));
    pos.i = headerEnd + 2;
    return value;
  }
  if (type === 0x24) {
    const len = Number(buf.subarray(pos.i + 1, headerEnd).toString('ascii'));
    if (len < 0) {
      pos.i = headerEnd + 2;
      return null;
    }
    const dataStart = headerEnd + 2;
    const dataEnd = dataStart + len;
    if (buf.length < dataEnd + 2) return reset();
    const value = buf.subarray(dataStart, dataEnd).toString('utf8');
    pos.i = dataEnd + 2;
    return value;
  }
  if (type === 0x2a) {
    const count = Number(buf.subarray(pos.i + 1, headerEnd).toString('ascii'));
    pos.i = headerEnd + 2;
    if (count < 0) return null;
    const items = [];
    for (let n = 0; n < count; n++) {
      const item = parseResp(buf, pos);
      if (item === undefined) return reset();
      items.push(item);
    }
    return items;
  }
  throw new Error(`unknown RESP type 0x${type.toString(16)}`);
}

function connectRedis() {
  const target = parseRedisUrl(REDIS_URL);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: target.host, port: target.port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`connect timeout ${target.host}:${target.port}`));
    }, 5000);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve({ socket, target });
    });
  });
}

async function redisCommand(session, args) {
  const { socket } = session;
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.off('data', onData);
      reject(new Error(`timeout waiting for ${args[0]}`));
    }, 5000);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const pos = { i: 0 };
      const value = parseResp(buf, pos);
      if (value === undefined) return;
      clearTimeout(timer);
      socket.off('data', onData);
      if (value && typeof value === 'object' && !Array.isArray(value) && value.error) {
        reject(new Error(value.error));
      } else {
        resolve(value);
      }
    };
    socket.on('data', onData);
    socket.write(encodeCommand(args));
  });
}

async function withAuth(session) {
  if (session.target.password) {
    const args = session.target.username
      ? ['AUTH', session.target.username, session.target.password]
      : ['AUTH', session.target.password];
    await redisCommand(session, args);
  }
}

function makeRequest(url, method = 'GET', body = null, cookie = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const postData = body ? JSON.stringify(body) : null;
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {}),
        ...extraHeaders,
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

function openSse(url, cookie, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Cookie: cookie || '',
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`SSE HTTP ${res.statusCode}`));
          return;
        }
        let buf = '';
        const events = [];
        const seen = { connected: false, needs_attention: null };
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          const parts = buf.split('\n\n');
          buf = parts.pop() || '';
          for (const block of parts) {
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event:')) event = line.slice(6).trim();
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            events.push({ event, data });
            if (event === 'connected') seen.connected = true;
            if (event === 'needs_attention') seen.needs_attention = data;
          }
        });
        resolve({ req, res, events, seen, close: () => { req.destroy(); res.destroy(); } });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('SSE timeout')));
    req.end();
  });
}

function waitUntil(predicate, timeoutMs, label) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`timed out waiting for ${label}`));
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

function chatwootSignature(body) {
  const sig = crypto.createHmac('sha256', CHATWOOT_SECRET).update(JSON.stringify(body)).digest('hex');
  return { 'x-chatwoot-signature': `sha256=${sig}` };
}

async function obtainSessionCookie(baseUrl) {
  const testEmail = `sse_probe_${Date.now()}@example.com`;
  const testPassword = 'DarexCheck123!';
  let res = await makeRequest(`${baseUrl}/api/auth/register`, 'POST', {
    email: testEmail,
    password: testPassword,
  });
  if (res.statusCode !== 200 || res.body.status !== 'OK') {
    res = await makeRequest(`${baseUrl}/api/auth/login`, 'POST', {
      email: testEmail,
      password: testPassword,
    });
  }
  if (res.statusCode !== 200 || res.body.status !== 'OK') {
    throw new Error(`auth failed HTTP ${res.statusCode}: ${JSON.stringify(res.body)}`);
  }
  const setCookie = (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  if (!setCookie) throw new Error('no session cookie');
  return setCookie;
}

async function runSubscriberChild() {
  const channel = process.argv[3];
  const session = await connectRedis();
  await withAuth(session);
  const { socket } = session;
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length > 0) {
      const pos = { i: 0 };
      const value = parseResp(buf, pos);
      if (value === undefined) break;
      buf = buf.subarray(pos.i);
      if (Array.isArray(value) && value[0] === 'subscribe') {
        process.stdout.write('READY\n');
      }
      if (Array.isArray(value) && value[0] === 'message') {
        process.stdout.write(`MSG ${value[2]}\n`);
        socket.end();
        process.exit(0);
      }
    }
  });
  socket.write(encodeCommand(['SUBSCRIBE', channel]));
  setTimeout(() => {
    console.error('subscriber timeout');
    process.exit(2);
  }, 8000);
}

function spawnSubscriber(channel) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--sub', channel], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let out = '';
    let err = '';
    let ready = false;
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      if (!ready && out.includes('READY')) {
        ready = true;
        resolve({
          child,
          waitMessage: () =>
            new Promise((res, rej) => {
              const start = Date.now();
              const tick = () => {
                const match = out.match(/^MSG (.+)$/m);
                if (match) return res(match[1]);
                if (Date.now() - start > 5000) return rej(new Error('child did not receive PUBLISH'));
                setTimeout(tick, 25);
              };
              tick();
            }),
        });
      }
    });
    child.stderr.on('data', (chunk) => {
      err += chunk.toString('utf8');
    });
    child.on('exit', (code) => {
      if (!ready) reject(new Error(`subscriber exited ${code}: ${err || out}`));
    });
  });
}

async function runReplicaToastCheck() {
  console.log('\n--- 4. Two dashboard replicas SSE + Chatwoot inbound ---');
  if (!REPLICA_A || !REPLICA_B) {
    skipCheck(
      'two next start toast path',
      'set DASHBOARD_REPLICA_A and DASHBOARD_REPLICA_B (see script header)'
    );
    return;
  }

  let cookie;
  try {
    cookie = await obtainSessionCookie(REPLICA_A);
  } catch (err) {
    record(false, 'session cookie on replica A', err.message);
    return;
  }
  record(cookie.includes('darex_session'), 'darex_session cookie issued');

  try {
    const unauth = await new Promise((resolve, reject) => {
      const parsed = new URL(`${REPLICA_A}/api/stream/events`);
      const req = http.request(
        {
          hostname: parsed.hostname,
          port: parsed.port,
          path: parsed.pathname,
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', reject);
      req.end();
    });
    record(unauth === 401, 'SSE without cookie is 401', `HTTP ${unauth}`);
  } catch (err) {
    record(false, 'SSE without cookie is 401', err.message);
  }

  let sseA;
  let sseB;
  try {
    sseA = await openSse(`${REPLICA_A}/api/stream/events`, cookie, 15000);
    sseB = await openSse(`${REPLICA_B}/api/stream/events`, cookie, 15000);
    await waitUntil(() => sseA.seen.connected && sseB.seen.connected, 5000, 'both SSE connected');
    record(true, 'both replicas sent event: connected');
  } catch (err) {
    record(false, 'both replicas open SSE', err.message);
    sseA?.close();
    sseB?.close();
    return;
  }

  const orgIdFromCookie = cookie.match(/darex_org_id=([^;]+)/)?.[1] || '';
  const webhookUrl = `${REPLICA_A}/api/webhooks/chatwoot${orgIdFromCookie ? `?org_id=${orgIdFromCookie}` : ''}`;
  const payload = {
    event: 'message_created',
    channel_type: 'whatsapp',
    chatwoot_conv_id: Math.floor(100000 + Math.random() * 900000),
    contact_id: '+14155551212',
    sender_name: 'Two Replica Probe',
    content: 'needs_attention should toast on both replicas',
  };

  try {
    const webhookRes = await makeRequest(webhookUrl, 'POST', payload, null, chatwootSignature(payload));
    record(
      webhookRes.statusCode === 200 && webhookRes.body.success,
      'Chatwoot inbound accepted',
      `HTTP ${webhookRes.statusCode}`
    );
  } catch (err) {
    record(false, 'Chatwoot inbound accepted', err.message);
  }

  try {
    await waitUntil(
      () => sseA.seen.needs_attention && sseB.seen.needs_attention,
      8000,
      'needs_attention on both replicas'
    );
    record(true, 'replica A received needs_attention');
    record(true, 'replica B received needs_attention');
  } catch (err) {
    record(!!sseA.seen.needs_attention, 'replica A received needs_attention', err.message);
    record(!!sseB.seen.needs_attention, 'replica B received needs_attention', err.message);
  } finally {
    sseA.close();
    sseB.close();
  }
}

async function main() {
  console.log('\n=== Darex I3/H7 — Two-replica SSE (Redis org:{id} bus) ===\n');

  console.log('--- 1. REDIS_URL must be Nango redis, not langfuse-redis ---');
  if (/langfuse-redis/i.test(REDIS_URL)) {
    record(false, 'REDIS_URL is not langfuse-redis', REDIS_URL);
  } else {
    record(true, 'REDIS_URL is not langfuse-redis', REDIS_URL);
  }

  console.log('\n--- 2. Redis PING ---');
  let session;
  try {
    session = await connectRedis();
    await withAuth(session);
    const pong = await redisCommand(session, ['PING']);
    record(String(pong).toUpperCase() === 'PONG', 'PING', String(pong));
  } catch (err) {
    record(false, 'PING', err.message);
    if (/NOAUTH|WRONGPASS/i.test(err.message)) {
      console.log('\nRedis requires AUTH. Set REDIS_URL to the Nango `redis` service (redis://redis:6379 in compose, redis://127.0.0.1:6379 on the host). Never langfuse-redis.\n');
    } else {
      console.log('\nRedis is down. Start the Nango redis service (`pnpm infra:up`) and retry.\n');
    }
    process.exit(1);
  }

  console.log('\n--- 3. Two processes both receive PUBLISH on org:{id} ---');
  const orgId = crypto.randomUUID();
  const channel = `org:${orgId}`;
  record(channel.startsWith('org:'), 'topic includes org id', channel);

  let subA;
  let subB;
  try {
    subA = await spawnSubscriber(channel);
    subB = await spawnSubscriber(channel);
    const payload = JSON.stringify({
      type: 'needs_attention',
      orgId,
      conversationId: crypto.randomUUID(),
      message: 'two-replica probe',
      ts: Date.now(),
    });
    const receivers = await redisCommand(session, ['PUBLISH', channel, payload]);
    record(typeof receivers === 'number' && receivers >= 2, 'PUBLISH reached ≥2 subscribers', `n=${receivers}`);
    const msgA = await subA.waitMessage();
    const msgB = await subB.waitMessage();
    record(msgA.includes(orgId) && msgA.includes('needs_attention'), 'process A received payload');
    record(msgB.includes(orgId) && msgB.includes('needs_attention'), 'process B received payload');
  } catch (err) {
    record(false, 'two subscriber processes', err.message);
  } finally {
    subA?.child.kill();
    subB?.child.kill();
    session.socket.end();
  }

  await runReplicaToastCheck();

  console.log('\n--- Summary ---');
  const total = pass + fail;
  if (fail === 0) {
    console.log(`  ALL CHECKS PASSED (${pass}/${total}${skip ? `, ${skip} skipped` : ''})\n`);
    process.exit(0);
  }
  console.log(`  ${fail}/${total} CHECKS FAILED${skip ? ` (${skip} skipped)` : ''}\n`);
  process.exit(1);
}

if (process.argv[2] === '--sub') {
  runSubscriberChild().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  main().catch((err) => {
    console.error('two-replica SSE probe error:', err);
    process.exit(1);
  });
}
