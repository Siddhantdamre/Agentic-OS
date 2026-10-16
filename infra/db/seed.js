#!/usr/bin/env node
/**
 * Darex DB Seeder
 * Applies idempotent SQL in infra/db/seeds/ (connector catalog, not fake tenant rows).
 * Usage: node infra/db/seed.js
 */

let Client;
try {
  Client = require('pg').Client;
} catch (e) {
  Client = require(require('path').join(__dirname, '../../apps/dashboard/node_modules/pg')).Client;
}

const fs = require('fs');
const path = require('path');

const SEEDS_DIR = path.join(__dirname, 'seeds');

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

async function seed() {
  await client.connect();
  console.log('✓ Connected to Postgres');

  if (!fs.existsSync(SEEDS_DIR)) {
    console.log('✓ No seeds directory — nothing to seed.');
    await client.end();
    return;
  }

  const files = fs.readdirSync(SEEDS_DIR).filter((f) => f.endsWith('.sql')).sort();
  if (files.length === 0) {
    console.log('✓ No seed files — nothing to seed.');
    await client.end();
    return;
  }

  for (const file of files) {
    const sql = fs.readFileSync(path.join(SEEDS_DIR, file), 'utf8');
    console.log(`  → applying seed ${file}...`);
    await client.query(sql);
    console.log(`  ✓ ${file} applied`);
  }

  console.log(`✓ Applied ${files.length} seed file(s).`);
  await client.end();
}

seed().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
