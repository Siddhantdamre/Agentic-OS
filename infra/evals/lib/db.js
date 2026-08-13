'use strict';

const path = require('path');

const MEMORY_TABLES = [
  'org_memory',
  'employee_memory',
  'entity_memory',
  'conversation_memory',
  'knowledge_sources',
  'ingestion_jobs',
];

function loadPg() {
  try {
    return require('pg');
  } catch {
    return require(path.join(__dirname, '../../../apps/dashboard/node_modules/pg'));
  }
}

function superuserConfig() {
  return {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_SUPERUSER || 'darex',
    password: process.env.DB_SUPERUSER_PASSWORD || process.env.DB_PASSWORD || 'darex_dev_secret',
    database: process.env.DB_NAME || 'darex',
    connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '3000', 10),
  };
}

function appRoleName() {
  return process.env.APP_DB_USER || 'darex_app';
}

async function missingTables(client, names) {
  const missing = [];
  for (const table of names) {
    const res = await client.query(`SELECT to_regclass($1) AS t`, [`public.${table}`]);
    if (!res.rows[0] || !res.rows[0].t) missing.push(table);
  }
  return missing;
}

async function missingMemoryTables(client) {
  return missingTables(client, MEMORY_TABLES);
}

async function tableColumns(client, table) {
  const res = await client.query(
    `SELECT column_name, data_type, udt_name, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return res.rows;
}

async function vectorDims(client, table, column = 'embedding') {
  const res = await client.query(
    `SELECT CASE WHEN a.atttypmod > 0 THEN a.atttypmod - 4 ELSE NULL END AS dims
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = $1
        AND a.attname = $2
        AND NOT a.attisdropped`,
    [table, column],
  );
  const dims = res.rows[0] && res.rows[0].dims;
  return dims != null ? Number(dims) : null;
}

function zeroVectorLiteral(dims) {
  return `[${Array(dims).fill(0).join(',')}]`;
}

async function setOrg(client, orgId) {
  await client.query(`SELECT set_config('app.current_org_id', $1, false)`, [orgId]);
}

async function resetRole(client) {
  await client.query('RESET ROLE');
}

async function setAppRole(client) {
  const role = appRoleName();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(role)) {
    throw new Error(`invalid APP_DB_USER role name: ${JSON.stringify(role)}`);
  }
  await client.query(`SET ROLE ${role}`);
}

module.exports = {
  MEMORY_TABLES,
  loadPg,
  superuserConfig,
  appRoleName,
  missingTables,
  missingMemoryTables,
  tableColumns,
  vectorDims,
  zeroVectorLiteral,
  setOrg,
  resetRole,
  setAppRole,
};
