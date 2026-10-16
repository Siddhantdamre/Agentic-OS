-------------------------------------------------------------------------------
-- audit_events_kind_chk — add Ask AI plan, tool-approval and crew kinds.
-- Plan cancel, step edit, in-chat tool approve/deny and crew dispatch left no
-- audit row (ASK-E01). Full union of 150 plus the kinds these routes now emit.
-- Idempotent.
-- File: infra/db/migrations/207_audit_event_kinds_ask_ai.sql
-------------------------------------------------------------------------------

ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_kind_chk;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_kind_chk CHECK (kind IN (
  -- 106 (unchanged)
  'tool.execute',
  'plan.approve',
  'plan.reject',
  'plan.execute',
  'connector.connect',
  'connector.disconnect',
  'memory.write',
  'memory.delete',
  'memory.correct',
  'pack.install',
  'pack.uninstall',
  'pack.upgrade',
  'pack.config_update',
  'dsr.export',
  'dsr.delete',
  'role.change',
  'login',
  'register',
  'logout',
  'password.reset',
  'invite.accept',
  'member.remove',
  'member.invite',
  'mfa.enable',
  'mfa.disable',
  'confirm.override',
  'settings.update',
  'org.switch',
  -- emitted by /api/employees/[id]
  'employee.update',
  'employee.delete',
  -- 150: approvals
  'decision.approved',
  'decision.rejected',
  'decision.approved_and_executed',
  'decision.execution_failed',
  'decision.expired',
  -- 150: connectors / channels / conversations
  'connector.config_update',
  'channel.create',
  'conversation.reply',
  'conversation.takeover',
  'conversation.resolve',
  'conversation.assign',
  -- 150: billing / skills / platform
  'billing.change',
  'skill.update',
  'impersonation.start',
  'impersonation.end',
  -- 207: Ask AI plan / tool approval / crew actions (ASK-E01)
  'plan.cancel',
  'plan.step_edit',
  'tool.approve',
  'tool.deny',
  'crew.dispatch'
));
