import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The single gate for side effects is executeAutonomousToolAction (tool-executor.ts). A call to executeProvider from
 * anywhere else reaches a provider without the approval, stage, kill-switch and audit checks. Each call outside the gate
 * is listed here with the reason it is acceptable; a new one fails this test until someone reads it and adds a line.
 *
 * Provider calls that read are listed as "read"; calls that post to the owner's own Slack or WhatsApp are "owner".
 * Nothing here may send to a customer.
 */
const SRC = path.resolve(__dirname, '..', 'src');
const ALLOWED: Record<string, { calls: number; kind: 'read' | 'owner'; why: string }> = {
  'customer/account-profile.ts': { calls: 3, kind: 'read', why: 'HubSpot, Stripe and Zendesk lookups for a customer profile; no write' },
  'autonomy.ts': { calls: 1, kind: 'owner', why: 'posts an approval card to the manager Slack channel; the approval itself is still required' },
  'activities/open-loop-sweep.ts': { calls: 2, kind: 'owner', why: 'delivers the morning brief to the owner\'s own Slack and ops WhatsApp number' },
  'activities/customer.ts': { calls: 1, kind: 'owner', why: 'churn-risk alert to the manager Slack channel' },
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

export function countProviderCalls(source: string): number {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return (stripped.match(/\bexecuteProvider\s*\(/g) || []).length;
}

test('every executeProvider call outside the gate is listed with a reason', () => {
  const found: Record<string, number> = {};
  for (const file of sourceFiles(SRC)) {
    const rel = path.relative(SRC, file).split(path.sep).join('/');
    if (rel === 'tool-executor.ts' || rel === 'tools/index.ts') continue; // the gate and the function's own definition
    const n = countProviderCalls(fs.readFileSync(file, 'utf8'));
    if (n > 0) found[rel] = n;
  }
  const unlisted = Object.keys(found).filter((f) => !ALLOWED[f]);
  assert.deepEqual(unlisted, [], `provider call outside the gate in: ${unlisted.join(', ')}. Route it through executeAutonomousToolAction, or list it here with a reason.`);
  for (const [file, spec] of Object.entries(ALLOWED)) {
    assert.equal(found[file] ?? 0, spec.calls, `${file}: expected ${spec.calls} call(s) (${spec.why}), found ${found[file] ?? 0}`);
  }
});

test('the counter sees a call and ignores comments', () => {
  assert.equal(countProviderCalls('await executeProvider({ tool: "gmail" });'), 1);
  assert.equal(countProviderCalls('// executeProvider(x)\n/* executeProvider(y) */'), 0);
  assert.equal(countProviderCalls('const a = executeProvider ( z ); executeProvider(w)'), 2);
});
