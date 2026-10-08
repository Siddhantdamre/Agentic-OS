'use strict';
// Scores the assistant on a fixed task set against a running dashboard.
//   Real model:  set the dashboard's DAREX_LOCAL_MODEL_* variables, start it, then
//                EVAL_BASE=http://127.0.0.1:3000 node run-evals.js [--threshold 0.9]
//   Stand-in:    node run-evals.js --standin   (the fake model gives one canned reply, so only the plumbing is
//                checked: every turn completes, nothing leaks. Scores from a stand-in mean nothing.)
const fs = require('fs');
const path = require('path');
const { seed, cleanup } = require('../seed');
const { grade, summarize } = require('./grade');
const tasks = require('./tasks.json');

const BASE = process.env.EVAL_BASE || 'http://127.0.0.1:3011';
const args = process.argv.slice(2);
const standin = args.includes('--standin');
const thrIdx = args.indexOf('--threshold');
const threshold = thrIdx >= 0 ? Number(args[thrIdx + 1]) : 0.9;
const only = (args.find((a) => a.startsWith('--only=')) || '').slice(7);
const OUT = process.env.EVAL_OUT || path.join(process.env.HARNESS_DIR || require('os').tmpdir(), 'eval-report.json');

async function call(s, route, body) {
  const headers = { 'content-type': 'application/json', cookie: `darex_session=${s.cookie}; darex_org_id=${s.orgId}` };
  return fetch(BASE + route, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function teach(s) {
  const listings = [['MR-101', 'Baner 2 BHK, Sai Heights', 8800000, 'Baner', 2], ['MR-102', 'Wakad 3 BHK, Green Park', 11200000, 'Wakad', 3], ['MR-103', 'Kothrud 1 BHK, Shanti Nagar', 5200000, 'Kothrud', 1], ['MR-105', 'Aundh 3 BHK, Skyline', 14500000, 'Aundh', 3]];
  for (const [sourceRef, title, price, locality, bhk] of listings) await call(s, '/api/listings', { sourceRef, title, price, locality, bhk, city: 'Pune', status: 'active' });
  for (const [title, body] of [['Pricing policy', 'We never negotiate below 3% of the listed price without the owner approval. Brokerage is 1% for buyers and 1% for sellers.'], ['Showing hours', 'Showings run Monday to Saturday, 10am to 7pm. Sundays by appointment only. Each showing is 30 minutes.']]) await call(s, '/api/brain', { action: 'create', title, body });
  for (const [contact, locality, bhk, budget_max] of [['Priya Sharma', 'Baner', 2, 9000000], ['Rahul Verma', 'Wakad', 3, 12000000], ['Anita Desai', 'Kothrud', 1, 5500000]]) await call(s, '/api/inquiries', { contact, locality, city: 'Pune', bhk, budget_max, channel: 'whatsapp', status: 'new' });
  const soon = (d, h) => new Date(Date.now() + d * 86400000 + h * 3600000).toISOString();
  for (const [d, h] of [[1, 10], [2, 15]]) await call(s, '/api/showings', { startTime: soon(d, h), durationMinutes: 30, contact: 'Priya Sharma', title: 'Showing' });
}
async function observe(s, prompt) {
  const res = await call(s, '/api/ask-ai', { prompt });
  const text = await res.text();
  const events = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const done = events.find((e) => e.type === 'done');
  const err = events.find((e) => e.type === 'error');
  const approval = events.find((e) => e.type === 'approval');
  return {
    status: res.status, error: err ? err.error : null,
    answer: String((done && done.answer) || events.filter((e) => e.type === 'chunk').map((e) => e.text).join('') || ''),
    approvals: (approval && approval.approvals) || [],
    toolEvents: events.filter((e) => e.type === 'tool').map((e) => `${e.tool} ${e.label || ''}`),
  };
}

(async () => {
  const s = seed({ stage: 1, tag: 'eval', tools: ['gmail', 'google-calendar', 'customer-ops', 'whatsapp', 'stripe'] });
  const results = []; const rows = [];
  try {
    await teach(s);
    for (const task of tasks) {
      if (only && !task.id.startsWith(only)) continue;
      const o = await observe(s, task.prompt);
      const turnOk = o.status === 200 && !o.error && !/ECONN|SQLSTATE|stack|at \w+\.\w+ \(|Nango|mcp\./.test(o.answer);
      const r = standin ? { id: task.id, category: task.category, pass: turnOk, failures: turnOk ? [] : [o.error || 'turn failed or leaked internals'] } : grade(task, o);
      if (!standin && !turnOk) { r.pass = false; r.failures.push(o.error || 'turn failed or leaked internals'); }
      results.push(r); rows.push({ ...r, prompt: task.prompt, answer: o.answer.slice(0, 400), held: o.approvals.length });
      console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${task.id} ${r.pass ? '' : '— ' + r.failures.join('; ')}`);
    }
  } finally { cleanup(s.orgId); }
  const sum = summarize(results);
  console.log(`\n${standin ? 'STAND-IN (plumbing only, not a quality score)' : 'QUALITY'}: ${sum.pass} of ${sum.total} (${Math.round(sum.rate * 100)}%)`);
  for (const [c, v] of Object.entries(sum.byCat)) console.log(`  ${c.padEnd(8)} ${v.pass}/${v.total}`);
  fs.writeFileSync(OUT, JSON.stringify({ when: new Date().toISOString(), mode: standin ? 'standin' : 'model', summary: sum, rows }, null, 1));
  console.log('report:', OUT);
  process.exit(standin || sum.rate >= threshold ? 0 : 1);
})();
