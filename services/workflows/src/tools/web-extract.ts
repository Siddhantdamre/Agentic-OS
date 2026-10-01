import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk } from './shared.js';
import { assertPublicUrl, safeGet, UnsafeUrlError } from './safe-url.js';

const ACTIONS = ['extract'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function extractDirectHtml(url: string, limit = 8000): Promise<string> {
  try {
    const res = await safeGet(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
      timeoutMs: 10000,
    });
    if (!res.ok) return '';
    return res.body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit);
  } catch (err) {
    console.warn(`[Web Extract Tool] Direct fetch of ${url} failed: ${(err as Error).message}`);
    return '';
  }
}

async function execute(ctx: ToolActionContext) {
  const { timestamp } = ctx;
  const payload = (ctx?.payload || (ctx as any)?.params || {}) as Record<string, any>;
  const url = String(payload.url || payload.link || (ctx as any)?.url || '').trim();
  if (!url) {
    return { tool: 'web_extract', action: 'extract', status: 'error' as const, message: 'URL parameter is required', data: null, timestamp };
  }

  try {
    await assertPublicUrl(String(url));
  } catch (err) {
    return {
      tool: 'web_extract',
      action: 'extract',
      status: 'error' as const,
      message: `Security Policy: ${err instanceof UnsafeUrlError ? err.message : 'Invalid or non-public URL'}`,
      data: null,
      timestamp,
    };
  }

  const jinaKey = process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY;
  if (jinaKey) {
    try {
      console.log(`[Web Extract Tool] Extracting web content via Jina from ${url}...`);
      const jinaUrl = `https://r.jina.ai/${encodeURIComponent(url)}`;
      const pageRes = await safeGet(jinaUrl, {
        headers: { 'Accept': 'text/plain', 'Authorization': `Bearer ${jinaKey}` },
        timeoutMs: 12000,
        maxBytes: 5 * 1024 * 1024,
      });
      if (pageRes.ok) {
        const cleanText = pageRes.body.slice(0, 8000);
        return {
          tool: 'web_extract',
          action: 'extract',
          status: 'executed' as const,
          message: `Extracted ${cleanText.length} characters of clean text from ${url}`,
          data: { url, content: cleanText },
          timestamp,
        };
      }
    } catch {
      // fall through to direct HTML extract
    }
  }

  // Fallback to direct HTML extract (zero API key required)
  console.log(`[Web Extract Tool] Extracting web content directly from ${url}...`);
  const directText = await extractDirectHtml(url, 8000);
  if (directText.length > 0) {
    return {
      tool: 'web_extract',
      action: 'extract',
      status: 'executed' as const,
      message: `Extracted ${directText.length} characters of clean text from ${url}`,
      data: { url, content: directText },
      timestamp,
    };
  }

  return { tool: 'web_extract', action: 'extract', status: 'error' as const, message: `Failed to extract URL content from ${url}`, data: null, timestamp };
}

export const webExtract: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
