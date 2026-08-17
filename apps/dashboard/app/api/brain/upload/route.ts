import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { getTemporalClient } from '@darex/workflows/dist/workflow-client';

export const dynamic = 'force-dynamic';

/**
 * POST /api/brain/upload — the customer-facing way to teach the agent.
 *
 * Until now there was NO upload endpoint at all. `ingestFileActivity` reads its
 * content from `knowledge_sources.metadata.ingestText`, so the only way to add
 * a document was to write that row yourself. A business had no supported route
 * to give the agent its own hours, policies or prices — which is why the agent
 * answered "I don't have that" to everything a real customer would ask.
 *
 * This accepts a real file, extracts text, stores it on the source row, and
 * hands off to the existing IngestWorkflow. Nothing downstream changes: the
 * same chunking, redaction and org_memory write the connectors use.
 *
 * Embeddings are NOT required. When EMBEDDING_MODEL is empty the text still
 * lands in org_memory with a NULL embedding and is found by full-text search
 * (see enqueueEmbedJobFromWorker). Losing the text is permanent; lacking a
 * vector is not.
 */

/** Refuse oversized uploads before reading them into memory. */
const MAX_BYTES = 10 * 1024 * 1024;

/** Text must survive extraction to be worth ingesting at all. */
const MIN_TEXT_CHARS = 8;

type Extraction =
  | { ok: true; text: string; format: string }
  | { ok: false; error: string; format: string };

/**
 * PDF and DOCX text extraction.
 *
 * Required lazily and inside try/catch: these are the only heavy dependencies
 * in this route, and a missing or broken one must degrade to "this format is
 * unavailable" rather than 500 the whole upload endpoint — including for the
 * plain-text uploads that need neither library.
 */
async function extractRich(ext: string, type: string, bytes: Buffer): Promise<Extraction | null> {
  if (ext === 'pdf' || type === 'application/pdf') {
    try {
      // Required lazily so a missing parser degrades this one format, not the
      // whole endpoint.
      // unpdf, not pdf-parse.
      //
      // pdf-parse@1.1.1 (last released 2018) ships a pdf.js copy that rejects
      // modern cross-reference tables with "bad XRef entry". It failed on every
      // real PDF tried — including pdfkit output — inside the container and
      // outside it, on both require paths. It is a dead dependency, not a
      // misconfiguration. unpdf wraps a current pdf.js and reads the same bytes
      // without complaint.
      //
      // ESM-only, so dynamic import rather than require.
      const { extractText: extractPdfText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      const parsed = await extractPdfText(pdf, { mergePages: true });
      const text = String(parsed?.text || '').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) {
        return {
          ok: false,
          format: 'pdf',
          // A scanned PDF is images: there is no text layer to extract, and
          // saying so is far more useful than "no readable text found".
          error: 'This PDF has no text layer — it looks like a scan or images. '
            + 'Upload a text-based PDF, or paste the text instead.',
        };
      }
      return { ok: true, text, format: 'pdf' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[brain/upload] pdf extraction failed:', message);
      return { ok: false, format: 'pdf', error: 'Could not read this PDF. It may be encrypted or corrupt.' };
    }
  }

  if (ext === 'docx' || type.includes('wordprocessingml')) {
    try {
      // Required lazily so a missing parser degrades this one format, not the
      // whole endpoint.
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer: bytes });
      const text = String(result?.value || '').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) {
        return { ok: false, format: 'docx', error: 'No readable text found in this document.' };
      }
      return { ok: true, text, format: 'docx' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[brain/upload] docx extraction failed:', message);
      return {
        ok: false,
        format: 'docx',
        // .doc is a different, older binary format mammoth cannot read.
        error: 'Could not read this document. If it is an older .doc file, save it as .docx first.',
      };
    }
  }

  return null;
}

/**
 * Extract text from an uploaded file.
 *
 * PDF and DOCX are handled first by extractRich (pdf-parse / mammoth); the
 * plain-text family is decoded directly here. Order matters: a binary file that
 * fell through to the UTF-8 decoder would be stored as mojibake and then
 * retrieved and quoted at customers, and a knowledge base quietly full of
 * garbage is worse than one that rejected the file.
 */
async function extractText(name: string, mime: string, bytes: Buffer): Promise<Extraction> {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const type = (mime || '').toLowerCase();

  // PDF/DOCX first — they are binary, and must never fall through to the UTF-8
  // decoder below, which would store mojibake the agent then quotes at people.
  const rich = await extractRich(ext, type, bytes);
  if (rich) return rich;

  const isPlain =
    ['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'html', 'htm'].includes(ext)
    || type.startsWith('text/')
    || type === 'application/json'
    || type === 'application/csv';

  if (isPlain) {
    let text = bytes.toString('utf8');
    // A UTF-16/binary file decoded as UTF-8 is full of replacement chars. Catch
    // it here rather than storing unusable text.
    const replacements = (text.match(/�/g) || []).length;
    if (replacements > text.length * 0.02) {
      return { ok: false, error: 'File does not appear to be UTF-8 text.', format: ext || type };
    }
    if (ext === 'json') {
      // Pretty-print so full-text search sees the values on their own lines
      // rather than one unsearchable blob.
      try {
        text = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // Not valid JSON — ingest it as the plain text it is.
      }
    }
    if (ext === 'html' || ext === 'htm') {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s{2,}/g, ' ');
    }
    return { ok: true, text: text.trim(), format: ext || 'text' };
  }

  return {
    ok: false,
    format: ext || type || 'unknown',
    error: `Unsupported file type "${ext || type || 'unknown'}". Supported: pdf, docx, txt, md, csv, tsv, json, yaml, html.`,
  };
}

export async function POST(request: Request) {
  let scoped;
  try {
    scoped = await getScopedClient();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { client, orgId } = scoped;

  try {
    let name = '';
    let mime = '';
    let bytes: Buffer | null = null;
    let title = '';

    const contentType = request.headers.get('content-type') || '';

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      const file = form.get('file');
      if (!file || typeof file === 'string') {
        return NextResponse.json({ error: 'No file provided. Send it as form field "file".' }, { status: 400 });
      }
      name = file.name || 'upload.txt';
      mime = file.type || '';
      const buf = Buffer.from(await file.arrayBuffer());
      if (buf.length > MAX_BYTES) {
        return NextResponse.json({ error: `File exceeds ${MAX_BYTES / 1024 / 1024}MB.` }, { status: 413 });
      }
      bytes = buf;
      const t = form.get('title');
      title = typeof t === 'string' ? t : '';
    } else {
      // JSON fallback: { filename, text } or { filename, base64 }. Keeps the
      // endpoint usable from scripts and tests without multipart encoding.
      const body = await request.json().catch(() => ({} as Record<string, unknown>));
      name = typeof body.filename === 'string' ? body.filename : 'upload.txt';
      mime = typeof body.mimeType === 'string' ? body.mimeType : '';
      title = typeof body.title === 'string' ? body.title : '';
      if (typeof body.text === 'string') {
        bytes = Buffer.from(body.text, 'utf8');
        mime = mime || 'text/plain';
      } else if (typeof body.base64 === 'string') {
        bytes = Buffer.from(body.base64, 'base64');
      }
      if (bytes && bytes.length > MAX_BYTES) {
        return NextResponse.json({ error: `File exceeds ${MAX_BYTES / 1024 / 1024}MB.` }, { status: 413 });
      }
    }

    if (!bytes || bytes.length === 0) {
      return NextResponse.json({ error: 'Empty upload.' }, { status: 400 });
    }

    const extracted = await extractText(name, mime, bytes);
    if (!extracted.ok) {
      // 415, not 500: the request was well formed, the format is not supported.
      return NextResponse.json(
        { error: extracted.error, filename: name, format: extracted.format, supported: ['pdf', 'docx', 'txt', 'md', 'csv', 'tsv', 'json', 'yaml', 'html'] },
        { status: 415 },
      );
    }
    if (extracted.text.length < MIN_TEXT_CHARS) {
      return NextResponse.json({ error: 'No readable text found in the file.', filename: name }, { status: 422 });
    }

    // Stable path per filename so re-uploading the same document updates it
    // rather than creating a duplicate the agent could cite twice.
    const path = `upload:${name}`;
    const displayTitle = title.trim() || name;

    const inserted = await client.query(
      `INSERT INTO knowledge_sources (org_id, connector, path, status, metadata)
       VALUES ($1, 'upload', $2, 'pending', $3::jsonb)
       ON CONFLICT (org_id, connector, path) DO UPDATE
         SET status = 'pending',
             metadata = knowledge_sources.metadata || EXCLUDED.metadata,
             updated_at = NOW()
       RETURNING id`,
      [
        orgId,
        path,
        JSON.stringify({
          // ingestFileActivity reads the content from here.
          ingestText: extracted.text,
          title: displayTitle,
          filename: name,
          format: extracted.format,
          bytes: bytes.length,
          uploadedAt: new Date().toISOString(),
        }),
      ],
    );
    const sourceId = String(inserted.rows[0].id);

    const job = await client.query(
      `INSERT INTO ingestion_jobs (org_id, source_id, state) VALUES ($1, $2, 'queued') RETURNING id`,
      [orgId, sourceId],
    );
    const jobId = String(job.rows[0].id);

    const temporal = await getTemporalClient();
    if (!temporal) {
      return NextResponse.json({
        status: 'pending',
        sourceId,
        jobId,
        filename: name,
        format: extracted.format,
        characters: extracted.text.length,
        message: 'Saved. Temporal is unavailable, so indexing has not started yet.',
      });
    }

    await temporal.workflow.start('IngestWorkflow', {
      taskQueue: 'darex-agent-tasks',
      // Job-scoped id: a re-upload of the same file must start a NEW run, not
      // collide with the completed one.
      workflowId: `ingest-${orgId}-${sourceId}-${jobId}`,
      args: [{ orgId, sourceId, jobId, connector: 'upload', path, kind: 'faq', modifiedAt: new Date().toISOString() }],
      workflowExecutionTimeout: '15 minutes',
    });

    return NextResponse.json({
      status: 'indexing',
      sourceId,
      jobId,
      filename: name,
      title: displayTitle,
      format: extracted.format,
      characters: extracted.text.length,
      message: 'Uploaded. Your assistant will be able to use it within a minute.',
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[brain/upload]', message);
    return NextResponse.json({ error: 'Upload failed.' }, { status: 500 });
  } finally {
    client.release();
  }
}
