import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, nangoAuthError, notConnected, resolveGoogleAuth, fetchWithTimeout } from './shared.js';

const ACTIONS = ['docs_create', 'docs_read', 'docs_append'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('create') || a.includes('append') || a.includes('write')) return 'draft';
  return 'read';
}

async function googleToken(orgId: string, action: string, timestamp: string) {
  const auth = await resolveGoogleAuth(orgId, 'google-docs');
  if (auth.kind !== 'connected') {
    return { token: null, authErr: nangoAuthError('google-docs', action, timestamp, auth) };
  }
  return { token: auth.accessToken as string, authErr: null };
}

export interface DocsFormattedContent {
  cleanText: string;
  paragraphStyles: Array<{ startIndex: number; endIndex: number; namedStyleType: string }>;
  bulletRanges: Array<{ startIndex: number; endIndex: number }>;
  boldRanges: Array<{ startIndex: number; endIndex: number }>;
}

/**
 * Parses markdown into clean Docs text (stripping markdown syntax like **, #, ##)
 * and extracts character ranges for heading styles, bullets, and bold typography.
 */
export function parseMarkdownToDocsContent(markdown: string, baseIndex = 1): DocsFormattedContent {
  const lines = markdown.split('\n');
  let cleanText = '';
  const paragraphStyles: Array<{ startIndex: number; endIndex: number; namedStyleType: string }> = [];
  const bulletRanges: Array<{ startIndex: number; endIndex: number }> = [];
  const boldRanges: Array<{ startIndex: number; endIndex: number }> = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      cleanText += '\n';
      continue;
    }

    let lineType: 'h1' | 'h2' | 'h3' | 'bullet' | 'normal' = 'normal';
    let textToParse = trimmed;

    if (trimmed.startsWith('### ')) {
      lineType = 'h3';
      textToParse = trimmed.slice(4).trim();
    } else if (trimmed.startsWith('## ')) {
      lineType = 'h2';
      textToParse = trimmed.slice(3).trim();
    } else if (trimmed.startsWith('# ')) {
      lineType = 'h1';
      textToParse = trimmed.slice(2).trim();
    } else if (/^[-*•]\s+/.test(trimmed)) {
      lineType = 'bullet';
      textToParse = trimmed.replace(/^[-*•]\s+/, '').trim();
    }

    let cleanLine = '';
    let lastIdx = 0;
    const lineBoldOffsets: Array<{ start: number; end: number }> = [];
    const boldRegex = /\*\*(.+?)\*\*/g;
    let match: RegExpExecArray | null;

    while ((match = boldRegex.exec(textToParse)) !== null) {
      const before = textToParse.slice(lastIdx, match.index);
      cleanLine += before;
      const bStart = cleanLine.length;
      cleanLine += match[1];
      const bEnd = cleanLine.length;
      lineBoldOffsets.push({ start: bStart, end: bEnd });
      lastIdx = match.index + match[0].length;
    }
    cleanLine += textToParse.slice(lastIdx);

    const lineStart = baseIndex + cleanText.length;
    const lineEnd = lineStart + cleanLine.length + 1;
    cleanText += cleanLine + '\n';

    for (const span of lineBoldOffsets) {
      boldRanges.push({
        startIndex: lineStart + span.start,
        endIndex: lineStart + span.end,
      });
    }

    if (lineType === 'h1') {
      paragraphStyles.push({ startIndex: lineStart, endIndex: lineEnd, namedStyleType: 'HEADING_1' });
    } else if (lineType === 'h2') {
      paragraphStyles.push({ startIndex: lineStart, endIndex: lineEnd, namedStyleType: 'HEADING_2' });
    } else if (lineType === 'h3') {
      paragraphStyles.push({ startIndex: lineStart, endIndex: lineEnd, namedStyleType: 'HEADING_3' });
    } else if (lineType === 'bullet') {
      bulletRanges.push({ startIndex: lineStart, endIndex: lineEnd });
    }
  }

  return { cleanText, paragraphStyles, bulletRanges, boldRanges };
}

async function applyDocsContent(gToken: string, documentId: string, markdown: string, baseIndex = 1): Promise<number> {
  const { cleanText, paragraphStyles, bulletRanges, boldRanges } = parseMarkdownToDocsContent(markdown, baseIndex);
  if (!cleanText.trim()) return 0;

  // Step 1: Insert clean plain text
  const insertRes = await fetchWithTimeout(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: baseIndex }, text: cleanText } }],
    }),
  });
  if (!insertRes.ok) {
    const err = await insertRes.text().catch(() => '');
    throw new Error(`Failed to insert text into doc: ${err}`);
  }

  // Step 2: Apply styles (headings, bullets, bold typography)
  const styleRequests: any[] = [];

  for (const p of paragraphStyles) {
    styleRequests.push({
      updateParagraphStyle: {
        range: { startIndex: p.startIndex, endIndex: p.endIndex },
        paragraphStyle: { namedStyleType: p.namedStyleType },
        fields: 'namedStyleType',
      },
    });
  }

  for (const b of bulletRanges) {
    styleRequests.push({
      createParagraphBullets: {
        range: { startIndex: b.startIndex, endIndex: b.endIndex },
        bulletPreset: 'BULLET_DISC_CIRCLE_SQUARE',
      },
    });
  }

  for (const span of boldRanges) {
    if (span.endIndex > span.startIndex) {
      styleRequests.push({
        updateTextStyle: {
          range: { startIndex: span.startIndex, endIndex: span.endIndex },
          textStyle: {
            bold: true,
            foregroundColor: { color: { rgbColor: { red: 0.1, green: 0.14, blue: 0.2 } } },
          },
          fields: 'bold,foregroundColor',
        },
      });
    }
  }

  if (styleRequests.length > 0) {
    await fetchWithTimeout(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: styleRequests }),
    }).catch((e) => console.warn('[google-docs] Non-fatal styling error:', e?.message));
  }

  return cleanText.length;
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const { token: gToken, authErr: gAuthErr } = await googleToken(orgId, actionName, timestamp);
  if (!gToken) return gAuthErr ?? notConnected('google-docs', actionName, timestamp);

  try {
    if (actionName.includes('create')) {
      const title = payload.title || payload.name || 'Untitled Document';
      const docRes = await fetchWithTimeout('https://docs.googleapis.com/v1/documents', {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!docRes.ok) {
        return { tool: 'google-docs', action: 'docs_create', status: 'error' as const, message: `Docs create error ${docRes.status}: ${await docRes.text()}`, data: null, timestamp };
      }
      const docData = await docRes.json();
      const initialContent = payload.content || payload.text || payload.body;
      let insertedChars = 0;
      if (initialContent && docData.documentId) {
        try {
          insertedChars = await applyDocsContent(gToken, docData.documentId, initialContent, 1);
        } catch (e: any) {
          console.warn('[google-docs] Failed to insert initial content:', e?.message);
        }
      }
      const url = `https://docs.google.com/document/d/${docData.documentId}/edit`;
      return {
        tool: 'google-docs',
        action: 'docs_create',
        status: 'executed' as const,
        message: `Created Google Doc "${docData.title}": ${url}`,
        data: { documentId: docData.documentId, title: docData.title, url, insertedCharacters: insertedChars },
        timestamp,
      };
    }

    const documentId = payload.documentId || payload.document_id || payload.id || payload.fileId || payload.file_id;

    if (actionName.includes('read') || actionName.includes('get') || actionName.includes('fetch')) {
      if (!documentId) {
        return { tool: 'google-docs', action: 'docs_read', status: 'error' as const, message: 'documentId is required to read a Docs document.', data: null, timestamp };
      }
      const docRes = await fetchWithTimeout(`https://docs.googleapis.com/v1/documents/${documentId}`, {
        headers: { Authorization: `Bearer ${gToken}` },
      });
      if (!docRes.ok) {
        return { tool: 'google-docs', action: 'docs_read', status: 'error' as const, message: `Docs read error ${docRes.status}: ${await docRes.text()}`, data: null, timestamp };
      }
      const docData = await docRes.json();
      const text = (docData.body?.content || [])
        .filter((el: any) => el.paragraph)
        .map((el: any) => (el.paragraph.elements || [])
          .map((e: any) => e.textRun?.content || '')
          .join(''))
        .join('\n');
      const url = `https://docs.google.com/document/d/${documentId}/edit`;
      return {
        tool: 'google-docs',
        action: 'docs_read',
        status: 'executed' as const,
        message: `Read Google Doc "${docData.title}" (${text.length} chars): ${url}`,
        data: { documentId, title: docData.title, content: text.slice(0, 8000), totalCharacters: text.length, url },
        timestamp,
      };
    }

    if (actionName.includes('append') || actionName.includes('write')) {
      const content = payload.content || payload.text || '';
      if (!documentId) {
        return { tool: 'google-docs', action: 'docs_append', status: 'error' as const, message: 'documentId is required to append to a Docs document.', data: null, timestamp };
      }
      if (!content) {
        return { tool: 'google-docs', action: 'docs_append', status: 'error' as const, message: 'Content text is required to append.', data: null, timestamp };
      }

      // Fetch the document to find the true end index of the body
      const docRes = await fetchWithTimeout(`https://docs.googleapis.com/v1/documents/${documentId}`, {
        headers: { Authorization: `Bearer ${gToken}` },
      });
      if (!docRes.ok) {
        return { tool: 'google-docs', action: 'docs_append', status: 'error' as const, message: `Failed to fetch doc for append: ${await docRes.text()}`, data: null, timestamp };
      }
      const docData = await docRes.json();
      const bodyElements = docData.body?.content || [];
      const lastElem = bodyElements[bodyElements.length - 1];
      // Docs body segments always end with a trailing newline at endIndex - 1
      const appendIndex = lastElem?.endIndex && lastElem.endIndex > 1 ? lastElem.endIndex - 1 : 1;

      const insertedChars = await applyDocsContent(gToken, documentId, `\n${content}`, appendIndex);
      const url = `https://docs.google.com/document/d/${documentId}/edit`;
      return {
        tool: 'google-docs',
        action: 'docs_append',
        status: 'executed' as const,
        message: `Appended ${insertedChars} formatted characters to Google Doc "${docData.title || documentId}": ${url}`,
        data: { documentId, title: docData.title, appendedCharacters: insertedChars, url },
        timestamp,
      };
    }

    return { tool: 'google-docs', action: actionName, status: 'error' as const, message: `Unsupported Docs action "${actionName}". Try docs_create, docs_read, docs_append.`, data: null, timestamp };
  } catch (e: any) {
    console.error('[google-docs] API error:', e.message);
    return {
      tool: 'google-docs',
      action: actionName,
      status: 'error' as const,
      message: `google-docs request failed: ${e.message}`,
      data: null,
      timestamp,
    };
  }
}

export const googleDocs: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
