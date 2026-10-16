import assert from 'node:assert/strict';
import test from 'node:test';
import { sandbox } from './sandbox.js';

test('sandbox down returns an error and does not claim a local process', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const previous = process.env.SANDBOX_API_URL;
  process.env.SANDBOX_API_URL = 'http://127.0.0.1:9';
  try {
    const result = await sandbox.execute({
      tool: 'sandbox',
      action: 'python_execute',
      actionName: 'python_execute',
      payload: { code: 'print(1)', language: 'python' },
      orgId: '00000000-0000-4000-8000-000000000001',
      timestamp: new Date().toISOString(),
    });
    assert.equal(result.status, 'error');
    const blob = JSON.stringify(result);
    assert.equal(blob.includes('local_process'), false);
    assert.equal(blob.includes('Executed'), false);
    assert.match(result.message, /not run on the host/i);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.SANDBOX_API_URL;
    else process.env.SANDBOX_API_URL = previous;
  }
});

test('code execution is confirm-class for every sandbox alias', async () => {
  const { resolveToolRisk } = await import('./index.js');
  for (const tool of ['sandbox', 'code_execution', 'terminal_run_command', 'python_execute', 'bash_execute']) {
    const risk = resolveToolRisk(tool, 'python_execute');
    assert.equal(risk?.risk, 'execute', tool);
    assert.equal(risk?.confirm, true, tool);
  }
});

test('per-tenant concurrency limit prevents tenant starvation (RT-S01)', async () => {
  const original = globalThis.fetch;
  let capturedHeaders: Record<string, string> | null = null;
  let capturedBody: any = null;

  let holdResponses = true;
  const resolvers: (() => void)[] = [];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedHeaders = (init?.headers as Record<string, string>) || {};
    capturedBody = JSON.parse((init?.body as string) || '{}');
    if (holdResponses) {
      await new Promise<void>((r) => {
        resolvers.push(r);
      });
    }
    return new Response(JSON.stringify({ result: { ok: true, stdout: 'ok', exitCode: 0 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;

  const orgA = '00000000-0000-4000-8000-00000000000a';
  const orgB = '00000000-0000-4000-8000-00000000000b';

  try {
    // Launch run 1 for Org A (pending)
    const run1 = sandbox.execute({
      tool: 'sandbox',
      action: 'python_execute',
      actionName: 'python_execute',
      payload: { code: 'print(1)' },
      orgId: orgA,
      timestamp: new Date().toISOString(),
    });

    // Wait a tick for run1 to start
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(capturedHeaders?.['x-org-id'], orgA);
    assert.equal(capturedBody?.orgId, orgA);

    // Launch run 2 for Org A (pending)
    const run2 = sandbox.execute({
      tool: 'sandbox',
      action: 'python_execute',
      actionName: 'python_execute',
      payload: { code: 'print(2)' },
      orgId: orgA,
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 10));

    // Run 3 for Org A should be immediately rejected with tenant concurrency limit
    const run3 = await sandbox.execute({
      tool: 'sandbox',
      action: 'python_execute',
      actionName: 'python_execute',
      payload: { code: 'print(3)' },
      orgId: orgA,
      timestamp: new Date().toISOString(),
    });
    assert.equal(run3.status, 'error');
    assert.match(run3.message, /concurrency limit reached/i);
    assert.equal(run3.data?.error, 'tenant_concurrency_limit');

    // Run for Org B should NOT be blocked by Org A's in-flight runs!
    const runOrgB = sandbox.execute({
      tool: 'sandbox',
      action: 'python_execute',
      actionName: 'python_execute',
      payload: { code: 'print("orgB")' },
      orgId: orgB,
      timestamp: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 10));

    // Release all in-flight runs
    holdResponses = false;
    resolvers.splice(0).forEach((r) => r());
    const [res1, res2, resB] = await Promise.all([run1, run2, runOrgB]);
    assert.equal(res1.status, 'executed');
    assert.equal(res2.status, 'executed');
    assert.equal(resB.status, 'executed');

    // After completion, Org A can execute again
    const run4 = await sandbox.execute({
      tool: 'sandbox',
      action: 'python_execute',
      actionName: 'python_execute',
      payload: { code: 'print(4)' },
      orgId: orgA,
      timestamp: new Date().toISOString(),
    });
    assert.equal(run4.status, 'executed');
  } finally {
    globalThis.fetch = original;
  }
});

