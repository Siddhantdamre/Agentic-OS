import Nango from '@nangohq/frontend';

export interface NangoConnectResult {
  success: boolean;
  connectionId?: string;
  provider?: string;
  /** WhatsApp: the `channels` row that was saved (one per linked number). */
  channelId?: string;
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
        oauthConfigured: false,
        nangoUiUrl,
        error:
          'Nango public key is not configured (NEXT_PUBLIC_NANGO_PUBLIC_KEY). Ask an admin to set it on the dashboard — OAuth popups cannot start without it.',
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

    const resolvedHost = (typeof nangoHost === 'string' && nangoHost.trim()) || 'http://localhost:3003';
    // Container DNS (http://nango-server:3003) is server-to-server only —
    // browsers cannot resolve it. Fail honestly instead of opening a popup
    // that can never reach Nango. Set NEXT_PUBLIC_NANGO_HOST to the public URL.
    if (/nango-server/i.test(resolvedHost)) {
      return {
        success: false,
        provider: providerId,
        oauthConfigured: false,
        nangoUiUrl,
        error:
          `Nango host ${resolvedHost} is not browser-reachable (container DNS). Ask an admin to set NEXT_PUBLIC_NANGO_HOST to the public Nango URL.`,
      };
    }

    const nango = new Nango({
      host: resolvedHost,
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

/** `add` links an extra number; `channelId` replaces that number; neither = the primary. */
export async function connectWhatsAppByok(payload: {
  accessToken: string;
  phoneNumberId: string;
  wabaId?: string;
  add?: boolean;
  channelId?: string | null;
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
    return { success: true, provider: 'whatsapp', channelId: data.channelId };
  } catch (err: unknown) {
    return { success: false, provider: 'whatsapp', error: errorMessage(err) };
  }
}

export type WhatsAppQrStatus = {
  success: boolean;
  /** 'pairing' right after start; then Evolution's own state: open | connecting | close | missing. */
  state?: string;
  connected?: boolean;
  qrBase64?: string | null;
  pairingCode?: string | null;
  /** The number's `channels` row, returned when pairing starts. */
  channelId?: string;
  message?: string;
};

/** Start (or restart) QR pairing for the org's WhatsApp; returns the first QR. */
export async function startWhatsAppQr(opts: { add?: boolean; channelId?: string | null } = {}): Promise<WhatsAppQrStatus> {
  try {
    const res = await fetch('/api/integrations/whatsapp/evolution', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return { success: false, message: data.message || data.error || `HTTP ${res.status}` };
    }
    return { success: true, state: data.state, qrBase64: data.qrBase64, pairingCode: data.pairingCode, channelId: data.channelId };
  } catch (err: unknown) {
    return { success: false, message: errorMessage(err) };
  }
}

/** Poll pairing state. `withQr` also asks for a fresh QR (they expire in ~30s). */
export async function getWhatsAppQrStatus(withQr: boolean, channelId?: string | null): Promise<WhatsAppQrStatus> {
  try {
    const qs = [withQr ? 'qr=1' : '', channelId ? `channelId=${encodeURIComponent(channelId)}` : ''].filter(Boolean).join('&');
    const res = await fetch(`/api/integrations/whatsapp/evolution${qs ? `?${qs}` : ''}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { success: false, message: data.message || data.error || `HTTP ${res.status}` };
    return {
      success: true,
      state: data.state,
      connected: Boolean(data.connected),
      qrBase64: data.qrBase64,
      pairingCode: data.pairingCode,
    };
  } catch (err: unknown) {
    return { success: false, message: errorMessage(err) };
  }
}

/** Finish Meta Embedded Signup: the server verifies the code and ids with Meta, then saves the channel. */
export async function connectWhatsAppEmbedded(payload: {
  code: string;
  wabaId: string;
  phoneNumberId: string;
  add?: boolean;
}): Promise<NangoConnectResult> {
  try {
    const res = await fetch('/api/integrations/whatsapp/embedded-signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) {
      return { success: false, provider: 'whatsapp', error: data.message || data.error || `HTTP ${res.status}` };
    }
    return { success: true, provider: 'whatsapp', channelId: data.channelId };
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
