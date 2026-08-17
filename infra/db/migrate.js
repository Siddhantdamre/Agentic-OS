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

const client = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

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

  await createMigrationsTable();
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
    await client.query(sql);
    await client.query('INSERT INTO _migrations(filename) VALUES($1)', [file]);
    ran++;
    console.log(`  ✓ ${file} applied`);
  }

  if (ran === 0) {
    console.log('✓ All migrations already applied — nothing to do.');
  } else {
    console.log(`✓ Applied ${ran} migration(s).`);
  }

  await client.end();
}

runMigrations().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
