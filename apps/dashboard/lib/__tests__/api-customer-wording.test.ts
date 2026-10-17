/**
 * Customer screens print what the API routes answer. A route that answers "Temporal is unavailable" or "Nango
 * connection" names a system the customer has never heard of and cannot act on. This scans the route files for
 * the names of internal systems inside string literals. Routes only an administrator or a machine reads are skipped.
 */
import fs from 'node:fs';
import path from 'node:path';

const API = path.resolve(__dirname, '..', '..', 'app', 'api');
const INTERNAL = /(['"`])[^'"`\n]*\b(Temporal|Nango|LiteLLM|Langfuse|TrueForge|Chatwoot|InsightActionWorkflow|ShowingReminderWorkflow)\b[^'"`\n]*\1/;
// Machine-read or administrator-only routes are skipped; identifier fields (provider, workflowName) are not text a person reads.
const SKIP_DIRS = ['platform/', 'health/', 'webhooks/chatwoot/', 'webhooks/nango/'];
const IDENTIFIER_FIELD = /\b(provider|workflowName|workflowId)\s*:/;

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...routeFiles(full));
    else if (e.name === 'route.ts') out.push(full);
  }
  return out;
}

describe('API answers use plain words', () => {
  it('no route string a customer can see names an internal system', () => {
    const offenders: string[] = [];
    for (const file of routeFiles(API)) {
      const rel = path.relative(API, file).split(path.sep).join('/');
      if (SKIP_DIRS.some((d) => rel.startsWith(d))) continue;
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || /console\.(log|warn|error|info)/.test(t) || /^import\b/.test(t) || /throw new Error\(/.test(t)) return;
        if (!IDENTIFIER_FIELD.test(line) && INTERNAL.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
