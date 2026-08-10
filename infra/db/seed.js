#!/usr/bin/env node
/**
 * Darex DB Seeder
 * Clean seeder script. No fake data inserted.
 * Usage: node infra/db/seed.js
 */

let Client;
try {
  Client = require('pg').Client;
} catch (e) {
  Client = require(require('path').join(__dirname, '../../apps/dashboard/node_modules/pg')).Client;
}

const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

async function seed() {
  await client.connect();
  console.log('✓ Connected to Postgres (No fake data inserted).');
  await client.end();
}

seed().catch(err => {
  console.error('Seeding check failed:', err);
  process.exit(1);
});
