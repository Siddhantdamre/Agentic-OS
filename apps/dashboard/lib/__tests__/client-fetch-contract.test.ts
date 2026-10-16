/**
 * @jest-environment node
 *
 * Every `fetch` a customer's click can start must say what happens when the connection drops.
 *
 * An unguarded `await fetch(...)` in a click handler does three bad things at once: the browser logs an
 * unhandled promise rejection, the button stays on its spinner or greyed out, and the person is told nothing.
 * Measured on this codebase before the fix: 16 of 164 client-side fetch calls were unguarded, including the
 * onboarding steps, password reset and team invites. This test scans every client file (`'use client'`) and
 * fails on a `fetch` that is neither inside `try { } catch`, nor part of a promise chain with `.catch`.
 */
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.join(__dirname, '..', '..');
const SCANNED = ['app/(auth)', 'app/(dashboard)', 'app/(onboarding)', 'components', 'lib', 'hooks'];

/** file -> reason. Keep this list empty if you can. */
const ALLOWED: Record<string, string> = {
  'app/(dashboard)/observability/page.tsx': '`getJson` is a helper that throws on purpose; every caller adds `.catch` (see observability tests).',
};

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function isGuarded(call: ts.CallExpression): boolean {
  let p: ts.Node | undefined = call.parent;
  while (p && !ts.isSourceFile(p)) {
    if (ts.isTryStatement(p) && p.catchClause) {
      let q: ts.Node | undefined = call;
      while (q && q !== p.tryBlock && q !== p) q = q.parent;
      if (q === p.tryBlock) return true;
    }
    if (ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression)) {
      const name = p.expression.name.text;
      if (name === 'catch') return true;
      if (name === 'then' && p.arguments.length >= 2) return true;
    }
    if (ts.isFunctionLike(p)) {
      // Keep climbing only when this function is a `.then`/`.finally` callback of the same chain.
      const parent = p.parent;
      const inChain =
        parent && ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression) && ['then', 'finally'].includes(parent.expression.name.text);
      if (!inChain) return false;
    }
    p = p.parent;
  }
  return false;
}

function scan() {
  const unguarded: string[] = [];
  let total = 0;
  for (const dir of SCANNED) {
    for (const abs of walk(path.join(ROOT, dir))) {
      const src = fs.readFileSync(abs, 'utf8');
      if (!/^['"]use client['"]/m.test(src.slice(0, 200))) continue;
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      const sf = ts.createSourceFile(abs, src, ts.ScriptTarget.Latest, true, abs.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && n.expression.getText() === 'fetch') {
          total++;
          if (!isGuarded(n)) unguarded.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`);
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
  }
  return { unguarded, total };
}

const { unguarded, total } = scan();
const allowedFiles = new Set(Object.keys(ALLOWED));

describe('client fetch calls', () => {
  it('scans a meaningful number of calls (the scan is not silently empty)', () => {
    expect(total).toBeGreaterThan(100);
  });

  it('recognises an unguarded call (the scanner works)', () => {
    const sf = ts.createSourceFile('x.ts', 'async function f(){ await fetch("/a"); }\nasync function g(){ try { await fetch("/b"); } catch {} }\nfetch("/c").then(r=>r).catch(()=>0);', ts.ScriptTarget.Latest, true);
    const results: boolean[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && n.expression.getText() === 'fetch') results.push(isGuarded(n));
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(results).toEqual([false, true, true]);
  });

  it('guards every fetch against a dropped connection', () => {
    const bad = unguarded.filter((u) => !allowedFiles.has(u.replace(/:\d+$/, '')));
    expect(bad).toEqual([]);
  });

  it('keeps the allow-list honest: every entry still has an unguarded call', () => {
    const stale = [...allowedFiles].filter((f) => !unguarded.some((u) => u.startsWith(`${f}:`)));
    expect(stale).toEqual([]);
  });
});
