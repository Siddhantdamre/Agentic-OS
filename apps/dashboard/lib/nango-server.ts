const NANGO_HOST = process.env.NANGO_HOST || 'http://localhost:3003';
const NANGO_SECRET_KEY = process.env.NANGO_SECRET_KEY;

/**
 * Returns true only if a real Nango OAuth connection exists for this org+provider.
 * This is the source of truth the agent tools rely on, so the UI must match it.
 */
export async function nangoConnectionExists(orgId: string, provider: string): Promise<boolean> {
  if (!NANGO_SECRET_KEY) {
    console.warn('[Nango] NANGO_SECRET_KEY is not set — cannot verify connection status');
    return false;
  }
  try {
    const connectionId = `${orgId}_${provider}`;
    const res = await fetch(
      `${NANGO_HOST}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(provider)}`,
      { headers: { Authorization: `Bearer ${NANGO_SECRET_KEY}` } }
    );
    if (!res.ok) return false;
    return true;
  } catch (err: any) {
    console.warn(`[Nango] Connection check failed for ${provider}:`, err.message);
    return false;
  }
}

/**
 * Fetch the raw Nango connection record for an org+provider (or null).
 */
export async function getNangoConnection(
  orgId: string,
  provider: string
): Promise<any | null> {
  if (!NANGO_SECRET_KEY) return null;
  try {
    const connectionId = `${orgId}_${provider}`;
    const res = await fetch(
      `${NANGO_HOST}/connection/${encodeURIComponent(connectionId)}?provider_config_key=${encodeURIComponent(provider)}`,
      { headers: { Authorization: `Bearer ${NANGO_SECRET_KEY}` } }
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}