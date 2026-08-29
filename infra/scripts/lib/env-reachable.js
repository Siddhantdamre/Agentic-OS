'use strict';
/**
 * IS THE MACHINE EVEN UP?
 *
 * WHY THIS EXISTS
 * Docker Desktop on the development host fell over twice in one session, and
 * both times the port forward to Postgres died while `docker ps` still
 * reported every container healthy. Every docker-dependent suite then failed
 * with "connect ECONNREFUSED 127.0.0.1:5432", and verify.js announced:
 *
 *     NOT SOUND — 16 of 27 suites failed.
 *
 * That sentence is false, and it is the most damaging kind of false, because
 * it accuses the code. Sixteen suites did not fail; they never ran.
 *
 * The same cause on a single suite is what "the flaky check-learning-e2e"
 * actually was. Measured: 12 of 12 runs passed against a healthy stack, and
 * 12 of 12 died with ECONNREFUSED against a broken one. There was no race to
 * find, and two sessions were spent looking for one — because the runner
 * reported a dead environment in the same words it uses for broken code.
 *
 * So the environment is checked BEFORE anything is judged. A verifier must be
 * able to say "I could not check"; otherwise every outage looks like a
 * regression and every regression is dismissed as an outage.
 */
const net = require('net');

/** Plain TCP: is anything actually accepting on the database port? */
function tcpReachable(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    sock.connect(port, host);
  });
}

/**
 * Returns { ok, why }. `why` is written for a human at a terminal who needs to
 * know whether to debug their code or restart their machine.
 */
async function environmentReachable(opts = {}) {
  const host = opts.dbHost || process.env.DB_HOST || '127.0.0.1';
  const port = parseInt(opts.dbPort || process.env.DB_PORT || '5432', 10);

  if (!(await tcpReachable(host, port))) {
    return {
      ok: false,
      why: `nothing is accepting connections on ${host}:${port} (Postgres)`,
    };
  }

  const base = opts.dashboardUrl || process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
  try {
    // Any HTTP answer proves the app is listening. Whether it reports itself
    // HEALTHY is a suite's job to judge, not this gate's — this gate only
    // distinguishes "unreachable" from "reachable and possibly wrong".
    await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(10000) });
  } catch (e) {
    return { ok: false, why: `the dashboard at ${base} is unreachable (${e.message})` };
  }

  return { ok: true };
}

module.exports = { environmentReachable, tcpReachable };

// ── CLI: --check ────────────────────────────────────────────────────────────
// Run as a child process by verify.js. It is a separate process precisely so
// verify.js can stay CommonJS: an inline `await` at the top level of a .js file
// makes Node reparse it as an ES module and every require() in it explodes.
// `node --check` does NOT catch that -- it reported the file as valid syntax --
// so the only honest gate is loading or running the file.
// Exit 0 = reachable, 2 = unreachable.
if (require.main === module && process.argv.includes('--check')) {
  environmentReachable().then((r) => {
    if (r.ok) { console.log('  [PASS] environment reachable'); process.exit(0); }
    console.log(r.why);
    process.exit(2);
  });
}

// ── Self-test ───────────────────────────────────────────────────────────────
if (require.main === module && process.argv.includes('--self-test')) {
  (async () => {
    let pass = 0;
    let fail = 0;
    const t = (name, cond, detail = '') => {
      if (cond) { pass++; console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`); }
      else { fail++; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
    };

    console.log('\n=== ENVIRONMENT REACHABILITY — SELF TEST ===\n');

    // A port nothing listens on must be reported unreachable, promptly.
    const started = Date.now();
    const dead = await tcpReachable('127.0.0.1', 1, 2000);
    t('a closed port is unreachable', dead === false, 'port 1');
    t('and it gives up quickly', Date.now() - started < 6000,
      `${Date.now() - started}ms — a hung probe is its own outage`);

    // An unroutable address must time out rather than hang forever.
    const t2 = Date.now();
    const blackhole = await tcpReachable('192.0.2.1', 9, 2000);
    t('an unroutable host times out', blackhole === false,
      `${Date.now() - t2}ms (TEST-NET-1, RFC 5737)`);

    // A bad dashboard URL must be reported as unreachable, not thrown.
    const res = await environmentReachable({
      dbHost: '127.0.0.1', dbPort: 1, dashboardUrl: 'http://127.0.0.1:1',
    });
    t('a down environment reports ok:false with a reason',
      res.ok === false && /Postgres/.test(res.why), res.why);

    console.log(`\n  passed ${pass} / ${pass + fail}\n`);
    process.exit(fail ? 1 : 0);
  })();
}
