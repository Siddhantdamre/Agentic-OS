/**
 * Lexical guard for SQL a MODEL wrote.
 *
 * WHY THIS EXISTS
 * `database_query` used to accept anything that started with `select` or
 * `with` and contained no `;`. Against a real Postgres, acting as one tenant
 * through the compiled tool, that let a single statement:
 *
 *   - delete the tenant's own rows:
 *       WITH d AS (DELETE FROM messages RETURNING content) SELECT * FROM d
 *   - read another tenant's rows, because row-level security keys off the
 *     session setting `app.current_org_id` and user SQL can set it:
 *       WITH s AS MATERIALIZED (SELECT set_config('app.current_org_id', '<other>', false))
 *       SELECT m.content FROM s, messages m
 *   - read another tenant's password hash by calling a SECURITY DEFINER
 *     helper, which bypasses RLS by design and is executable by the app role:
 *       SELECT * FROM auth_lookup_user_by_email('<victim>')
 *   - run for as long as it liked.
 *
 * The tool is an always-allowed core tool with risk `read`, so no confirm gate
 * stands in front of it, and its input arrives from a model that has read
 * inbound customer messages. This is prompt injection with a database behind it.
 *
 * WHAT THIS IS, AND IS NOT
 * A denylist over a tokenised statement. It fails closed: anything it cannot
 * classify is refused. It is DEFENCE IN DEPTH, not a proof — the transaction is
 * also READ ONLY with a statement timeout (see database.ts), so Postgres itself
 * refuses writes even if this file is ever evaded. What neither layer can do is
 * stop `set_config` from re-pointing RLS if a spelling of it slips through; the
 * structural answer is the dedicated role `darex_sql_reader` (migration 207),
 * which has no EXECUTE on `set_config` or on any SECURITY DEFINER function.
 * database.ts runs every statement as that role, so this file is the first
 * layer of three, not the only one.
 *
 * WHY A TOKENISER AND NOT A REGEX OVER THE TEXT
 * `"Set_Config"(...)`, `pg_catalog.set_config(...)`, and a keyword split by an
 * inline comment are all the same call to a database and different strings to
 * a regex. The scanner below removes string literals, unquotes identifiers and
 * refuses comments before it looks at a single word, so what it checks is what
 * Postgres runs.
 */

export interface GuardOptions {
  /**
   * Extra function names to refuse when they are CALLED. database.ts passes
   * every SECURITY DEFINER function in the live catalog, so a helper added by a
   * future migration is blocked without anyone remembering to edit this file.
   */
  deniedFunctions?: Iterable<string>;
}

/**
 * `ok` true carries the statement to run; false carries a reason. An interface
 * rather than a discriminated union because this package compiles with
 * `strict: false`, where a union on a boolean does not narrow.
 */
export interface GuardResult {
  ok: boolean;
  sql?: string;
  reason?: string;
}

/** Refused wherever they appear: words that turn a read into a write, a lock or a table. */
const DENIED_WORDS = new Set([
  'insert', 'update', 'delete', 'merge',
  // SELECT ... INTO creates a table; FOR UPDATE / FOR SHARE take row locks.
  'into',
  // Sequence functions mutate state. READ ONLY refuses them too.
  'nextval', 'setval',
  // Re-points the RLS session variable (see above), or changes any setting the
  // transaction's own limits rely on.
  'set_config',
  // Executes SQL text it is handed, so it sees none of the checks in this file.
  'ts_stat',
]);

/**
 * Refused wherever they appear. `pg_` covers pg_sleep, pg_read_file,
 * pg_terminate_backend and the catalog views; pg_stat_activity in particular
 * shows the text of other tenants' in-flight queries, because every tenant
 * shares one database role.
 */
const DENIED_PREFIXES = ['pg_'];

/**
 * Refused only when CALLED (followed by `(`): large-object functions, dblink and
 * crosstab. A tenant column such as `lo_reason` shares the prefix and stays readable.
 */
const DENIED_CALL_ONLY_PREFIXES = ['lo_', 'dblink', 'crosstab'];

/** query_to_xml, table_to_xml, cursor_to_xml, ...: each executes a SQL string. */
const DENIED_PATTERNS = [/^(query|cursor|table|schema|database)_to_xml/];

/**
 * Refused only when CALLED (followed by `(`). These are the SECURITY DEFINER
 * doors: they bypass RLS on purpose, for flows that have no tenant yet (login,
 * webhook routing, billing). A table that merely shares the prefix —
 * `billing_meters` — is an ordinary tenant table and stays readable.
 */
const DENIED_CALL_PREFIXES = ['auth_', 'billing_', 'resolve_', 'org_provision', 'org_resolve_'];

const FIRST_WORDS = new Set(['select', 'with']);

type Token = { kind: 'word' | 'quoted' | 'string' | 'punct'; value: string };

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c) || c.charCodeAt(0) >= 0x80;
const isIdentPart = (c: string) => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) >= 0x80;

class Refusal extends Error {}

function tokenise(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (c.charCodeAt(0) < 0x20) throw new Refusal('control characters are not permitted');

    if (c === '-' && sql[i + 1] === '-') throw new Refusal('comments are not permitted');
    if (c === '/' && sql[i + 1] === '*') throw new Refusal('comments are not permitted');
    if (c === ';') throw new Refusal('only a single statement is permitted');
    if (c === '$') throw new Refusal('dollar quoting and positional parameters are not permitted');
    if (c === '\\') throw new Refusal('backslash escapes are not permitted');

    if (c === "'") {
      // E'..' and U&'..' give backslash escapes meaning, which is how a
      // keyword gets written without appearing in the text. Standard strings
      // do not, so the only thing to do with the prefixed forms is refuse.
      const before = sql[i - 1];
      const beforeThat = sql[i - 2];
      if ((before === 'e' || before === 'E') && !(beforeThat && isIdentPart(beforeThat))) {
        throw new Refusal('E-strings are not permitted');
      }
      if (before === '&' && (beforeThat === 'u' || beforeThat === 'U')) {
        throw new Refusal('unicode escape strings are not permitted');
      }
      i++;
      let s = '';
      for (;;) {
        if (i >= n) throw new Refusal('unterminated string literal');
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { s += "'"; i += 2; continue; }
          i++;
          break;
        }
        s += sql[i++];
      }
      out.push({ kind: 'string', value: s });
      continue;
    }

    if (c === '"') {
      if (sql[i - 1] === '&' && (sql[i - 2] === 'u' || sql[i - 2] === 'U')) {
        throw new Refusal('unicode escape identifiers are not permitted');
      }
      i++;
      let s = '';
      for (;;) {
        if (i >= n) throw new Refusal('unterminated quoted identifier');
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { s += '"'; i += 2; continue; }
          i++;
          break;
        }
        s += sql[i++];
      }
      if (s.length === 0) throw new Refusal('empty quoted identifier');
      out.push({ kind: 'quoted', value: s });
      continue;
    }

    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(sql[j])) j++;
      out.push({ kind: 'word', value: sql.slice(i, j) });
      i = j;
      continue;
    }

    out.push({ kind: 'punct', value: c });
    i++;
  }
  return out;
}

function deniedReason(name: string, isCall: boolean, extra: Set<string>): string | null {
  const w = name.toLowerCase();
  if (DENIED_WORDS.has(w)) return `"${w}" is not permitted in a read-only query`;
  for (const p of DENIED_PREFIXES) {
    if (w.startsWith(p)) return `"${w}" is not permitted (${p}* is reserved for the platform)`;
  }
  for (const re of DENIED_PATTERNS) {
    if (re.test(w)) return `"${w}" executes SQL text and is not permitted`;
  }
  if (isCall) {
    for (const p of DENIED_CALL_ONLY_PREFIXES) {
      if (w.startsWith(p)) return `"${w}" is not permitted (${p}* is reserved for the platform)`;
    }
    for (const p of DENIED_CALL_PREFIXES) {
      if (w.startsWith(p)) return `"${w}" is a privileged platform function and is not permitted`;
    }
    if (extra.has(w)) return `"${w}" is a privileged database function and is not permitted`;
  }
  return null;
}

/**
 * Decide whether a model-written statement may run at all.
 * On success returns the trimmed statement; on failure a reason the model and
 * the operator can both read.
 */
export function checkReadOnlySql(raw: unknown, opts: GuardOptions = {}): GuardResult {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'SQL query is required and must start with SELECT or WITH' };
  }
  // Models very often end a statement with ';'. One trailing semicolon is not a second statement,
  // so drop it here; any other ';' is still refused by the tokeniser. What is returned (and run)
  // is the statement without it, which database.ts wraps in a subquery.
  const sql = raw.trim().replace(/;\s*$/, '').trim();
  if (sql === '') return { ok: false, reason: 'SQL query is required and must start with SELECT or WITH' };
  const extra = new Set<string>();
  for (const f of opts.deniedFunctions ?? []) extra.add(String(f).toLowerCase());

  let tokens: Token[];
  try {
    tokens = tokenise(sql);
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message };
    throw e;
  }

  const first = tokens[0];
  if (!first || first.kind !== 'word' || !FIRST_WORDS.has(first.value.toLowerCase())) {
    return { ok: false, reason: 'SQL query must be a single statement that starts with SELECT or WITH' };
  }

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.kind !== 'word' && t.kind !== 'quoted') continue;
    const next = tokens[k + 1];
    const isCall = !!next && next.kind === 'punct' && next.value === '(';
    const why = deniedReason(t.value, isCall, extra);
    if (why) return { ok: false, reason: why };
  }

  return { ok: true, sql };
}
