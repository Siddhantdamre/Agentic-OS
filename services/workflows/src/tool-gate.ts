/**
 * The one ordered gate every side effect passes through (17 §2).
 *
 * `runToolGate` is pure orchestration over injected deps so the order can be
 * tested without Postgres or providers. `tool-executor.ts` wires the real deps.
 *
 * A missing field is a denial, never a default: no employee → denied, no card
 * → core reads only, a caller allowlist can only narrow the card.
 */
import type { ToolExecutionParams, ToolExecutionResult } from '@darex/shared-types';
import type { AutonomyVerdict, BlastRadius } from './autonomy.js';
import { evaluateEmployeeGate, type RolloutStage } from './employee-gate.js';
import type { GateDeny, GateDenyReason, GateHookContext, OrgRunState } from './tools/gate-hooks.js';
import type { ToolRisk } from './tools/risk.js';

export type { GateDenyReason } from './tools/gate-hooks.js';

// Read tools every employee may call. Code execution, file writes, maps, and
// cognee_remember are opt-in on the employee card — they are not core.
export const CORE_READ_TOOLS = [
  'web_search', 'search', 'google_search',
  'web_extract', 'fetch_url', 'read_url',
  'database_query', 'db_query', 'sql_analytics',
  'metrics', 'metrics_query',
  'cognee_search',
  // Read-only connector status; connect/disconnect are human-only on /connectors.
  'connectors', 'connectors_status',
];

// Never granted implicitly. Allowed only when named on the employee card.
export const NEVER_CORE_TOOLS = [
  'sandbox', 'code_execution', 'terminal_run_command', 'bash_execute', 'python_execute',
  'file_ops', 'cognee_remember', 'cognee_memory_remember', 'maps',
];

export interface GateParams extends ToolExecutionParams {
  /** Set only by the approval executor after a human approved this exact row. */
  approvedPendingActionId?: string;
  /**
   * A person is deciding this very call right now (they allowed it in the chat card). It changes nothing about what
   * the gate allows; it only means a hold needs no announcement to managers, since the person is about to decide it.
   */
  approverPresent?: boolean;
}

export type GateResult = ToolExecutionResult & {
  reason?: GateDenyReason;
  approval?: { pendingActionId: string | null; workItemId: string | null; summary: string };
};

export interface GateEmployee {
  id: string;
  name: string;
  role: string;
  rosterKey: string | null;
  toolAllowlist: string[];
  status: string;
}

export interface ApprovedAction {
  id: string;
  tool: string;
  action: string;
  args: Record<string, unknown>;
}

export interface LedgerEntry {
  orgId: string;
  employeeId: string;
  employeeRole: string;
  tool: string;
  action: string;
  decision: 'suppressed' | 'declined' | 'deferred' | 'executed';
  reasonCode: string;
  payload: Record<string, unknown>;
  /**
   * One plain sentence about what the call would have done. Kept only on watching-mode
   * decisions, so the person reviewing them is shown a sentence, not a payload.
   */
  summary?: string;
}

export interface ParkInput {
  orgId: string;
  workflowId: string;
  actionType: string;
  employeeRole: string;
  employeeId: string;
  tool: string;
  action: string;
  payload: Record<string, unknown>;
  reasonCode: string;
  /** False when a person is deciding the hold as it is made: no push to managers. Default true. */
  announce?: boolean;
}

export interface GateDeps {
  runContext(): { employeeRole?: string; workflowId?: string; confidence?: number; blastRadius?: BlastRadius } | undefined;
  orgRunState(orgId: string): Promise<OrgRunState>;
  loadEmployee(orgId: string, ref: { employeeId?: string; employeeRole?: string }): Promise<GateEmployee | null>;
  usageBlock(orgId: string): Promise<{ message: string; reasons?: unknown } | null>;
  entitlement(ctx: GateHookContext): Promise<GateDeny | null>;
  payRbac(ctx: GateHookContext): Promise<GateDeny | null>;
  loadApprovedAction(orgId: string, pendingActionId: string): Promise<ApprovedAction | null>;
  riskFor(tool: string, action: string): { risk: ToolRisk; confirm: boolean } | null;
  isAllowed(tool: string, allowlist: string[]): boolean;
  personaDenial(role: string, tool: string, action: string, card: string[]): string | null;
  skillTierBlock(orgId: string, employeeRole: string, tool: string, action: string): Promise<string | null>;
  checkAutonomy(input: {
    orgId: string; employeeRole: string; tool: string; action: string; confidence: number; blastRadius?: BlastRadius;
  }): Promise<AutonomyVerdict>;
  logAutonomy(input: {
    orgId: string; employeeRole: string; employeeId?: string; tool: string; action: string; verdict: AutonomyVerdict;
    confidence: number; payload: Record<string, unknown>;
  }): Promise<void>;
  logLedger(entry: LedgerEntry): Promise<void>;
  park(input: ParkInput): Promise<{ pendingActionId: string | null; workItemId: string | null }>;
  summarize(tool: string, action: string, payload: Record<string, unknown>): string;
  critic(orgId: string, draft: string): Promise<{ allow: boolean; reason: string }>;
  inQuietHours(orgId: string): Promise<boolean>;
  invoke(params: GateParams, ctx: { actionName: string; employee: GateEmployee; timestamp: string }): Promise<ToolExecutionResult>;
}

function norm(value: string): string {
  return String(value || '').toLowerCase().replace(/_/g, '-');
}

/** 17 §3: empty card → core reads; else card ∪ core reads. Never an org union. */
export function resolveTurnAllowlist(card: string[] | null | undefined): string[] {
  const list = (card || []).map((t) => String(t).trim()).filter(Boolean);
  if (list.length === 0) return [...CORE_READ_TOOLS];
  return Array.from(new Set([...list, ...CORE_READ_TOOLS]));
}

function isNeverCore(tool: string): boolean {
  const key = norm(tool);
  return NEVER_CORE_TOOLS.some((t) => norm(t) === key);
}

const MONEY_ACTION_RE = /(create_charge|charge|payment_link|invoice|payout|subscription)/;

/** Semantic payload rules the model boundary cannot see: no invented money or channel. */
export function payloadDenial(tool: string, action: string, risk: ToolRisk | null, payload: Record<string, unknown>): string | null {
  const act = action.toLowerCase();
  if (risk === 'pay' && MONEY_ACTION_RE.test(act) && !/refund/.test(act)) {
    const raw = payload.amount ?? payload.amount_cents ?? payload.amountCents;
    const amount = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(amount) || amount <= 0) {
      return 'A positive amount is required. Ask the user for the exact amount — never assume one.';
    }
  }
  if (norm(tool) === 'slack' && /send_channel_message/.test(act)) {
    const channel = payload.channel ?? payload.channel_id;
    if (typeof channel !== 'string' || !channel.trim()) {
      return 'A Slack channel is required. Ask which channel — there is no default.';
    }
  }
  return null;
}

function draftText(payload: Record<string, unknown>): string {
  for (const key of ['body', 'message', 'text', 'html', 'content']) {
    const v = payload[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

function reversibilityFor(risk: ToolRisk | null): 'reversible' | 'visible' | 'irreversible' {
  if (risk === 'pay' || risk === 'delete') return 'irreversible';
  if (risk === 'send' || risk === 'publish' || risk === 'sign' || risk === 'execute') return 'visible';
  return 'reversible';
}

// The stage gate classifies by surface, so pass it the risk class rather than
// the action name: `draft_email` contains "email" but reaches nobody.
function actionSurfaceType(risk: ToolRisk | null, action: string): string {
  if (risk === 'send' || risk === 'publish' || risk === 'sign') return 'external_send';
  if (risk === 'pay' || risk === 'delete') return risk;
  if (risk === null) return action;
  return 'observe';
}

export async function runToolGate(params: GateParams, deps: GateDeps): Promise<GateResult> {
  const timestamp = new Date().toISOString();
  const actionName = (params.action || 'auto_execute').toLowerCase();
  const baseTool = (params.tool || '').toLowerCase();
  const runCtx = deps.runContext();
  let payload: Record<string, unknown> = { ...(params.payload || {}) };

  const deny = (reason: GateDenyReason, message: string, extra: Record<string, unknown> = {}): GateResult => ({
    tool: params.tool,
    action: actionName,
    status: 'error',
    reason,
    message,
    data: { allowed: false, reason, ...extra },
    timestamp,
  });

  // 2 · Org runnable. Checked before identity: loading an employee in a
  // suspended org throws, and the answer is the same denial either way.
  const run = await deps.orgRunState(params.orgId);
  if (!run.runnable) {
    const reason = run.reason || 'org_not_runnable';
    return deny(reason, reason === 'kill_switch'
      ? 'The kill switch is on for this workspace. Nothing was run.'
      : 'This workspace is not active. Nothing was run.');
  }

  // 1 · Identity. The role comes from the employee row, not from model args.
  const employee = await deps.loadEmployee(params.orgId, {
    employeeId: params.employeeId,
    employeeRole: params.employeeRole || runCtx?.employeeRole,
  });
  if (!employee) {
    return deny('missing_employee', 'No active employee is attached to this call. Nothing was run.');
  }
  if (employee.status !== 'active') {
    return deny('policy_denied', `${employee.name} is ${employee.status}. Nothing was run.`);
  }
  const personaRole = employee.rosterKey || employee.role;
  const ledgerBase = { orgId: params.orgId, employeeId: employee.id, employeeRole: employee.role, tool: params.tool, action: actionName };

  // Approval path: re-enter with the STORED call, never the caller's copy.
  let approved: ApprovedAction | null = null;
  if (params.approvedPendingActionId) {
    approved = await deps.loadApprovedAction(params.orgId, params.approvedPendingActionId);
    if (!approved || norm(approved.tool) !== norm(params.tool) || approved.action.toLowerCase() !== actionName) {
      return deny('policy_denied', 'That approval does not match an approved action for this call.');
    }
    payload = { ...approved.args };
  }

  const riskGate = deps.riskFor(params.tool, actionName) ?? deps.riskFor(baseTool, actionName);
  const risk = riskGate?.risk ?? null;
  const hookCtx: GateHookContext = {
    orgId: params.orgId,
    employeeId: employee.id,
    employeeRole: employee.role,
    actorUserId: params.actorUserId,
    source: params.source,
    tool: params.tool,
    action: actionName,
    risk,
  };

  // 4 · Usage and plan entitlement.
  const usage = await deps.usageBlock(params.orgId);
  if (usage) return deny('usage_blocked', usage.message, { reasons: usage.reasons ?? null });
  const entitlement = await deps.entitlement(hookCtx);
  if (entitlement) return deny(entitlement.reason, entitlement.message);

  // 5 · Allowlist: exact ids on the card, or a core read. A caller list only narrows.
  const card = employee.toolAllowlist;
  const onCard = card.length > 0 && deps.isAllowed(baseTool, card);
  const coreRead = !isNeverCore(baseTool) && risk === 'read' && deps.isAllowed(baseTool, CORE_READ_TOOLS);
  const callerList = Array.isArray(params.toolAllowlist) ? params.toolAllowlist.filter(Boolean) : [];
  const narrowedOut = callerList.length > 0 && !coreRead && !deps.isAllowed(baseTool, callerList);
  if ((!onCard && !coreRead) || narrowedOut) {
    await deps.logLedger({ ...ledgerBase, decision: 'declined', reasonCode: 'not_in_allowlist', payload });
    return deny('not_in_allowlist', `Tool "${params.tool}" is not on ${employee.name}'s card.`);
  }

  // 6 · Persona denial wins even when the tool is on the card.
  const personaDenied = deps.personaDenial(personaRole, baseTool, actionName, card);
  if (personaDenied) {
    await deps.logLedger({ ...ledgerBase, decision: 'declined', reasonCode: 'persona_denied', payload });
    return deny('persona_denied', personaDenied);
  }
  if (!riskGate) {
    return deny('policy_denied', `"${params.tool}.${actionName}" is not a registered tool action. Nothing was run.`);
  }
  // Skill tier minimums say how far an employee may act ALONE. Below the
  // minimum the call goes to a human for approval rather than being refused,
  // so "send this email" from chat becomes an approval card. Reads and drafts
  // reach nobody outside the workspace, and an approved re-entry already has
  // its human sign-off, so none of those are tier-checked.
  const tierBlock = risk === 'read' || risk === 'draft' || approved
    ? null
    : await deps.skillTierBlock(params.orgId, employee.role, params.tool, actionName);

  // 7 · Payload: no invented amounts or channels. Zod shape checks run at the
  // model boundary (local-turn / mcp-bridge) where the raw args still exist.
  const badArgs = payloadDenial(baseTool, actionName, risk, payload);
  if (badArgs) return deny('invalid_args', badArgs);

  const confidence = typeof params.confidence === 'number' ? params.confidence : runCtx?.confidence ?? 0.7;
  const summary = deps.summarize(params.tool, actionName, { tool: params.tool, action: actionName, payload });
  const park = async (actionType: string, reasonCode: string): Promise<GateResult> => {
    let pending = { pendingActionId: null as string | null, workItemId: null as string | null };
    try {
      pending = await deps.park({
        orgId: params.orgId,
        workflowId: params.workflowId || runCtx?.workflowId || 'direct',
        actionType,
        employeeRole: employee.role,
        employeeId: employee.id,
        tool: params.tool,
        action: actionName,
        payload: { tool: params.tool, action: actionName, payload, employeeId: employee.id },
        reasonCode,
        announce: params.approverPresent !== true,
      });
    } catch (err) {
      console.warn(`[tool-gate] park failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const approval = { pendingActionId: pending.pendingActionId, workItemId: pending.workItemId, summary };
    return {
      tool: params.tool,
      action: actionName,
      status: 'pending_approval',
      message: `Waiting for approval: ${summary}`,
      data: { ...approval, reasonCode, risk },
      approval,
      timestamp,
    };
  };

  if (approved) {
    // A human approved this stored call. Pay still needs a pay-capable approver,
    // the critic still blocks policy violations, and a sweep-resumed send
    // (no human actor) still respects quiet hours.
    if (risk === 'pay') {
      const rbac = await deps.payRbac(hookCtx);
      if (rbac) return deny(rbac.reason, rbac.message);
    }
    if (risk === 'send') {
      const critic = await deps.critic(params.orgId, draftText(payload));
      if (!critic.allow) return deny('critic', critic.reason);
      if (!params.actorUserId && (await deps.inQuietHours(params.orgId))) {
        await deps.logLedger({ ...ledgerBase, decision: 'deferred', reasonCode: 'quiet_hours', payload });
        return deny('quiet_hours', 'Quiet hours are on. The send was deferred.');
      }
    }
  } else {
    // 3 · Rollout stage. Stage 0 records what would have run and runs nothing
    // with side effects. Read-only tools still run so a fresh workspace can
    // answer questions (the employee "watches" in week one).
    const stageVerdict = evaluateEmployeeGate({
      killSwitch: false,
      rolloutStage: run.stage as RolloutStage,
      employeeRole: personaRole,
      actionType: actionSurfaceType(risk, actionName),
      reversibility: reversibilityFor(risk),
    });
    if (stageVerdict === 'deny_role') return deny('persona_denied', `${employee.name} cannot run ${params.tool}.${actionName}.`);
    if (stageVerdict === 'shadow' && risk !== 'read') {
      await deps.logLedger({ ...ledgerBase, decision: 'suppressed', reasonCode: 'shadow_stage', payload, summary });
      return deny('shadow', `Watching mode (rollout stage ${run.stage}): I recorded "${summary}" but did not run it.`);
    }

    // 10 · Critic before any outbound draft reaches a human or a provider.
    if (risk === 'send') {
      const critic = await deps.critic(params.orgId, draftText(payload));
      if (!critic.allow) return deny('critic', critic.reason);
    }

    // 8 · Confirm class parks every send/pay/sign/publish/delete/execute,
    // from chat, plan steps, crews, webhooks, and sweeps alike.
    if (riskGate.confirm) return park(riskGate.risk, 'confirm_class');
    if (tierBlock) return park(actionSurfaceType(risk, actionName), 'skill_tier');
    if (stageVerdict === 'escalate') return park(actionSurfaceType(risk, actionName), 'rollout_stage');

    // 9 · Autonomy, always, with the DB role.
    const verdict = await deps.checkAutonomy({
      orgId: params.orgId,
      employeeRole: employee.role,
      tool: params.tool,
      action: actionName,
      confidence,
      blastRadius: params.blastRadius || runCtx?.blastRadius,
    });
    await deps.logAutonomy({ orgId: params.orgId, employeeRole: employee.role, employeeId: employee.id, tool: params.tool, action: actionName, verdict, confidence, payload: { ...payload, employeeId: employee.id } });
    if (verdict.mode === 'approval_required') return park(verdict.actionType, verdict.reasonCode);
  }

  // 11–13 · Provider call (idempotency, abort, and audit wrap `invoke`).
  const result = await deps.invoke({ ...params, payload, employeeId: employee.id, employeeRole: employee.role }, { actionName, employee, timestamp });
  if (result && result.status === 'executed') {
    await deps.logLedger({ ...ledgerBase, decision: 'executed', reasonCode: 'allowed', payload }).catch(() => {});
  }
  return result;
}
