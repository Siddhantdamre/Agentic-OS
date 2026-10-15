'use strict';
// Opens the demo: seeds the demo business, prints how to sign in, and keeps the stand-in servers (started by
// run-flows.sh) alive until you press Ctrl-C, then removes the demo workspace.
//   HARNESS_SCRIPT=demo.js infra/harness/run-flows.sh
const { seedDemo, cleanup } = require('./demo-seed');

const BASE = process.env.FLOW_BASE || 'http://127.0.0.1:3011';

(async () => {
  const d = await seedDemo({ base: BASE });
  console.log('\n==== DEMO READY ====');
  console.log(`Open   ${BASE}/login`);
  console.log(`Email  ${d.email}`);
  console.log(`Pass   ${d.password}`);
  console.log('Everything here is fake and local: the model is a scripted stand-in and no real email or message is sent.');
  console.log('Press Ctrl-C to stop and remove the demo workspace.\n');
  const stop = () => { try { cleanup(d.orgId); } catch { /* already gone */ } process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  setInterval(() => {}, 1 << 30);
})();
