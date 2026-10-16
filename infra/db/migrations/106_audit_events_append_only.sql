-------------------------------------------------------------------------------
-- Audit events — append-only for darex_app + restore admin event kinds
-- darex_app must INSERT/SELECT only; UPDATE/DELETE are revoked so a compromised
-- app credential cannot erase the compliance trail.
-- Also restores auth/settings kinds dropped when 104 rewrote the CHECK.
-- File: infra/db/migrations/106_audit_events_append_only.sql
-- NOT applied in this agent pass (shared DB); apply via pnpm db:migrate later.
-------------------------------------------------------------------------------

-- Union of kinds from 097 (auth/settings) + 104 (packs) so admin emit works.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_kind_chk;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_kind_chk CHECK (kind IN (
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
  'org.switch'
));

REVOKE UPDATE, DELETE ON audit_events FROM darex_app;
GRANT SELECT, INSERT ON audit_events TO darex_app;

COMMENT ON TABLE audit_events IS
  'Org-scoped append-only compliance log. darex_app: SELECT+INSERT only; no UPDATE/DELETE.';
