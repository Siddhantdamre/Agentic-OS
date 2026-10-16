-------------------------------------------------------------------------------
-- audit_events_kind_chk — add decision, conversation, channel, billing,
-- skill and impersonation kinds.
-- /api/decisions wrote 'decision.rejected' / 'decision.approved_and_executed',
-- which the CHECK from 106 rejected. The route swallowed the error, so approved
-- high-risk tool executions left no audit row (OPS-B01). This is the full
-- union of 106 plus the kinds that routes now emit.
-- Idempotent.
-- File: infra/db/migrations/150_audit_event_kinds_decisions_channels.sql
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
  'impersonation.end'
));
