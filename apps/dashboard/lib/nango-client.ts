import Nango from '@nangohq/frontend';

export interface NangoConnectResult {
  success: boolean;
  connectionId?: string;
  provider?: string;
  error?: string;
  oauthConfigured?: boolean;
  nangoUiUrl?: string;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in (err as object)) {
    return String((err as { message: unknown }).message);
  }
  return 'OAuth popup flow failed or was cancelled';
}

export interface NangoOAuthOptions {
  extraParams?: Record<string, string>;
}

/**
 * Launches real Nango OAuth consent popup. Never reports success unless the
 * server confirmed a live Nango connection for this org.
 */
export async function startRealNangoOAuth(
  providerId: string,
  options: NangoOAuthOptions = {}
): Promise<NangoConnectResult> {
  try {
    const tokenRes = await fetch(`/api/integrations/nango-token?provider=${encodeURIComponent(providerId)}`);
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      return {
        success: false,
        provider: providerId,
        error: tokenData.error || tokenData.message || `Failed to fetch Nango session (HTTP ${tokenRes.status})`,
        oauthConfigured: tokenData.oauthConfigured,
        nangoUiUrl: tokenData.nangoUiUrl,
      };
    }

    const {
      nangoPublicKey,
      nangoHost,
      connectionId,
      providerConfigKey,
      oauthConfigured,
      missingConfigReason,
      nangoUiUrl,
      authMode,
      extraConnectFields,
      authorizationParams,
    } = tokenData;

    if (authMode && authMode !== 'oauth') {
      return {
        success: false,
        provider: providerId,
        error: `${providerId} is not Nango OAuth (${authMode}). Use the API-key / BYOK form instead.`,
        nangoUiUrl,
      };
    }

    if (oauthConfigured === false) {
      return {
        success: false,
        provider: providerId,
        oauthConfigured: false,
        nangoUiUrl,
        error:
          missingConfigReason ||
          `OAuth client is not configured in Nango. Open ${nangoUiUrl || nangoHost || 'http://localhost:3003'} and paste a real client ID for ${providerId}.`,
      };
    }

    if (!nangoPublicKey) {
      return {
        success: false,
        provider: providerId,
        error: 'Nango public key is not configured (NEXT_PUBLIC_NANGO_PUBLIC_KEY)',
        nangoUiUrl,
      };
    }

    const requiredFields: Array<{ key: string; label: string; required?: boolean }> = extraConnectFields || [];
    const extraParams = { ...(options.extraParams || {}) };
    for (const field of requiredFields) {
      if (field.required && !extraParams[field.key]) {
        return {
          success: false,
          provider: providerId,
          error: `${field.label} is required before connecting ${providerId}`,
          nangoUiUrl,
        };
      }
    }

    const nango = new Nango({
      host: nangoHost || 'http://localhost:3003',
      publicKey: nangoPublicKey,
    });

    const authKey = providerConfigKey || providerId;
    const nangoParams: Record<string, string> = {};
    if (extraParams.shopDomain) {
      nangoParams.subdomain = extraParams.shopDomain.replace(/\.myshopify\.com$/i, '').replace(/^https?:\/\//, '');
    }
    if (extraParams.subdomain) nangoParams.subdomain = extraParams.subdomain;

    const authOptions: Record<string, unknown> = {};
    if (Object.keys(nangoParams).length > 0) authOptions.params = nangoParams;
    if (authorizationParams && typeof authorizationParams === 'object') {
      authOptions.authorization_params = authorizationParams;
    }

    await nango.auth(authKey, connectionId, authOptions);

    const confirmRes = await fetch('/api/integrations/nango-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: providerId,
        connectionId,
        success: true,
        extra: extraParams,
      }),
    });
    const confirmData = await confirmRes.json().catch(() => ({}));

    if (!confirmRes.ok || !confirmData.success) {
      return {
        success: false,
        connectionId,
        provider: providerId,
        nangoUiUrl,
        error:
          confirmData.message ||
          confirmData.error ||
          'OAuth popup finished but Nango has no connection — the provider was not marked connected.',
      };
    }

    return {
      success: true,
      connectionId,
      provider: providerId,
      nangoUiUrl,
    };
  } catch (err: unknown) {
    console.error(`[Nango OAuth Error] Provider "${providerId}":`, err);
    const msg = errorMessage(err);
    const looksUnconfigured = /not configured|does not exist|invalid_client|client.?id|unauthorized_client/i.test(msg);
    return {
      success: false,
      provider: providerId,
      error: looksUnconfigured
        ? `${msg}. Paste a real OAuth client ID for ${providerId} in the Nango UI (http://localhost:3003).`
        : msg,
    };
  }
}

export async function disconnectProvider(providerId: string): Promise<NangoConnectResult> {
  try {
    const res = await fetch('/api/integrations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: providerId, action: 'disconnect' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return { success: false, provider: providerId, error: data.message || data.error || `HTTP ${res.status}` };
    }
    return { success: true, provider: providerId };
  } catch (err: unknown) {
    return { success: false, provider: providerId, error: errorMessage(err) };
  }
}

export async function connectWhatsAppByok(payload: {
  accessToken: string;
  phoneNumberId: string;
  wabaId?: string;
}): Promise<NangoConnectResult> {
  try {
    const res = await fetch('/api/integrations/whatsapp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return { success: false, provider: 'whatsapp', error: data.message || data.error || `HTTP ${res.status}` };
    }
    return { success: true, provider: 'whatsapp' };
  } catch (err: unknown) {
    return { success: false, provider: 'whatsapp', error: errorMessage(err) };
  }
}

export async function connectRazorpayByok(payload: {
  keyId: string;
  keySecret: string;
}): Promise<NangoConnectResult> {
  try {
    const res = await fetch('/api/integrations/razorpay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return { success: false, provider: 'razorpay', error: data.message || data.error || `HTTP ${res.status}` };
    }
    return { success: true, provider: 'razorpay' };
  } catch (err: unknown) {
    return { success: false, provider: 'razorpay', error: errorMessage(err) };
  }
}
