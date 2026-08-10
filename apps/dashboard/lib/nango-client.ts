import Nango from '@nangohq/frontend';

export interface NangoConnectResult {
  success: boolean;
  connectionId?: string;
  provider?: string;
  error?: string;
}

/**
  * Launches real Nango OAuth consent popup for Google, Meta, GitHub, etc.
  * Connects to Nango instance running at http://localhost:3003
  */
export async function startRealNangoOAuth(providerId: string): Promise<NangoConnectResult> {
  try {
    // 1. Get Nango public key & connectionId from API
    const tokenRes = await fetch(`/api/integrations/nango-token?provider=${encodeURIComponent(providerId)}`);
    if (!tokenRes.ok) {
      throw new Error(`Failed to fetch Nango session token (HTTP ${tokenRes.status})`);
    }

    const { nangoPublicKey, nangoHost, connectionId } = await tokenRes.json();

    if (!nangoPublicKey) {
      throw new Error('Nango public key is not configured (NEXT_PUBLIC_NANGO_PUBLIC_KEY)');
    }

    // 2. Initialize Nango Frontend SDK
    const nango = new Nango({
      host: nangoHost || 'http://localhost:3003',
      publicKey: nangoPublicKey,
    });

    console.log(`[Nango OAuth] Opening OAuth Popup for provider "${providerId}" with connectionId "${connectionId}"...`);

    // 3. Open real OAuth popup window
    const authResult = await nango.auth(providerId, connectionId);

    console.log('[Nango OAuth] OAuth popup completed with result:', authResult);

    // 4. Confirm successful OAuth completion in backend DB
    const confirmRes = await fetch('/api/integrations/nango-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: providerId,
        connectionId,
        success: true,
      }),
    });

    const confirmData = await confirmRes.json();

    return {
      success: true,
      connectionId,
      provider: providerId,
    };
  } catch (err: any) {
    console.error(`[Nango OAuth Error] Provider "${providerId}":`, err);

    // If popup was cancelled or failed, report error
    return {
      success: false,
      error: err.message || 'OAuth popup flow failed or was cancelled',
    };
  }
}
