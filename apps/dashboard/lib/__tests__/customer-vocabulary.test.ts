/**
 * @jest-environment node
 *
 * A new customer reads this product in plain business language. They must not meet the names of our
 * internal parts ("Nango", "Temporal", "RLS", "Postgres", "payload") on the screens they use every day.
 *
 * This test reads the source of every customer-facing screen — sign-in, onboarding, the dashboard and the
 * shared components — and collects only the words a person can SEE: JSX text, labels, placeholders,
 * titles, `desc:`/`label:` style properties, and the messages passed to `setError(...)` / `new Error(...)`.
 * Identifiers, imports, class names and URLs are ignored, so it cannot fail on code.
 *
 * The operator console under app/(platform) is for our own staff and is deliberately not scanned.
 *
 * A few words are unavoidable where the customer must copy a value into somebody else's screen
 * (a webhook URL pasted into Meta's console). Those are listed in ALLOWED with the reason. The list is
 * kept honest in both directions: a new hit fails the test, and an entry that no longer matches anything
 * fails it too, so the list can only shrink.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.join(__dirname, '..', '..');
const SCANNED = ['app/(auth)', 'app/(dashboard)', 'app/(onboarding)', 'components'];

const VISIBLE_ATTRS = new Set(['placeholder', 'title', 'aria-label', 'alt', 'label', 'description', 'helperText', 'subtitle', 'tooltip', 'hint']);
const VISIBLE_PROPS = new Set([
  'desc', 'description', 'label', 'title', 'subtitle', 'message', 'hint', 'copy', 'tagline', 'heading',
  'text', 'body', 'cta', 'name', 'summary', 'blurb', 'caption', 'error', 'emptyMessage',
]);
const VISIBLE_CALLS = /^(set\w*(Error|Message|Note|Notice|Status|Success|Hint|Warning)|toast(\.\w+)?)$/;

const BANNED =
  /\b(OAuth|database_query|web_search|web_extract|file_ops|mcp\.[\w-]+|dev-?ese|SoR|org-union|Nango|TrueForge|Temporal|Chatwoot|LiteLLM|Langfuse|SuperTokens|pgvector|embeddings?|RLS|MCP|JWT|webhooks?|payloads?|endpoints?|tenants?|idempoten\w*|cron|Redis|Postgres|pending row|seeds? a|Cloud API|orchestrat\w+|vector (store|db|database)|SDK|schema|stack trace|undefined|notConnected|from env|env vars?|\(unset\)|Phase \d|self-hosted stack|localhost:\d+|\[object)\b|\(unset\)|localhost:\d+/i;

/** A setting's name such as DAREX_ALERT_WEBHOOK_URL: it means something to whoever deploys us, nothing to a customer. */
const SETTING_NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){1,}\b/;

/** file (relative, posix) -> terms that may appear there, with the reason. */
const ALLOWED: Array<{ file: string; term: RegExp; reason: string }> = [
  {
    file: 'app/(dashboard)/settings/page.tsx',
    term: /webhooks?|Chatwoot|endpoints?/i,
    reason: 'Settings → Webhooks: the customer copies these URLs into Meta/Chatwoot, whose own screens say "webhook".',
  },
  {
    file: 'app/(dashboard)/connectors/[id]/page.tsx',
    term: /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/,
    reason: 'The "Settings your administrator needs to provide" list names the exact settings the person who runs the install must set; it is headed as such.',
  },
  {
    file: 'components/re/SchedulePanel.tsx',
    term: /tenant/i,
    reason: 'Real estate: "tenant" is the person renting the property.',
  },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** The fixed words inside an expression: a literal, a template (its fixed parts), either side of `a ? b : c`, `a || b` or `a + b`. */
function texts(n: ts.Node | undefined): string[] {
  if (!n) return [];
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return [n.text];
  if (ts.isTemplateExpression(n)) return [[n.head.text, ...n.templateSpans.map((sp) => sp.literal.text)].join(' ')];
  if (ts.isParenthesizedExpression(n)) return texts(n.expression);
  if (ts.isConditionalExpression(n)) return [...texts(n.whenTrue), ...texts(n.whenFalse)];
  if (ts.isBinaryExpression(n) && ['||', '??', '+', '&&'].includes(n.operatorToken.getText())) return [...texts(n.left), ...texts(n.right)];
  return [];
}

type Hit = { file: string; line: number; term: string; text: string };

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const dir of SCANNED) {
    for (const abs of walk(path.join(ROOT, dir))) {
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const add = (node: ts.Node, raw: string) => {
        const text = raw.replace(/\s+/g, ' ').trim();
        const m = text.match(BANNED) ?? text.match(SETTING_NAME);
        if (!m) return;
        hits.push({ file: rel, line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1, term: m[0], text: text.slice(0, 100) });
      };
      const visit = (n: ts.Node): void => {
        if (ts.isJsxText(n)) {
          add(n, n.getText());
        } else if (ts.isJsxAttribute(n) && n.initializer && VISIBLE_ATTRS.has(n.name.getText())) {
          const init = n.initializer;
          for (const t of ts.isJsxExpression(init) ? texts(init.expression) : texts(init)) add(init, t);
        } else if (ts.isPropertyAssignment(n) && VISIBLE_PROPS.has(n.name.getText().replace(/['"]/g, ''))) {
          for (const t of texts(n.initializer)) add(n.initializer, t);
        } else if (ts.isJsxExpression(n) && n.expression && !ts.isJsxAttribute(n.parent)) {
          for (const t of texts(n.expression)) add(n.expression, t);
        } else if (ts.isCallExpression(n) && VISIBLE_CALLS.test(n.expression.getText())) {
          for (const a of n.arguments) for (const t of texts(a)) add(a, t);
        } else if (ts.isReturnStatement(n) && n.expression) {
          for (const t of texts(n.expression)) add(n.expression, t); // label helpers: `return 'Disconnected (notConnected)'`
        } else if (ts.isNewExpression(n) && n.expression.getText() === 'Error') {
          for (const a of n.arguments ?? []) for (const t of texts(a)) add(a, t);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  return hits;
}

const hits = scan();
const allowedFor = (h: Hit) => ALLOWED.some((a) => a.file === h.file && a.term.test(h.term));

describe('customer-facing wording', () => {
  it('scans a meaningful number of screens (the scan itself is not silently empty)', () => {
    const files = SCANNED.flatMap((d) => walk(path.join(ROOT, d)));
    expect(files.length).toBeGreaterThan(40);
  });

  it('catches a developer term when one is written (the scanner works)', () => {
    const probe = ts.createSourceFile('x.tsx', '<p>Powered by Nango and Temporal</p>', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let seen = '';
    const visit = (n: ts.Node): void => {
      if (ts.isJsxText(n)) seen += n.getText();
      ts.forEachChild(n, visit);
    };
    visit(probe);
    expect(seen).toMatch(BANNED);
  });

  it('shows no internal vendor, infrastructure or protocol names to customers', () => {
    const unexpected = hits.filter((h) => !allowedFor(h));
    expect(unexpected.map((h) => `${h.file}:${h.line}  [${h.term}]  ${h.text}`)).toEqual([]);
  });

  it('keeps the allow-list honest: every entry still matches something', () => {
    const stale = ALLOWED.filter((a) => !hits.some((h) => h.file === a.file && a.term.test(h.term)));
    expect(stale.map((a) => `${a.file} — ${a.reason}`)).toEqual([]);
  });
});
