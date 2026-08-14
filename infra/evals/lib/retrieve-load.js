'use strict';

/**
 * Load compiled retrieveMemory for evals. Never hits Ask AI.
 * Sets darex_app credentials before require so the workflows pg Pool binds
 * the least-privilege role, then restores the caller env.
 */

const fs = require('fs');
const path = require('path');

const RETRIEVE_DIST = path.join(__dirname, '../../../services/workflows/dist/memory/retrieve.js');
const SHARED_DIST = path.join(__dirname, '../../../services/workflows/dist/tools/shared.js');

let cached = null;

function loadRetrieveModule() {
  if (cached) return cached;
  if (!fs.existsSync(RETRIEVE_DIST)) {
    throw new Error(
      'compiled retrieveMemory missing — run pnpm --filter @darex/workflows exec tsc (emit dist/memory/retrieve.js). Broken retrieve must fail this golden, not skip.',
    );
  }

  const savedUser = process.env.DB_USER;
  const savedPassword = process.env.DB_PASSWORD;
  process.env.DB_HOST = process.env.DB_HOST || 'localhost';
  process.env.DB_PORT = process.env.DB_PORT || '5432';
  process.env.DB_NAME = process.env.DB_NAME || 'darex';
  process.env.DB_USER = process.env.APP_DB_USER || 'darex_app';
  process.env.DB_PASSWORD = process.env.APP_DB_PASSWORD || 'darex_app_dev_secret';

  for (const p of [SHARED_DIST, RETRIEVE_DIST]) {
    try {
      delete require.cache[require.resolve(p)];
    } catch {
      // not yet loaded
    }
  }

  const mod = require(RETRIEVE_DIST);
  if (savedUser === undefined) delete process.env.DB_USER;
  else process.env.DB_USER = savedUser;
  if (savedPassword === undefined) delete process.env.DB_PASSWORD;
  else process.env.DB_PASSWORD = savedPassword;

  if (typeof mod.retrieveMemory !== 'function' || typeof mod.formatRetrievedFactsBlock !== 'function') {
    throw new Error('retrieve.js loaded but retrieveMemory/formatRetrievedFactsBlock are missing');
  }
  cached = mod;
  return cached;
}

module.exports = { loadRetrieveModule, RETRIEVE_DIST };
