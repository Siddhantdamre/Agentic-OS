import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['docs_create', 'docs_read', 'docs_append'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('create') || a.includes('append') || a.includes('write')) return 'draft';
  return 'read';
}

async function googleToken(orgId: string): Promise<string | null> {
  const gConnId = `${orgId}_google-docs`;
  for (const providerKey of ['google-docs', 'google']) {
    const token = await getNangoAccessToken(gConnId, providerKey);
    if (token) return token;
  }
  return null;
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const gToken = await googleToken(orgId);
  if (!gToken) return notConnected('google-docs', actionName, timestamp);

  try {
    if (actionName.includes('create')) {
      const title = payload.title || payload.name || 'Untitled Document';
      const docRes = await fetch('https://docs.googleapis.com/v1/documents', {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      if (!docRes.ok) {
        return { tool: 'google-docs', action: 'docs_create', status: 'error' as const, message: `Docs create error ${docRes.status}: ${await docRes.text()}`, data: null, timestamp };
      }
      const docData = await docRes.json();
      return {
        tool: 'google-docs',
        action: 'docs_create',
        status: 'executed' as const,
        message: `Created Google Doc "${docData.title}"`,
        data: { documentId: docData.documentId, title: docData.title, url: `https://docs.google.com/document/d/${docData.documentId}/edit` },
        timestamp,
      };
    }

    if (actionName.includes('read') || actionName.includes('get') || actionName.includes('fetch')) {
      const documentId = payload.documentId || payload.id;
      if (!documentId) {
        return { tool: 'google-docs', action: 'docs_read', status: 'error' as const, message: 'documentId is required to read a Docs document.', data: null, timestamp };
      }
      const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}`, {
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
      return {
        tool: 'google-docs',
        action: 'docs_read',
        status: 'executed' as const,
        message: `Read Google Doc "${docData.title}" (${text.length} chars)`,
        data: { documentId, title: docData.title, content: text.slice(0, 8000), totalCharacters: text.length, url: `https://docs.google.com/document/d/${documentId}/edit` },
        timestamp,
      };
    }

    if (actionName.includes('append') || actionName.includes('write')) {
      const documentId = payload.documentId || payload.id;
      const content = payload.content || payload.text || '';
      if (!documentId) {
        return { tool: 'google-docs', action: 'docs_append', status: 'error' as const, message: 'documentId is required to append to a Docs document.', data: null, timestamp };
      }
      if (!content) {
        return { tool: 'google-docs', action: 'docs_append', status: 'error' as const, message: 'Content text is required to append.', data: null, timestamp };
      }
      const batched = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ insertText: { location: { index: 1 }, text: `${content}\n` } }],
        }),
      });
      if (!batched.ok) {
        return { tool: 'google-docs', action: 'docs_append', status: 'error' as const, message: `Docs append error ${batched.status}: ${await batched.text()}`, data: null, timestamp };
      }
      return {
        tool: 'google-docs',
        action: 'docs_append',
        status: 'executed' as const,
        message: `Appended ${content.length} characters to Google Doc ${documentId}`,
        data: { documentId, appendedCharacters: content.length + 1 },
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
