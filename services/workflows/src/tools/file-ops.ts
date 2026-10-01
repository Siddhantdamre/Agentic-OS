import fs from 'fs/promises';
import path from 'path';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk } from './shared.js';

const ACTIONS = ['read_file', 'write_file'] as const;
const MAX_WRITE_BYTES = 256 * 1024; // 256KB
const MAX_READ_BYTES = 256 * 1024;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('write') || a.includes('create')) return 'draft';
  return 'read';
}

function errResult(timestamp: string, message: string) {
  return {
    tool: 'file_ops',
    action: 'read_file',
    status: 'error' as const,
    message,
    data: null,
    timestamp,
  };
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  try {
    const fileAction = String(actionName || payload.fileAction || 'read');
    const rawPath = String(payload.path || payload.filePath || 'notes.txt');
    // basename strips directories -> prevents ../ traversal and silently
    // colliding a/b.txt with b.txt is now explicit in the returned fileName.
    const fileName = path.basename(rawPath);
    if (!fileName || fileName === '.' || fileName === '..') {
      return errResult(timestamp, 'Invalid file name');
    }
    const storageRoot =
      process.env.WORKSPACE_STORAGE_PATH || path.resolve(process.cwd(), 'workspace_storage');
    if (!orgId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
      return errResult(timestamp, 'orgId is required');
    }
    const baseDir = path.resolve(storageRoot, orgId);

    await fs.mkdir(baseDir, { recursive: true });

    const safePath = path.join(baseDir, fileName);
    // Belt-and-braces: resolved path must stay inside the org dir.
    if (!safePath.startsWith(baseDir + path.sep) && safePath !== path.join(baseDir, fileName)) {
      return errResult(timestamp, 'Invalid file path');
    }

    if (fileAction.includes('write') || fileAction.includes('create')) {
      const content = String(payload.content ?? payload.text ?? '');
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
        return errResult(timestamp, `Content too large — max ${MAX_WRITE_BYTES} bytes`);
      }
      await fs.writeFile(safePath, content, 'utf8');
      return {
        tool: 'file_ops',
        action: 'write_file',
        status: 'executed' as const,
        message: `✅ Created file ${fileName} (${content.length} bytes)`,
        data: { fileName, size: content.length },
        timestamp,
      };
    } else {
      let content: string;
      try {
        const stat = await fs.stat(safePath);
        if (stat.size > MAX_READ_BYTES) {
          return errResult(timestamp, `File too large to read — max ${MAX_READ_BYTES} bytes`);
        }
        content = await fs.readFile(safePath, 'utf8');
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return errResult(timestamp, `File ${fileName} does not exist in workspace`);
        }
        throw e;
      }
      const sliced = content.length > 50000 ? content.slice(0, 50000) : content;
      return {
        tool: 'file_ops',
        action: 'read_file',
        status: 'executed' as const,
        message: `Read ${content.length} characters from ${fileName}${content.length > sliced.length ? ' (truncated)' : ''}`,
        data: { fileName, content: sliced },
        timestamp,
      };
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'file operation failed';
    return errResult(timestamp, `File operation failed: ${message.slice(0, 300)}`);
  }
}

export const fileOps: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
