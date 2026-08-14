import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk } from './shared.js';

const ACTIONS = ['extract'] as const;

function riskFor(_action: string): ToolRisk {
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { payload, timestamp } = ctx;
  const url = payload.url || payload.link;
  if (!url) {
    return { tool: 'web_extract', action: 'extract', status: 'error' as const, message: 'URL parameter is required', data: null, timestamp };
  }
  console.log(`[Web Extract Tool] Extracting web content via Jina from ${url}...`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const readerHeaders: Record<string, string> = { 'Accept': 'text/plain' };
    const jinaKey = process.env.JINA_API_KEY || process.env.JINA_READ_API_KEY;
    if (jinaKey) readerHeaders['Authorization'] = `Bearer ${jinaKey}`;
    const pageRes = await fetch(`https://r.jina.ai/${encodeURIComponent(url)}`, {
      headers: readerHeaders,
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!pageRes.ok) throw new Error(`Jina Reader API failed: ${pageRes.statusText}`);
    const rawText = await pageRes.text();
    const cleanText = rawText.slice(0, 8000); // Allow more Markdown text

    return {
      tool: 'web_extract',
      action: 'extract',
      status: 'executed' as const,
      message: `Extracted ${cleanText.length} characters of clean text from ${url}`,
      data: { url, content: cleanText },
      timestamp,
    };
  } catch (err: any) {
    clearTimeout(timeout);
    return { tool: 'web_extract', action: 'extract', status: 'error' as const, message: `Failed to extract URL: ${err.message}`, data: null, timestamp };
  }
}

export const webExtract: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
