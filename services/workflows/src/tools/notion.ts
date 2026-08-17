import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk, getNangoAccessToken, notConnected } from './shared.js';

const ACTIONS = ['create_page', 'append_page_content', 'search_workspace_docs'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('append') || a.includes('add_content') || a.includes('update_content')) return 'draft';
  if (a.includes('create') || a.includes('add')) return 'draft';
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const notionConnId = `${orgId}_notion`;
  const notionToken = await getNangoAccessToken(notionConnId, 'notion');
  if (notionToken) {
    try {
      if (actionName.includes('append') || actionName.includes('add_content') || actionName.includes('update_content')) {
        const pageId = payload.pageId || payload.page_id || payload.parentId;
        const content = payload.content || payload.text || '';
        if (!pageId) {
          return { tool: 'notion', action: 'append_page_content', status: 'error' as const, message: 'Page id (pageId) is required to append content.', data: null, timestamp };
        }
        if (!content) {
          return { tool: 'notion', action: 'append_page_content', status: 'error' as const, message: 'Content text is required to append.', data: null, timestamp };
        }
        const lines = content.split('\n').filter((l: string) => l.trim().length > 0);
        const children = lines.map((l: string) => ({
          object: 'block' as const,
          type: 'paragraph' as const,
          paragraph: { rich_text: [{ type: 'text', text: { content: l.slice(0, 2000) } }] },
        }));
        const appendRes = await fetch(`https://api.notion.com/v1/blocks/${pageId}/children`, {
          method: 'PATCH',
          headers: {
            Authorization: `Bearer ${notionToken}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
          },
          body: JSON.stringify({ children }),
        });
        if (appendRes.ok) {
          const appended = await appendRes.json();
          return {
            tool: 'notion',
            action: 'append_page_content',
            status: 'executed' as const,
            message: `Appended ${children.length} block${children.length === 1 ? '' : 's'} to Notion page ${pageId}`,
            data: { pageId, blocksAppended: children.length, blockIds: (appended.results || []).map((b: any) => b.id) },
            timestamp,
          };
        }
        const appendErr = await appendRes.json().catch(() => ({}));
        return { tool: 'notion', action: 'append_page_content', status: 'error' as const, message: `Notion append failed: ${appendRes.status} ${appendErr.message || ''}`, data: null, timestamp };
      }

      if (actionName.includes('create') || actionName.includes('add')) {
        const title = payload.title || 'Untitled Page';
        const parentPageId = payload.parentPageId || payload.parentId;
        const notionRes = await fetch('https://api.notion.com/v1/pages', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${notionToken}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
          },
          body: JSON.stringify({
            parent: parentPageId ? { page_id: parentPageId } : { type: 'workspace', workspace: true },
            properties: {
              title: { title: [{ text: { content: title } }] },
            },
          }),
        });
        if (notionRes.ok) {
          const pageData = await notionRes.json();
          return {
            tool: 'notion',
            action: 'create_page',
            status: 'executed' as const,
            message: `✅ Created Notion page "${title}"`,
            data: { id: pageData.id, url: pageData.url, title },
            timestamp,
          };
        }
      } else {
        const query = payload.query || '';
        const notionRes = await fetch('https://api.notion.com/v1/search', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${notionToken}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
          },
          body: JSON.stringify({ query, page_size: 10 }),
        });
        if (notionRes.ok) {
          const notionData = await notionRes.json();
          return {
            tool: 'notion',
            action: 'search_workspace_docs',
            status: 'executed' as const,
            message: `Searched Notion workspace for: "${query}"`,
            data: { results: notionData.results || [], totalResults: notionData.results?.length || 0 },
            timestamp,
          };
        }
      }
    } catch (e: any) {
      console.error('[Notion] API error:', e.message);
    }
  }
  return notConnected('notion', actionName, timestamp);
}

export const notion: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
