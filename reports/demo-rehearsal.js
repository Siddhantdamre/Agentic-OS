'use strict';
// Scripted demo rehearsal against the running stand-in stack (run via run-flows.sh with HARNESS_SCRIPT).
// Journey: owner asks a question -> a send is held -> owner approves -> exactly one send, audited -> duplicate approve refused
// -> a second send hits a failing provider -> reported as failed, not sent -> another workspace sees none of it.
// Model and Gmail are LOCAL SIMULATORS (fake-world.js); nothing leaves the machine.
const fs = require('fs'), os = require('os'), path = require('path');
const { spawnSync } = require('child_process');
const { seed, cleanup, psql } = require('../infra/harness/seed');
const BASE = process.env.FLOW_BASE || 'http://127.0.0.1:3011';
const WORK = process.env.HARNESS_DIR || path.join(os.tmpdir(), 'darex-harness');
const LOG = path.join(WORK, 'world.log'), SCEN = path.join(WORK, 'scenario.json');
const ROOT = path.resolve(__dirname, '..');
const runs = Number(process.argv[2] || 3);
const headers = (s) => ({ 'content-type': 'application/json', cookie: `darex_session=${s.cookie}; darex_org_id=${s.orgId}` });
const reset = (sc = {}) => { fs.writeFileSync(LOG, ''); fs.writeFileSync(SCEN, JSON.stringify(sc)); };
const sends = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.kind === 'provider' && /messages\/send/.test(e.url));
const count = (q) => Number(psql(q));
function hold(s, body) {
  const code = `require(${JSON.stringify(path.join(ROOT, 'services/workflows/dist/tool-executor.js'))}).executeAutonomousToolAction({tool:'gmail',action:'send_email',payload:${JSON.stringify({ to: 'priya@example.test', subject: 'Your viewing', body })},orgId:${JSON.stringify(s.orgId)},employeeId:${JSON.stringify(s.employeeId)},source:'plan'}).then(r=>{console.log(JSON.stringify({status:r.status,id:r.approval&&r.approval.pendingActionId}));process.exit(0)},e=>{console.error(e);process.exit(1)})`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: process.env });
  const out = JSON.parse(r.stdout.trim().split('\n').pop()); return out;
}
const decide = async (s, id, status) => { const res = await fetch(`${BASE}/api/decisions`, { method: 'PATCH', headers: headers(s), body: JSON.stringify({ id, status }) }); let b = null; try { b = await res.json(); } catch {} return { status: res.status, body: b }; };

(async () => {
  const summary = [];
  for (let i = 1; i <= runs; i++) {
    const t0 = Date.now(); const checks = []; const ck = (n, ok, d = '') => checks.push({ n, ok: !!ok, d });
    const s = seed({ stage: 1, tag: `demo${i}` }), other = seed({ stage: 1, tag: `demoB${i}` }); reset();
    try {
      // 1. grounded question through the real chat endpoint
      reset({ reply: 'You have one email waiting for your approval.' });
      const ask = await fetch(`${BASE}/api/ask-ai`, { method: 'POST', headers: headers(s), body: JSON.stringify({ prompt: 'What needs me today?' }) });
      const askText = await ask.text(); ck('chat answers (200, a done event)', ask.status === 200 && /"type":"done"/.test(askText), askText.slice(0, 120));
      // 2. consequential action is held
      reset(); const h = hold(s, 'Confirmed for 5pm tomorrow'); ck('the send is held for approval', h.status === 'pending_approval' && !!h.id);
      ck('nothing has been sent yet', sends().length === 0);
      // 3. approve the exact action
      reset(); const d = await decide(s, h.id, 'approved');
      ck('approval reports success', d.status === 200 && d.body && d.body.status === 'executed', JSON.stringify(d).slice(0, 140));
      const sent = sends(); ck('exactly one send reached the (simulated) provider', sent.length === 1, `sends=${sent.length}`);
      ck('row is executed', psql(`SELECT status FROM agent_pending_actions WHERE id='${h.id}'`) === 'executed');
      ck('audit has approved + approved_and_executed', count(`SELECT count(*) FROM audit_events WHERE org_id='${s.orgId}' AND kind IN ('decision.approved','decision.approved_and_executed')`) === 2);
      // 4. duplicate approval refused, no second send
      const again = await decide(s, h.id, 'approved'); ck('approving again is refused (409) and sends nothing more', again.status === 409 && sends().length === 1, `${again.status} sends=${sends().length}`);
      // 5. injected provider failure: truthful report, no false success
      const h2 = hold(s, 'Second email'); reset({ providerStatus: { 'gmail.googleapis.com': 500 } });
      const d2 = await decide(s, h2.id, 'approved');
      ck('a failing provider is reported as a failure, not success', d2.body && d2.body.success !== true && d2.body.status !== 'executed', JSON.stringify(d2).slice(0, 160));
      ck('row says execution_failed, not executed', psql(`SELECT status FROM agent_pending_actions WHERE id='${h2.id}'`) === 'execution_failed');
      ck('no raw provider text shown', !/scripted failure|googleapis|ECONN/i.test(JSON.stringify(d2)));
      // 6. isolation: another workspace cannot approve or see this one's rows
      const h3 = hold(s, 'Third email'); reset();
      const x = await decide(other, h3.id, 'approved'); ck('another workspace cannot approve it', x.status >= 400 && sends().length === 0, `${x.status}`);
      const listRes = await fetch(`${BASE}/api/decisions`, { headers: headers(other) }); const listBody = await listRes.text(); ck('another workspace does not see it', !listBody.includes(h3.id));
      ck('no stuck pending row other than the deliberately held third', count(`SELECT count(*) FROM agent_pending_actions WHERE org_id='${s.orgId}' AND status='pending'`) === 1);
    } catch (e) { ck('run completed without an exception', false, String(e.message).slice(0, 160)); }
    finally { cleanup(s.orgId); cleanup(other.orgId); }
    const failed = checks.filter((c) => !c.ok); const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`RUN ${i}: ${checks.length - failed.length}/${checks.length} checks passed in ${secs}s`);
    for (const c of checks) console.log(`   [${c.ok ? 'PASS' : 'FAIL'}] ${c.n}${c.ok ? '' : ' — ' + c.d}`);
    summary.push({ run: i, passed: checks.length - failed.length, total: checks.length, seconds: Number(secs) });
  }
  console.log('\nSUMMARY ' + JSON.stringify(summary));
  process.exit(summary.every((r) => r.passed === r.total) ? 0 : 1);
})();
