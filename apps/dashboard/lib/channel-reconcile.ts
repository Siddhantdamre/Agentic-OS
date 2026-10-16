/**
 * Pure helpers for keeping `channels` in sync with live Nango OAuth state.
 * Ask-AI and the tool allowlist read `channels.status`; the connectors UI
 * reads Nango. Without reconcile, a revoked Nango connection can leave the
 * channel marked connected and keep tools on the allowlist.
 */

export function oauthChannelsToDemote(
  defs: Array<{ id: string; authMode: string }>,
  dbStatuses: Map<string, string>,
  liveConnectedIds: Set<string>,
  nangoListOk: boolean
): string[] {
  if (!nangoListOk) return [];
  const out: string[] = [];
  for (const def of defs) {
    if (def.authMode !== 'oauth') continue;
    const status = (dbStatuses.get(def.id) || '').toLowerCase();
    if (status !== 'connected' && status !== 'active') continue;
    if (!liveConnectedIds.has(def.id)) out.push(def.id);
  }
  return out;
}
