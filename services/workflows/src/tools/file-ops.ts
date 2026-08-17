import fs from 'fs';
import path from 'path';
import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { confirmFromRisk } from './shared.js';

const ACTIONS = ['read_file', 'write_file'] as const;

function riskFor(action: string): ToolRisk {
  const a = action.toLowerCase();
  if (a.includes('write') || a.includes('create')) return 'draft';
  return 'read';
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, orgId, timestamp } = ctx;
  const fileAction = actionName || payload.fileAction || 'read';
  const filePath = payload.path || payload.filePath || 'notes.txt';
  const baseDir = path.resolve(process.cwd(), 'workspace_storage', orgId || 'default');

  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const safePath = path.join(baseDir, path.basename(filePath));

  if (fileAction.includes('write') || fileAction.includes('create')) {
    const content = payload.content || payload.text || '';
    fs.writeFileSync(safePath, content, 'utf8');
    return {
      tool: 'file_ops',
      action: 'write_file',
      status: 'executed' as const,
      message: `✅ Created file ${path.basename(filePath)} (${content.length} bytes)`,
      data: { filePath: safePath, fileName: path.basename(filePath), size: content.length },
      timestamp,
    };
  } else {
    if (fs.existsSync(safePath)) {
      const content = fs.readFileSync(safePath, 'utf8');
      return {
        tool: 'file_ops',
        action: 'read_file',
        status: 'executed' as const,
        message: `Read ${content.length} characters from ${path.basename(filePath)}`,
        data: { fileName: path.basename(filePath), content },
        timestamp,
      };
    } else {
      return {
        tool: 'file_ops',
        action: 'read_file',
        status: 'error' as const,
        message: `File ${path.basename(filePath)} does not exist in workspace`,
        data: null,
        timestamp,
      };
    }
  }
}

export const fileOps: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
