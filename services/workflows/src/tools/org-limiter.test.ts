import test from 'node:test';
import assert from 'node:assert/strict';
import { OrgLimiter } from './org-limiter';

test('a workspace may hold up to the cap and no more', () => {
  const l = new OrgLimiter(2);
  const a = l.tryAcquire('org-a');
  const b = l.tryAcquire('org-a');
  assert.ok(a && b);
  assert.equal(l.tryAcquire('org-a'), null);
  assert.equal(l.active('org-a'), 2);
});

test('one workspace at its cap does not affect another', () => {
  const l = new OrgLimiter(1);
  assert.ok(l.tryAcquire('org-a'));
  assert.equal(l.tryAcquire('org-a'), null);
  assert.ok(l.tryAcquire('org-b'), 'a noisy neighbour must not take another tenant\'s slot');
});

test('releasing frees a slot, and only once', () => {
  const l = new OrgLimiter(1);
  const r = l.tryAcquire('org-a')!;
  r();
  r(); // a double release must not hand out a second slot
  r();
  assert.equal(l.active('org-a'), 0);
  const again = l.tryAcquire('org-a');
  assert.ok(again);
  assert.equal(l.tryAcquire('org-a'), null, 'double release inflated the capacity');
});

test('idle workspaces leave no state behind', () => {
  const l = new OrgLimiter(3);
  const rs = ['a', 'b', 'c'].map((o) => l.tryAcquire(o)!);
  rs.forEach((r) => r());
  assert.equal(l.active('a') + l.active('b') + l.active('c'), 0);
  // The map itself is emptied, so a long-lived worker serving many tenants does not grow without bound.
  assert.equal((l as any).inflight.size, 0);
});
