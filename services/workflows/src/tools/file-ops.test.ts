import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileOps } from './file-ops.js';

test('file_ops requires a valid UUID orgId', async () => {
  const resultMissing = await fileOps.execute({
    tool: 'file_ops',
    action: 'write_file',
    actionName: 'write_file',
    payload: { path: 'test.txt', content: 'hello' },
    orgId: '',
    timestamp: '2026-09-28T00:00:00Z',
  });
  assert.equal(resultMissing.status, 'error');
  assert.match(resultMissing.message, /orgId is required/);

  const resultDefault = await fileOps.execute({
    tool: 'file_ops',
    action: 'write_file',
    actionName: 'write_file',
    payload: { path: 'test.txt', content: 'hello' },
    orgId: 'default',
    timestamp: '2026-09-28T00:00:00Z',
  });
  assert.equal(resultDefault.status, 'error');
  assert.match(resultDefault.message, /orgId is required/);
});

test('file_ops write and read isolated within org dir without leaking host path', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'darex-file-ops-test-'));
  const prevEnv = process.env.WORKSPACE_STORAGE_PATH;
  process.env.WORKSPACE_STORAGE_PATH = tmpDir;

  try {
    const validOrgId = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

    // 1. Write file
    const writeRes = await fileOps.execute({
      tool: 'file_ops',
      action: 'write_file',
      actionName: 'write_file',
      payload: { path: 'notes.txt', content: 'Hello Darex' },
      orgId: validOrgId,
      timestamp: '2026-09-28T00:00:00Z',
    });
    assert.equal(writeRes.status, 'executed');
    assert.equal(writeRes.data?.fileName, 'notes.txt');
    // Ensure absolute filesystem path is not exposed in data
    assert.equal((writeRes.data as any)?.filePath, undefined);

    // 2. Traversal attempt in path strips directory traversal or basename
    const traversalRes = await fileOps.execute({
      tool: 'file_ops',
      action: 'write_file',
      actionName: 'write_file',
      payload: { path: '../../etc/passwd', content: 'malicious' },
      orgId: validOrgId,
      timestamp: '2026-09-28T00:00:00Z',
    });
    // Should either write safe basename "passwd" inside org dir or reject
    assert.equal(traversalRes.status, 'executed');
    assert.equal(traversalRes.data?.fileName, 'passwd');
    const safeOrgDir = path.join(tmpDir, validOrgId);
    const passwdPath = path.join(safeOrgDir, 'passwd');
    const stat = await fs.stat(passwdPath);
    assert.ok(stat.isFile());

    // 3. Read file
    const readRes = await fileOps.execute({
      tool: 'file_ops',
      action: 'read_file',
      actionName: 'read_file',
      payload: { path: 'notes.txt' },
      orgId: validOrgId,
      timestamp: '2026-09-28T00:00:00Z',
    });
    assert.equal(readRes.status, 'executed');
    assert.equal(readRes.data?.content, 'Hello Darex');
  } finally {
    process.env.WORKSPACE_STORAGE_PATH = prevEnv;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
