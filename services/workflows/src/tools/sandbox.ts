import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import { apiError, confirmFromRisk, fetchWithTimeout, TOOL_EXECUTION_TIMEOUT_MS } from './shared.js';

const ACTIONS = ['execute', 'terminal_run_command', 'python_execute', 'bash_execute', 'run_command'] as const;

const tenantActiveRuns = new Map<string, number>();
export const CLIENT_MAX_CONCURRENT_PER_TENANT = 2;

export function _getActiveRunsForOrg(orgId: string): number {
  return tenantActiveRuns.get(orgId) || 0;
}

// Model-written code is never a draft: every run needs a human confirm.
function riskFor(_action: string): ToolRisk {
  return 'execute';
}

async function execute(ctx: ToolActionContext) {
  const { tool, action, payload, orgId, timestamp } = ctx;
  const actionName = (ctx.actionName || action || '').toLowerCase();
  const toolName = (tool || '').toLowerCase();

  const activeCount = tenantActiveRuns.get(orgId) || 0;
  if (activeCount >= CLIENT_MAX_CONCURRENT_PER_TENANT) {
    return {
      tool,
      action,
      status: 'error' as const,
      message: `Sandbox concurrency limit reached for organization ${orgId} (max ${CLIENT_MAX_CONCURRENT_PER_TENANT} concurrent runs). Please wait for active runs to complete.`,
      data: { error: 'tenant_concurrency_limit', orgId, activeRuns: activeCount },
      timestamp,
    };
  }

  tenantActiveRuns.set(orgId, activeCount + 1);
  console.log(`[Darex Sandbox] Executing isolated code/command for ${orgId}...`);
  try {
    const primaryUrl = (process.env.SANDBOX_API_URL || 'http://localhost:8080').replace(/\/$/, '');
    const candidateUrls = [primaryUrl];
    if (!candidateUrls.includes('http://sandbox:8080')) candidateUrls.push('http://sandbox:8080');
    if (!candidateUrls.includes('http://localhost:8080')) candidateUrls.push('http://localhost:8080');
    if (!candidateUrls.includes('http://127.0.0.1:8080')) candidateUrls.push('http://127.0.0.1:8080');

    let defaultLang: 'python' | 'node' | 'bash' = 'python';
    if (actionName.includes('bash') || actionName.includes('terminal') || actionName.includes('shell') || toolName.includes('terminal') || toolName.includes('bash')) {
      defaultLang = 'bash';
    } else if (actionName.includes('node') || actionName.includes('javascript') || actionName.includes('js') || toolName.includes('node')) {
      defaultLang = 'node';
    }

    const langRaw = String(payload.language || payload.runtime || defaultLang).toLowerCase();
    let language: 'python' | 'node' | 'bash' = defaultLang;
    if (langRaw === 'javascript' || langRaw === 'node' || langRaw === 'js' || langRaw === 'typescript' || langRaw === 'ts') {
      language = 'node';
    } else if (langRaw === 'bash' || langRaw === 'sh' || langRaw === 'shell' || langRaw === 'zsh') {
      language = 'bash';
    } else if (langRaw === 'python' || langRaw === 'py') {
      language = 'python';
    }

    let codeToRun = payload.code || payload.command || payload.cmd || payload.script || payload.expression;
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

    let sandboxRes: Response | null = null;
    let lastFetchErr: any = null;

    for (const url of candidateUrls) {
      try {
        // Run budget stays inside the executor deadline so the sandbox never
        // keeps running after the caller was told the call timed out.
        const runMs = Math.max(1000, Math.min(Number(payload.timeoutMs) || 10_000, TOOL_EXECUTION_TIMEOUT_MS - 2000));
        const res = await fetchWithTimeout(`${url}/execute`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-org-id': orgId,
          },
          body: JSON.stringify({
            orgId,
            language,
            code: codeToRun,
            timeoutMs: runMs,
          }),
        }, runMs + 1500);
        sandboxRes = res;
        break;
      } catch (err: any) {
        lastFetchErr = err;
      }
    }

    if (!sandboxRes) {
      return apiError(
        tool,
        action,
        timestamp,
        `Sandbox is unavailable (${lastFetchErr?.message || 'connection failed'}). Code was not run on the host.`,
        { reason: 'provider_unavailable', connected: false, candidateUrls },
      );
    }

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
        data: { stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null, exitCode: r.exitCode ?? 1 },
        timestamp,
      };
    }

    const output = (r.stdout || r.stderr || '').trim();
    return {
      tool,
      action,
      status: 'executed' as const,
      message: `Executed ${language.toUpperCase()} in sandbox (exit code ${r.exitCode ?? 0})`,
      data: {
        language,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        output,
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
  } finally {
    const cur = tenantActiveRuns.get(orgId) || 0;
    if (cur <= 1) {
      tenantActiveRuns.delete(orgId);
    } else {
      tenantActiveRuns.set(orgId, cur - 1);
    }
  }
}

export const sandbox: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
