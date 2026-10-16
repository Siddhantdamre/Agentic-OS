/**
 * Pack install helpers for HTTP. Session org only — never body org_id.
 * Install/uninstall/upgrade/config live in `@darex/workflows` (canonical).
 */

export {
  LIVE_PACK_IDS,
  PACK_MANIFEST_VERSION,
  isLivePackId,
  installPackForOrg,
  uninstallPackForOrg,
  upgradePackForOrg,
  updatePackConfig,
} from '@darex/workflows/dist/packs/install-pack';

export function rejectBodyOrgId(body: { orgId?: unknown; org_id?: unknown }): string | null {
  if (body.orgId || body.org_id) {
    return 'org_id is not accepted from the client; it is resolved from the session.';
  }
  return null;
}
