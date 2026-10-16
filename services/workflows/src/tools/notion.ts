import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, nangoAuthError, notConnected, resolveNangoAuth, fetchWithTimeout } from './shared.js';

const ACTIONS = [
  'create_page',
  'append_page_content',
  'read_page',
  'query_database',
  'search_workspace_docs',
] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('append') || a.includes('add_content') || a.includes('update_content')) return 'draft';
  if (a.includes('create') || a.includes('add')) return 'draft';
  return 'read';
}

function extractRichText(richTextArray?: any[]): string {
  if (!Array.isArray(richTextArray)) return '';
  return richTextArray.map((rt: any) => rt?.plain_text || rt?.text?.content || '').join('');
}

function extractBlockText(block: any): string {
  if (!block || typeof block !== 'object') return '';
  const type = block.type;
  if (!type || !block[type]) return '';
  const sub = block[type];
  const text = extractRichText(sub.rich_text);
  switch (type) {
    case 'heading_1':
      return `# ${text}`;
    case 'heading_2':
      return `## ${text}`;
    case 'heading_3':
      return `### ${text}`;
    case 'bulleted_list_item':
      return `* ${text}`;
    case 'numbered_list_item':
      return `1. ${text}`;
    case 'to_do':
      return `[${sub.checked ? 'x' : ' '}] ${text}`;
    case 'quote':
      return `> ${text}`;
    case 'code':
      return `\`\`\`${sub.language || ''}\n${text}\n\`\`\``;
    case 'callout':
      return `> 💡 ${text}`;
    default:
      return text;
  }
}

function extractPageTitle(pageData: any): string {
  if (!pageData?.properties) return 'Untitled';
  for (const key of Object.keys(pageData.properties)) {
    const prop = pageData.properties[key];
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const title = extractRichText(prop.title);
      if (title) return title;
    }
  }
  return 'Untitled';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const notionConnId = `${orgId}_notion`;
  const _notionAuth = await resolveNangoAuth(notionConnId, 'notion');
  const notionToken = _notionAuth.kind === 'connected' ? _notionAuth.accessToken : null;
  const _notionAuthErr = _notionAuth.kind === 'connected' ? null : nangoAuthError('notion', actionName, timestamp, _notionAuth);

  if (!notionToken) {
    return _notionAuthErr ?? notConnected('notion', actionName, timestamp);
  }

  const action = String(actionName || '').toLowerCase();

  try {
    // ── 1. Read Page Content ──────────────────────────────────────────
    if (action.includes('read_page') || action.includes('get_page') || action.includes('read_doc')) {
      const pageId = String(payload.pageId || payload.page_id || payload.id || '').trim();
      if (!pageId) {
        return apiError('notion', 'read_page', timestamp, 'Page ID (pageId) is required to read a Notion page.');
      }

      // Fetch page properties
      const pageRes = await fetchWithTimeout(`https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${notionToken}`,
          'Notion-Version': '2022-06-28',
        },
      });

      if (!pageRes.ok) {
        const pageErr = await pageRes.json().catch(() => ({}));
        return apiError('notion', 'read_page', timestamp, `Failed to retrieve Notion page ${pageId}: ${pageErr.message || pageRes.statusText || pageRes.status}`);
      }
      const pageData = await pageRes.json();
      const title = extractPageTitle(pageData);

      // Fetch block children
      const blocksRes = await fetchWithTimeout(`https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=100`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${notionToken}`,
          'Notion-Version': '2022-06-28',
        },
      });

      let content = '';
      let blockCount = 0;
      if (blocksRes.ok) {
        const blocksData = await blocksRes.json();
        const results = Array.isArray(blocksData.results) ? blocksData.results : [];
        blockCount = results.length;
        content = results.map(extractBlockText).filter(Boolean).join('\n\n');
      }

      return {
        tool: 'notion',
        action: 'read_page',
        status: 'executed' as const,
        message: `Read Notion page "${title}" (${blockCount} blocks)`,
        data: {
          pageId,
          title,
          url: pageData.url,
          content,
          blockCount,
        },
        timestamp,
      };
    }

    // ── 2. Append Content to Existing Page ────────────────────────────
    if (action.includes('append') || action.includes('add_content') || action.includes('update_content')) {
      const pageId = String(payload.pageId || payload.page_id || payload.parentId || '').trim();
      const content = String(payload.content || payload.text || '').trim();
      if (!pageId) {
        return apiError('notion', 'append_page_content', timestamp, 'Page id (pageId) is required to append content.');
      }
      if (!content) {
        return apiError('notion', 'append_page_content', timestamp, 'Content text is required to append.');
      }
      const lines = content.split('\n').filter((l: string) => l.trim().length > 0);
      const children = lines.map((l: string) => ({
        object: 'block' as const,
        type: 'paragraph' as const,
        paragraph: { rich_text: [{ type: 'text', text: { content: l.slice(0, 2000) } }] },
      }));
      const appendRes = await fetchWithTimeout(`https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children`, {
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
      return apiError('notion', 'append_page_content', timestamp, `Notion append failed: ${appendErr.message || appendRes.statusText || appendRes.status}`);
    }

    // ── 3. Query Database ─────────────────────────────────────────────
    if (action.includes('database') || action.includes('query_db')) {
      const databaseId = String(payload.databaseId || payload.database_id || payload.dbId || '').trim();
      if (!databaseId) {
        return apiError('notion', 'query_database', timestamp, 'Database ID (databaseId) is required to query a Notion database.');
      }
      const pageSize = Math.min(Math.max(Number(payload.pageSize) || 20, 1), 100);
      const queryBody: Record<string, any> = { page_size: pageSize };
      if (payload.filter && typeof payload.filter === 'object') queryBody.filter = payload.filter;
      if (Array.isArray(payload.sorts)) queryBody.sorts = payload.sorts;

      const queryRes = await fetchWithTimeout(`https://api.notion.com/v1/databases/${encodeURIComponent(databaseId)}/query`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${notionToken}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify(queryBody),
      });

      if (!queryRes.ok) {
        const err = await queryRes.json().catch(() => ({}));
        return apiError('notion', 'query_database', timestamp, `Notion database query failed: ${err.message || queryRes.statusText || queryRes.status}`);
      }

      const queryData = await queryRes.json();
      const rawResults = Array.isArray(queryData.results) ? queryData.results : [];
      const records = rawResults.map((row: any) => {
        const rowTitle = extractPageTitle(row);
        return {
          id: row.id,
          url: row.url,
          title: rowTitle,
          createdTime: row.created_time,
          lastEditedTime: row.last_edited_time,
          properties: row.properties,
        };
      });

      return {
        tool: 'notion',
        action: 'query_database',
        status: 'executed' as const,
        message: `Queried database ${databaseId}: found ${records.length} record${records.length === 1 ? '' : 's'}`,
        data: {
          databaseId,
          results: records,
          total: records.length,
          hasMore: Boolean(queryData.has_more),
        },
        timestamp,
      };
    }

    // ── 4. Create Page ────────────────────────────────────────────────
    if (action.includes('create') || action.includes('add')) {
      const title = String(payload.title || 'Untitled Page').trim();
      let parentPageId = payload.parentPageId || payload.parentId || payload.pageId;
      const databaseId = payload.databaseId || payload.database_id;

      let parent: Record<string, any>;
      if (databaseId) {
        parent = { database_id: String(databaseId).trim() };
      } else if (parentPageId) {
        parent = { page_id: String(parentPageId).trim() };
      } else {
        // Notion API (2022-06-28) rejects { workspace: true } for integrations.
        // Auto-discover the first accessible page to use as the parent container.
        const searchRes = await fetchWithTimeout('https://api.notion.com/v1/search', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${notionToken}`,
            'Content-Type': 'application/json',
            'Notion-Version': '2022-06-28',
          },
          body: JSON.stringify({
            filter: { property: 'object', value: 'page' },
            page_size: 1,
          }),
        });
        const searchData = await searchRes.json().catch(() => ({}));
        const fallbackParentId = searchData.results?.[0]?.id;
        if (fallbackParentId) {
          parent = { page_id: fallbackParentId };
        } else {
          return apiError(
            'notion',
            'create_page',
            timestamp,
            'Notion API requires a parent page or database to create a new page. Please specify parentPageId or databaseId, or share at least one page with the Notion integration.',
          );
        }
      }

      const bodyPayload: Record<string, any> = {
        parent,
        properties: {
          title: { title: [{ text: { content: title } }] },
        },
      };

      // Optional initial content
      const content = String(payload.content || payload.text || payload.body || '').trim();
      if (content) {
        const lines = content.split('\n').filter((l: string) => l.trim().length > 0);
        bodyPayload.children = lines.map((l: string) => ({
          object: 'block' as const,
          type: 'paragraph' as const,
          paragraph: { rich_text: [{ type: 'text', text: { content: l.slice(0, 2000) } }] },
        }));
      }

      const notionRes = await fetchWithTimeout('https://api.notion.com/v1/pages', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${notionToken}`,
          'Content-Type': 'application/json',
          'Notion-Version': '2022-06-28',
        },
        body: JSON.stringify(bodyPayload),
      });

      if (notionRes.ok) {
        const pageData = await notionRes.json();
        return {
          tool: 'notion',
          action: 'create_page',
          status: 'executed' as const,
          message: `✅ Created Notion page "${title}"`,
          data: { id: pageData.id, url: pageData.url, title, parent },
          timestamp,
        };
      }

      const err = await notionRes.json().catch(() => ({}));
      return apiError('notion', 'create_page', timestamp, `Notion page creation failed: ${err.message || notionRes.statusText || notionRes.status}`);
    }

    // ── 5. Search Workspace Docs ──────────────────────────────────────
    const query = payload.query || '';
    const notionRes = await fetchWithTimeout('https://api.notion.com/v1/search', {
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
      const rawResults = Array.isArray(notionData.results) ? notionData.results : [];
      const formatted = rawResults.map((item: any) => ({
        id: item.id,
        object: item.object,
        title: extractPageTitle(item),
        url: item.url,
        lastEditedTime: item.last_edited_time,
      }));
      return {
        tool: 'notion',
        action: 'search_workspace_docs',
        status: 'executed' as const,
        message: `Searched Notion workspace for: "${query}" — found ${formatted.length} item${formatted.length === 1 ? '' : 's'}`,
        data: { results: formatted, totalResults: formatted.length },
        timestamp,
      };
    }

    const searchErr = await notionRes.json().catch(() => ({}));
    return apiError('notion', 'search_workspace_docs', timestamp, `Notion search failed: ${searchErr.message || notionRes.statusText || notionRes.status}`);
  } catch (e: any) {
    console.error('[Notion] API error:', e.message);
    return apiError('notion', actionName, timestamp, `Notion request error: ${e.message}`);
  }
}

export const notion: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};

