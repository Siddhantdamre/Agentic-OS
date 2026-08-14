import type { ToolRisk } from './risk.js';
import type { ToolActionContext, ToolModule } from './shared.js';
import {
  apiError,
  confirmFromRisk,
  fetchWithTimeout,
  revoked,
} from './shared.js';

const ACTIONS = ['geocode', 'reverse_geocode'] as const;
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

function riskFor(_action: string): ToolRisk {
  return 'read';
}

function mapsKey(): string {
  return process.env.GOOGLE_MAPS_API_KEY || process.env.MAPS_API_KEY || '';
}

function mapsHonesty(status: string, errorMessage: string | undefined, action: string, timestamp: string) {
  if (status === 'REQUEST_DENIED' || status === 'INVALID_REQUEST') {
    const msg = (errorMessage || '').toLowerCase();
    if (msg.includes('invalid') || msg.includes('denied') || msg.includes('referer') || !errorMessage) {
      return revoked('maps', action, timestamp, errorMessage || status);
    }
  }
  return null;
}

async function execute(ctx: ToolActionContext) {
  const { actionName, payload, timestamp } = ctx;
  const key = mapsKey();
  if (!key) {
    return {
      tool: 'maps',
      action: actionName,
      status: 'error' as const,
      message: 'maps not connected. Set GOOGLE_MAPS_API_KEY or configure the Maps connector at /connectors.',
      data: { connected: false, setupUrl: '/connectors' },
      timestamp,
    };
  }

  try {
    const isReverse = actionName.includes('reverse') || payload.latlng || (payload.lat != null && payload.lng != null);
    if (isReverse) {
      const latlng = payload.latlng
        || (payload.lat != null && payload.lng != null ? `${payload.lat},${payload.lng}` : '');
      if (!latlng) return apiError('maps', 'reverse_geocode', timestamp, 'latlng (or lat + lng) is required for reverse geocode.');
      const res = await fetchWithTimeout(`${GEOCODE_URL}?latlng=${encodeURIComponent(String(latlng))}&key=${encodeURIComponent(key)}`);
      const data = await res.json().catch(() => ({}));
      const honesty = mapsHonesty(data.status, data.error_message, 'reverse_geocode', timestamp);
      if (honesty) return honesty;
      if (!res.ok) return apiError('maps', 'reverse_geocode', timestamp, `Maps reverse geocode failed: HTTP ${res.status}`, data);
      if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        return apiError('maps', 'reverse_geocode', timestamp, `Maps reverse geocode status ${data.status}`, data);
      }
      const results = Array.isArray(data.results) ? data.results : [];
      return {
        tool: 'maps',
        action: 'reverse_geocode',
        status: 'executed' as const,
        message: results.length
          ? `Reverse-geocoded ${latlng} to ${results[0]?.formatted_address || 'an address'}`
          : `No address found for ${latlng}`,
        data: {
          status: data.status,
          results: results.map((r: any) => ({
            formattedAddress: r.formatted_address,
            placeId: r.place_id,
            location: r.geometry?.location,
            types: r.types,
          })),
          httpStatus: res.status,
          connected: true,
        },
        timestamp,
      };
    }

    const address = payload.address || payload.query || payload.q;
    if (!address) return apiError('maps', 'geocode', timestamp, 'address is required to geocode.');
    const res = await fetchWithTimeout(`${GEOCODE_URL}?address=${encodeURIComponent(String(address))}&key=${encodeURIComponent(key)}`);
    const data = await res.json().catch(() => ({}));
    const honesty = mapsHonesty(data.status, data.error_message, 'geocode', timestamp);
    if (honesty) return honesty;
    if (!res.ok) return apiError('maps', 'geocode', timestamp, `Maps geocode failed: HTTP ${res.status}`, data);
    if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      return apiError('maps', 'geocode', timestamp, `Maps geocode status ${data.status}`, data);
    }
    const results = Array.isArray(data.results) ? data.results : [];
    return {
      tool: 'maps',
      action: 'geocode',
      status: 'executed' as const,
      message: results.length
        ? `Geocoded "${address}" to ${results[0]?.formatted_address || 'a location'}`
        : `No geocode results for "${address}"`,
      data: {
        status: data.status,
        results: results.map((r: any) => ({
          formattedAddress: r.formatted_address,
          placeId: r.place_id,
          location: r.geometry?.location,
          types: r.types,
        })),
        httpStatus: res.status,
        connected: true,
      },
      timestamp,
    };
  } catch (e: any) {
    return apiError('maps', actionName, timestamp, `Maps API error: ${e.message}`);
  }
}

export const maps: ToolModule = {
  actions: ACTIONS,
  risk: riskFor,
  confirm: confirmFromRisk(riskFor),
  execute,
};
