#!/usr/bin/env node
/**
 * Encrypts Razorpay key secrets that were saved as plaintext in channels.meta
 * before token encryption existed. Safe to re-run: sealed values are skipped.
 *
 *   CHANNEL_SECRETS_KEY=<64 hex> DB_HOST=... DB_USER=darex DB_PASSWORD=... \
 *     node infra/scripts/seal-razorpay-secrets.js [--dry-run]
 *
 * Connect as the superuser (darex): the app role is bound by row security to
 * one org at a time. Requires `pnpm build` so the gateway dist exists.
 */
const path = require('path');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '../..');
const { Client } = createRequire(path.join(root, 'apps/dashboard/package.json'))('pg');
const { isSealed, sealSecret, secretHint, secretsKeyConfigured } = require(path.join(root, 'packages/whatsapp-gateway/dist'));

const dry = process.argv.includes('--dry-run');

(async () => {
  if (!secretsKeyConfigured()) {
    console.error('CHANNEL_SECRETS_KEY is not set (64 hex chars). Nothing done.');
    process.exit(1);
  }
  const db = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || 'darex',
    password: process.env.DB_PASSWORD || process.env.SUPERUSER_DB_PASSWORD || 'darex_dev_secret',
    database: process.env.DB_NAME || 'darex',
  });
  await db.connect();
  try {
    const { rows } = await db.query(
      `SELECT id, org_id, meta FROM channels WHERE channel_type = 'razorpay' AND (meta ? 'keySecret' OR meta ? 'key_secret')`
    );
    let sealed = 0;
    let skipped = 0;
    for (const row of rows) {
      const plain = [row.meta.keySecret, row.meta.key_secret].find((v) => typeof v === 'string' && v && !isSealed(v));
      if (!plain) {
        skipped += 1;
        continue;
      }
      if (!dry) {
        const box = sealSecret(plain);
        await db.query(
          `UPDATE channels SET meta = meta || jsonb_build_object('keySecret', $2::text, 'key_secret', $2::text, 'secret_hint', $3::text) WHERE id = $1`,
          [row.id, box, secretHint(plain)]
        );
      }
      sealed += 1;
      console.log(`${dry ? 'would seal' : 'sealed'} org ${row.org_id}`);
    }
    console.log(`${dry ? 'dry run: ' : ''}${sealed} sealed, ${skipped} already sealed, ${rows.length} razorpay channels with secrets`);
  } finally {
    await db.end();
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
