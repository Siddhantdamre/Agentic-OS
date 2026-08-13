import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk } from './shared.js';

const ACTIONS = ['execute'] as const;

function riskFor(_action: string): ToolRisk {
  return 'draft';
}

async function execute(ctx: ToolActionContext) {
  const { tool, action, payload, orgId, timestamp } = ctx;
  console.log(`[Darex Sandbox] Executing isolated code for ${orgId}...`);
  try {
    const sandboxUrl = process.env.SANDBOX_API_URL;
    if (!sandboxUrl) {
      return apiError(tool, action, timestamp, 'Sandbox is not configured. Set SANDBOX_API_URL to enable code execution.', { configured: false });
    }

    const langRaw = String(payload.language || payload.runtime || 'python').toLowerCase();
    let language: 'python' | 'node' | 'bash' = 'python';
    if (langRaw === 'javascript' || langRaw === 'node' || langRaw === 'js' || langRaw === 'typescript' || langRaw === 'ts') {
      language = 'node';
    } else if (langRaw === 'bash' || langRaw === 'sh' || langRaw === 'shell' || langRaw === 'zsh') {
      language = 'bash';
    }

    let codeToRun = payload.code || payload.expression || payload.command;
    if (!codeToRun) {
      if (payload.num1 !== undefined && payload.num2 !== undefined) {
        const opStr = (payload.operator || payload.operation || '*').toString().toLowerCase();
        let symbol = '*';
        if (opStr.includes('add') || opStr.includes('plus') || opStr === '+') symbol = '+';
        else if (opStr.includes('sub') || opStr.includes('minus') || opStr === '-') symbol = '-';
        else if (opStr.includes('div') || opStr.includes('slash') || opStr === '/') symbol = '/';
        else if (opStr.includes('mult') || opStr.includes('times') || opStr.includes('prod') || opStr === '*') symbol = '*';
        codeToRun = `print(${payload.num1} ${symbol} ${payload.num2})`;
      } else {
        codeToRun = `print(${JSON.stringify(payload)})`;
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), (payload.timeoutMs || 10000) + 2000);

    const sandboxRes = await fetch(`${sandboxUrl}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        language,
        code: codeToRun,
        timeoutMs: payload.timeoutMs || 10000,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!sandboxRes.ok) {
      const errText = await sandboxRes.text().catch(() => '');
      return {
        tool,
        action,
        status: 'error' as const,
        message: `Sandbox HTTP ${sandboxRes.status}: ${errText.slice(0, 300)}`,
        data: { error: errText.slice(0, 300) },
        timestamp,
      };
    }

    const parseRes = await sandboxRes.json();
    const r = parseRes?.result || {};
    if (r.ok === false) {
      return {
        tool,
        action,
        status: 'error' as const,
        message: `Sandbox execution failed: ${r.error || 'unknown error'}`,
        data: { stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null },
        timestamp,
      };
    }

    return {
      tool,
      action,
      status: 'executed' as const,
      message: 'Code executed securely in the isolated Darex sandbox',
      data: {
        output: r.stdout || '',
        stderr: r.stderr || '',
        exitCode: r.exitCode ?? 0,
      },
      timestamp,
    };
  } catch (err: any) {
    console.error('[Darex Sandbox Error]', err);
    return {
      tool,
      action,
      status: 'error' as const,
      message: 'Failed to execute code in the Darex sandbox',
      data: { error: err.message },
      timestamp,
    };
  }
}

export const sandbox: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
