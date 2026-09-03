#!/usr/bin/env node
/**
 * PDF + DOCX upload → agent, end to end.
 *
 * Builds a genuine PDF (hand-authored, uncompressed text stream) and a genuine
 * DOCX (a real OOXML zip via jszip) rather than renaming a .txt — a fake file
 * would prove only that the extension check works, not that pdf-parse and
 * mammoth actually read the bytes.
 *
 * Each document carries a fact that exists nowhere else and cannot be guessed.
 * If the agent says it, the whole chain worked:
 *   upload → extract → IngestWorkflow → org_memory → webhook → retrieval → reply
 */
const crypto = require('crypto');
const path = require('path');

const resolveDash = (m) => require(require.resolve(m, { paths: [path.join(__dirname, '../../apps/dashboard')] }));
let Client;
try { Client = require('pg').Client; } catch { Client = resolveDash('pg').Client; }
const JSZip = resolveDash('jszip');

const BASE = process.env.DASHBOARD_URL || 'http://127.0.0.1:3000';
const SECRET = process.env.CHATWOOT_WEBHOOK_SECRET || 'darex-chatwoot-webhook-secret-dev';
const sign = (b) => `sha256=${crypto.createHmac('sha256', SECRET).update(b).digest('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { awaitSubstantiveReply, explainNoReply } = require('./lib/await-reply');

const db = new Client({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  user: process.env.DB_RESOLVER_USER || 'darex',
  password: process.env.DB_RESOLVER_PASSWORD || 'darex_dev_secret',
  database: process.env.DB_NAME || 'darex',
});

let pass = 0, fail = 0;
const ok = (m, d = '') => { pass++; console.log(`  [PASS] ${m}${d ? ` — ${d}` : ''}`); };
const no = (m, d = '') => { fail++; console.log(`  [FAIL] ${m}${d ? ` — ${d}` : ''}`); };

/**
 * A valid PDF, produced by pdfkit.
 *
 * The first version of this hand-authored the PDF structure including the xref
 * table. pdf-parse rejected it with "bad XRef entry" — the byte offsets were
 * subtly wrong — and for one debugging cycle that looked like a broken upload
 * endpoint rather than a broken fixture. A test fixture that is itself buggy is
 * worse than no test: it reports failures the product does not have.
 */
function buildPdf(lines) {
  const PDFDocument = resolveDash('pdfkit');
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(12);
    for (const line of lines) doc.text(line);
    doc.end();
  });
}

/** A real OOXML .docx. */
async function buildDocx(paragraphs) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>');
  zip.folder('_rels').file('.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`).join('');
  zip.folder('word').file('document.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + `<w:body>${body}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function newTenant() {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `fmt_${stamp}@example.com`, password: `Pw-${stamp}-Aa1!` }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.orgId) throw new Error(`register failed HTTP ${res.status}`);
  const cookie = (res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')])
    .filter(Boolean).map((c) => String(c).split(';')[0]).join('; ');
  const token = `orgsecret-${stamp}`;
  await db.query(
    `UPDATE orgs SET meta = COALESCE(meta,'{}'::jsonb) || jsonb_build_object('webhook_secret',$2::text) WHERE id=$1`,
    [body.orgId, token]);
  await db.query(
    `INSERT INTO ai_employees (org_id, name, role, persona, tool_allowlist, status)
     VALUES ($1,'Sarah','support','{}'::jsonb, ARRAY['database_query']::text[], 'active')`, [body.orgId]);
  return { orgId: body.orgId, cookie, token };
}

async function askAgent(t, question) {
  const before = await db.query(
    `SELECT COUNT(*)::int AS n FROM messages WHERE org_id=$1 AND role='assistant'`, [t.orgId]);
  const payload = JSON.stringify({
    event: 'message_created', message_type: 'incoming', content: question,
    id: Date.now() + Math.floor(Math.random() * 1000),
    conversation: { id: Math.floor(Math.random() * 100000), inbox_id: 7373 },
    sender: { phone_number: '+919900004321', name: 'Customer' }, account: { id: 7373 },
  });
  await fetch(`${BASE}/api/webhooks/chatwoot?org_id=${t.orgId}&token=${t.token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-chatwoot-signature': sign(payload) },
    body: payload,
  });
  // The ANSWER, not the first thing the agent says: it sends an interim
  // acknowledgement before a slow reply, and asserting on that reported the
  // uploaded fact as missing when the answer had not arrived yet.
  const outcome = await awaitSubstantiveReply({
    query: (sql, params) => db.query(sql, params),
    orgId: t.orgId,
  });
  if (!outcome.reply) console.log(`      ${explainNoReply(outcome)}`);
  return outcome.reply;
}

async function runFormat(label, filename, mime, bytes, marker, question) {
  console.log(`\n--- ${label} ---`);
  const t = await newTenant();
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mime }), filename);
  const up = await fetch(`${BASE}/api/brain/upload`, { method: 'POST', headers: { cookie: t.cookie }, body: form });
  const upBody = await up.json().catch(() => ({}));
  up.ok
    ? ok(`${label} upload accepted`, `${upBody.format} · ${upBody.characters} chars extracted`)
    : no(`${label} upload accepted`, `HTTP ${up.status} ${JSON.stringify(upBody).slice(0, 200)}`);
  if (!up.ok) { await db.query(`DELETE FROM orgs WHERE id=$1`, [t.orgId]); return; }

  let landed = null;
  for (let i = 0; i < 40; i++) {
    const r = await db.query(
      `SELECT embedding IS NULL AS no_vector FROM org_memory WHERE org_id=$1 AND body ILIKE $2 LIMIT 1`,
      [t.orgId, `%${marker}%`]);
    if (r.rows.length) { landed = r.rows[0]; break; }
    await sleep(1500);
  }
  landed
    ? ok(`${label} landed in org_memory`, `null_embedding=${landed.no_vector}`)
    : no(`${label} landed in org_memory`, 'not found within 60s');
  if (!landed) { await db.query(`DELETE FROM orgs WHERE id=$1`, [t.orgId]); return; }

  const reply = await askAgent(t, question);
  if (!reply) { no(`${label} agent replied`, 'timeout'); }
  else {
    console.log(`  Q: ${question}`);
    console.log(`  A: ${reply.replace(/\s+/g, ' ').slice(0, 220)}`);
    new RegExp(marker.replace(/\s/g, '\\s*'), 'i').test(reply)
      ? ok(`${label} answer carries the uploaded fact ("${marker}")`)
      : no(`${label} answer carries the uploaded fact ("${marker}")`, reply.slice(0, 140));
  }
  await db.query(`DELETE FROM orgs WHERE id=$1`, [t.orgId]);
}

(async () => {
  await db.connect();
  console.log('\n### PDF + DOCX UPLOAD → AGENT\n');

  const pdfCode = `WRNTY-${Math.floor(Math.random() * 9000) + 1000}`;
  const pdfBytes = await buildPdf([
    'Bright Leaf Interiors - Warranty Terms',
    '',
    `All upholstered furniture carries a warranty reference code ${pdfCode}.`,
    'Frames are covered for ten years and fabric for three years.',
    'Claims must be made in writing within the warranty period.',
  ]);
  await runFormat('PDF', 'warranty-terms.pdf', 'application/pdf', pdfBytes, pdfCode,
    'What is the warranty on your upholstered furniture?');

  const docCode = `SVC-${Math.floor(Math.random() * 9000) + 1000}`;
  const docxBytes = await buildDocx([
    'Bright Leaf Interiors - Aftercare Service',
    `Our aftercare team operates under service plan ${docCode}.`,
    'A free cushion re-fill is offered once in the first two years.',
    'Aftercare visits are scheduled on Tuesdays and Thursdays only.',
  ]);
  await runFormat('DOCX', 'aftercare.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    docxBytes, docCode, 'Do you offer any aftercare once the furniture is delivered?');

  console.log(`\n  passed ${pass} / ${pass + fail}`);
  await db.end();
  process.exit(fail ? 1 : 0);
})();
