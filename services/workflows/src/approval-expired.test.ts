import test from 'node:test';
import assert from 'node:assert/strict';

// A chat approval card lives in the server that asked for it. After a restart the session is gone and the
// fallback sidecar is not there either. The person must be told the card expired and nothing was run, not
// pointed at Decisions (no row exists there) and not shown a bare "fetch failed".
test('resuming a session nobody remembers fails with a named, plain error', async () => {
  process.env.TRUEFORGE_URL = 'http://127.0.0.1:1';
  const { resumeTrueForgeTurn } = await import('./trueforge-client.js');
  await assert.rejects(
    () => resumeTrueForgeTurn({
      sessionId: '11111111-2222-4333-8444-555555555555',
      orgId: '00000000-0000-4000-8000-0000000000c9',
      userId: '00000000-0000-4000-8000-0000000000d1',
      toolAllowlist: [],
      decisions: [{ threadId: 'darex-local:x:y', toolCallId: 'call_1', decision: 'allow' }],
    }, { timeoutMs: 3000 }),
    (err: unknown) => err instanceof Error && err.name === 'ApprovalExpiredError',
  );
});
