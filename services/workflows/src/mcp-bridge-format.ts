import { sanitizeToolOutput } from './guardrails/tool-sanitizer.js';

/** Bound MCP payloads so a 27-file Drive dump can't blow the turn context. */
const MAX_BRIDGE_RESULT_CHARS = parseInt(process.env.MCP_BRIDGE_MAX_RESULT_CHARS || '20000', 10);

export function formatResult(result: any): string {
  const data = result?.data ?? null;
  let text = JSON.stringify(
    {
      status: result?.status,
      message: result?.message,
      data,
      connected: data?.connected,
      setupUrl: data?.setupUrl,
      configured: data?.configured,
    },
    null,
    2
  );
  const cap = Number.isFinite(MAX_BRIDGE_RESULT_CHARS) && MAX_BRIDGE_RESULT_CHARS > 0
    ? MAX_BRIDGE_RESULT_CHARS : 20000;
  if (text.length > cap) {
    const truncated = text.slice(0, cap);
    text = truncated.slice(0, truncated.lastIndexOf('\n')) +
      `\n...[truncated ${text.length - cap} chars: refine the query or page]...`;
  }
  return sanitizeToolOutput(text);
}
