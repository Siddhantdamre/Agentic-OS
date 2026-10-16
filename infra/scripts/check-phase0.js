const { execSync } = require('child_process');
const http = require('http');

console.log('\n=== Darex Phase 0 — Exit Criteria Check ===\n');

let pass = 0;
let fail = 0;

const containers = [
  'darex-postgres',
  'darex-temporal',
  'darex-temporal-ui',
  'darex-redis',
  'darex-nango',
  'darex-langfuse-clickhouse',
  'darex-langfuse-minio',
  'darex-langfuse-server',
  'darex-langfuse-worker',
  'darex-litellm',
  'darex-langfuse-redis',
  'darex-pgbouncer',
];

console.log('--- Container Status ---');
for (const c of containers) {
  try {
    const status = execSync(`docker inspect --format="{{.State.Status}}" ${c}`, { encoding: 'utf8' }).trim();
    if (status === 'running') {
      console.log(`  [PASS] ${c} is running`);
      pass++;
    } else {
      console.log(`  [FAIL] ${c} — state: ${status}`);
      fail++;
    }
  } catch (e) {
    console.log(`  [FAIL] ${c} — error inspecting container`);
    fail++;
  }
}

console.log('\n--- Service Health ---');

// Helper for HTTP checks
function checkHttp(name, url, expectedStatus = 200, headers = {}) {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      headers: headers
    };

    http.get(options, (res) => {
      if (res.statusCode === expectedStatus) {
        console.log(`  [PASS] ${name} (HTTP ${res.statusCode})`);
        pass++;
      } else {
        console.log(`  [FAIL] ${name} — HTTP ${res.statusCode} (expected ${expectedStatus})`);
        fail++;
      }
      resolve();
    }).on('error', (err) => {
      console.log(`  [FAIL] ${name} — ${err.message}`);
      fail++;
      resolve();
    });
  });
}

async function runHealthChecks() {
  // Postgres
  try {
    const pg = execSync('docker exec darex-postgres pg_isready -U darex -d darex', { encoding: 'utf8' });
    if (pg.includes('accepting connections')) {
      console.log('  [PASS] Postgres (pg_isready)');
      pass++;
    } else {
      console.log('  [FAIL] Postgres (pg_isready)');
      fail++;
    }
  } catch (e) {
    console.log('  [FAIL] Postgres (pg_isready)');
    fail++;
  }

  // pgvector
  try {
    const vec = execSync('docker exec darex-postgres psql -U darex -d darex -c "SELECT extname FROM pg_extension WHERE extname=\'vector\';"', { encoding: 'utf8' });
    if (vec.includes('vector')) {
      console.log('  [PASS] pgvector extension enabled');
      pass++;
    } else {
      console.log('  [FAIL] pgvector extension enabled');
      fail++;
    }
  } catch (e) {
    console.log('  [FAIL] pgvector extension enabled');
    fail++;
  }

  // Temporal
  try {
    const temp = execSync('docker exec darex-temporal temporal operator namespace list --address temporal:7233', { encoding: 'utf8' });
    if (temp.includes('default')) {
      console.log('  [PASS] Temporal (gRPC namespace list)');
      pass++;
    } else {
      console.log('  [FAIL] Temporal (gRPC namespace list)');
      fail++;
    }
  } catch (e) {
    console.log('  [FAIL] Temporal (gRPC namespace list)');
    fail++;
  }

  // Redis
  try {
    const red = execSync('docker exec darex-redis redis-cli ping', { encoding: 'utf8' });
    if (red.includes('PONG')) {
      console.log('  [PASS] Redis (PING)');
      pass++;
    } else {
      console.log('  [FAIL] Redis (PING)');
      fail++;
    }
  } catch (e) {
    console.log('  [FAIL] Redis (PING)');
    fail++;
  }

  // PgBouncer (I4) — additive. Do not skip if the container is missing.
  try {
    const pgb = execSync('docker exec darex-pgbouncer pg_isready -h 127.0.0.1 -p 5432 -U darex_app -d darex', { encoding: 'utf8' });
    if (pgb.includes('accepting connections')) {
      console.log('  [PASS] PgBouncer (pg_isready via darex_app)');
      pass++;
    } else {
      console.log('  [FAIL] PgBouncer (pg_isready via darex_app)');
      fail++;
    }
  } catch (e) {
    console.log('  [FAIL] PgBouncer (pg_isready via darex_app)');
    fail++;
  }

  // HTTP endpoints
  await checkHttp('Nango API (/health)', 'http://localhost:3003/health');
  await checkHttp('Langfuse API (/api/public/health)', 'http://localhost:3002/api/public/health');
  await checkHttp('LiteLLM Gateway (/health/readiness)', 'http://localhost:4000/health/readiness', 200, { Authorization: 'Bearer sk-darex-litellm-dev-key' });

  console.log('\n--- Summary ---');
  const total = pass + fail;
  if (fail === 0) {
    console.log(`  ALL CHECKS PASSED (${pass}/${total}) — Phase 0 exit criteria MET!\n`);
    console.log('  Services available at:');
    console.log('    Temporal UI:  http://localhost:8233');
    console.log('    Langfuse:     http://localhost:3002  (admin@darex.dev / darex_admin_dev)');
    console.log('    Nango:        http://localhost:3003');
    console.log('    LiteLLM:      http://localhost:4000  (Bearer sk-darex-litellm-dev-key)');
    console.log('    Postgres:     localhost:5432  (darex / darex_dev_secret)');
    console.log('    PgBouncer:    localhost:6432  (darex_app, session pool)');
  } else {
    console.log(`  ${fail}/${total} CHECKS FAILED — fix before proceeding to Phase 1`);
    process.exit(1);
  }
}

runHealthChecks();
