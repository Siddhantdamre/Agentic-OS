#!/usr/bin/env node
/**
 * Darex DB Migration Runner
 * Runs all SQL migrations in infra/db/migrations/ in order.
 * Usage: node infra/db/migrate.js
 */

let Client;
try {
  Client = require('pg').Client;
} catch (e) {
  Client = require(require('path').join(__dirname, '../../apps/dashboard/node_modules/pg')).Client;
}

const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function dbConfig() {
  const isProd = process.env.NODE_ENV === 'production';
  const user = process.env.DB_USER;
  const password = process.env.DB_PASSWORD;
  if (isProd && (!user || !password)) {
    throw new Error('DB_USER and DB_PASSWORD must be set in production (no dev fallbacks)');
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: user || 'darex',
    password: password || 'darex_dev_secret',
    database: process.env.DB_NAME || 'darex',
  };
}

const client = new Client(dbConfig());

async function createMigrationsTable() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL UNIQUE,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations() {
  const result = await client.query('SELECT filename FROM _migrations ORDER BY id');
  return new Set(result.rows.map(r => r.filename));
}

async function runMigrations() {
  await client.connect();
  console.log('✓ Connected to Postgres');

  // Advisory lock so concurrent setup.sh + start.sh can't half-apply.
  await client.query(`SELECT pg_advisory_lock(987654321)`);

  try {
    await createMigrationsTable();
    // Tenants must never see or forge migration history.
    await client.query(`REVOKE ALL ON _migrations FROM PUBLIC, darex_app`);
    const applied = await getAppliedMigrations();

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      console.log(`  → applying ${file}...`);
      // Per-file transaction: DDL + _migrations insert commit atomically,
      // so a failed seed can't leave half-applied DDL behind.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations(filename) VALUES($1)', [file]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      }
      ran++;
      console.log(`  ✓ ${file} applied`);
    }

    if (ran === 0) {
      console.log('✓ All migrations already applied — nothing to do.');
    } else {
      console.log(`✓ Applied ${ran} migration(s).`);
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(987654321)`).catch(() => {});
    await client.end();
  }
}

runMigrations().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
