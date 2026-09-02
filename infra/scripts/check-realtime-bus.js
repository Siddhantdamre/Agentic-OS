#!/usr/bin/env node
'use strict';
/**
 * THE PUBLISHER NEEDS THE BUS, NOT JUST THE SUBSCRIBER.
 *
 * The realtime feature was structurally dead and looked fine. The SSE route
 * worked, the dashboard subscribed correctly per org, and `publishOrgEvent`
 * was called from every activity that should announce something —
 * owner.briefing, conversation_updated, plan.step, agent activity.
 *
 * Only the DASHBOARD service had REDIS_URL. The WORKER, which runs all of those
 * activities, had none. `publishOrgEvent` begins:
 *
 *     const target = redisTarget();
 *     if (!target) return;
 *
 * so every publish was a silent no-op. Nothing errored, nothing was logged, and
 * a subscriber on the org channel received exactly nothing — for every event
 * the product claims to emit, since the bus was written.
 *
 * That silence is deliberate and correct: a dead Redis must cost the live view,
 * never the work. It is also why nobody noticed, which is what this check is
 * for.
 *
 * Asserts the shape that makes the bus functional:
 *   the worker declares REDIS_URL,
 *   it points at the same Redis the dashboard subscribes to,
 *   and neither points at langfuse-redis, where a publish reaches no subscriber
 *   and is indistinguishable from this bug.
 *
 * Usage: node infra/scripts/check-realtime-bus.js
 */
const fs = require('fs');
const path = require('path');

const COMPOSE = path.join(__dirname, '..', 'docker-compose.yml');
const ORCH = path.join(__dirname, '..', '..', 'services/workflows/src/activities/orchestration.ts');

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
console.log('║  REALTIME BUS — the publisher can actually reach the subscriber      ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝\n');

const compose = fs.readFileSync(COMPOSE, 'utf8');

/** The `environment:` block of one compose service. */
function serviceBlock(name) {
  const m = compose.match(new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z0-9_-]+:\\n|$)`));
  return m ? m[1] : '';
}

const redisUrlIn = (block) => {
  const m = block.match(/REDIS_URL[=:]\s*([^\s#]+)/);
  return m ? m[1] : null;
};

// Services that RUN ACTIVITIES and therefore publish. The dashboard subscribes;
// these are the ones that speak.
const PUBLISHERS = ['worker'];
const SUBSCRIBERS = ['dashboard'];

for (const svc of PUBLISHERS) {
  const url = redisUrlIn(serviceBlock(svc));
  url
    ? ok(`${svc} declares REDIS_URL`, url)
    : no(`${svc} declares REDIS_URL`,
      'publishOrgEvent returns silently with no Redis, so every event it emits is dropped');
}

for (const svc of SUBSCRIBERS) {
  const url = redisUrlIn(serviceBlock(svc));
  url
    ? ok(`${svc} declares REDIS_URL`, url)
    : no(`${svc} declares REDIS_URL`, 'nothing would receive the events');
}

// Publisher and subscriber must be on the SAME instance, or both work
// perfectly and never meet.
const pubUrl = redisUrlIn(serviceBlock(PUBLISHERS[0]));
const subUrl = redisUrlIn(serviceBlock(SUBSCRIBERS[0]));
if (pubUrl && subUrl) {
  pubUrl === subUrl
    ? ok('publisher and subscriber share one Redis', pubUrl)
    : no('publisher and subscriber share one Redis', `${pubUrl} vs ${subUrl} — both work, neither meets the other`);
}

for (const [svc, url] of [[PUBLISHERS[0], pubUrl], [SUBSCRIBERS[0], subUrl]]) {
  if (!url) continue;
  /langfuse-redis/i.test(url)
    ? no(`${svc} is not pointed at langfuse-redis`, 'observability instance — a publish there reaches no subscriber')
    : ok(`${svc} is not pointed at langfuse-redis`);
}

// The silent-return is intentional; assert it is still there, so nobody
// "fixes" the symptom by making a dead Redis throw and take the work with it.
const orch = fs.readFileSync(ORCH, 'utf8');
/const target = redisTarget\(\);\s*\n\s*if \(!target\) return;/.test(orch)
  ? ok('a missing Redis degrades the view, never the work', 'publishOrgEvent returns rather than throwing')
  : no('a missing Redis degrades the view, never the work',
    'if this now throws, an unreachable Redis can fail an agent run');

console.log(`\n  passed ${pass} / ${pass + fail}\n`);
process.exit(fail ? 1 : 0);
