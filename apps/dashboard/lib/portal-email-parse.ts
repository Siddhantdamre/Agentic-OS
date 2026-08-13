/**
 * Parse a portal / forwarded lead email the org already received.
 * Never fetches listing URLs or scrapes portals (H3).
 */

export type PortalName =
  | 'magicbricks'
  | '99acres'
  | 'housing'
  | 'nobroker'
  | 'makaan'
  | 'commonfloor'
  | 'squareyards'
  | 'unknown';

export type PortalEmailParseResult = {
  isPortalLead: boolean;
  portal: PortalName;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  listingRef: string | null;
  locality: string | null;
  city: string | null;
  bhk: number | null;
  budgetMax: number | null;
  currency: 'INR';
  summary: string;
};

export type PortalEmailInput = {
  subject?: string | null;
  from?: string | null;
  body?: string | null;
  html?: string | null;
};

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function haystack(input: PortalEmailInput): string {
  const htmlText = input.html ? stripHtml(input.html) : '';
  return [input.from, input.subject, input.body, htmlText]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n');
}

function detectPortal(from: string, subject: string, body: string): PortalName {
  const hay = `${from} ${subject} ${body}`.toLowerCase();
  if (hay.includes('magicbricks') || hay.includes('magic bricks')) return 'magicbricks';
  if (hay.includes('99acres') || hay.includes('99 acres')) return '99acres';
  if (hay.includes('housing.com') || hay.includes('housingcom')) return 'housing';
  if (hay.includes('nobroker') || hay.includes('no broker')) return 'nobroker';
  if (hay.includes('makaan.com') || /\bmakaan\b/.test(hay)) return 'makaan';
  if (hay.includes('commonfloor')) return 'commonfloor';
  if (hay.includes('squareyards') || hay.includes('square yards')) return 'squareyards';
  return 'unknown';
}

function extractPhone(text: string): string | null {
  const match = text.match(/(?:\+91[\s-]?)?[6-9]\d{9}\b/);
  return match ? match[0].replace(/[\s-]/g, '') : null;
}

function extractEmail(text: string): string | null {
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  if (!match) return null;
  const email = match[0].toLowerCase();
  if (
    /@(magicbricks|99acres|housing|nobroker|makaan|commonfloor|squareyards)\./i.test(email)
  ) {
    return null;
  }
  return email;
}

function extractName(text: string): string | null {
  const patterns = [
    /(?:name|buyer|enquirer|inquirer|customer|contact)\s*[:\-]\s*([A-Za-z][A-Za-z .']{1,60})/i,
    /(?:mr\.?|ms\.?|mrs\.?)\s+([A-Za-z][A-Za-z .']{1,40})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const name = match[1].trim().replace(/\s+/g, ' ');
      if (name.length >= 2) return name;
    }
  }
  return null;
}

function extractBhk(text: string): number | null {
  const match = text.match(/\b([1-6])\s*(?:bhk|rk)\b/i);
  if (!match) return null;
  const n = parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

function extractBudgetMax(text: string): number | null {
  const match = text.match(
    /(?:budget|upto|up to|max(?:imum)?)\s*(?:is|:)?\s*(?:rs\.?|₹)?\s*([\d,.]+)\s*(lakh|lac|lacs|cr|crore|crores)?/i
  );
  if (!match) {
    const bare = text.match(/₹\s*([\d,.]+)\s*(lakh|lac|cr|crore)?/i);
    if (!bare) return null;
    return scaleInr(bare[1], bare[2]);
  }
  return scaleInr(match[1], match[2]);
}

function scaleInr(raw: string, unit: string | undefined): number | null {
  const n = parseFloat(raw.replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = (unit || '').toLowerCase();
  if (u === 'lakh' || u === 'lac' || u === 'lacs') return Math.round(n * 100_000);
  if (u === 'cr' || u === 'crore' || u === 'crores') return Math.round(n * 10_000_000);
  return Math.round(n);
}

function extractLocality(text: string): string | null {
  const match = text.match(
    /(?:locality|location|area|society|project)\s*[:\-]\s*([A-Za-z0-9][A-Za-z0-9 ,.'-]{1,80})/i
  );
  return match?.[1]?.trim().replace(/\s+/g, ' ') || null;
}

function extractCity(text: string): string | null {
  const match = text.match(/(?:city|in)\s*[:\-]\s*([A-Za-z][A-Za-z .]{1,40})/i);
  if (match?.[1]) return match[1].trim();
  const cities = [
    'Mumbai',
    'Pune',
    'Bengaluru',
    'Bangalore',
    'Hyderabad',
    'Chennai',
    'Delhi',
    'Noida',
    'Gurgaon',
    'Gurugram',
    'Kolkata',
    'Ahmedabad',
    'Jaipur',
    'Kochi',
    'Chandigarh',
  ];
  for (const city of cities) {
    if (new RegExp(`\\b${city}\\b`, 'i').test(text)) return city === 'Bangalore' ? 'Bengaluru' : city;
  }
  return null;
}

function extractListingRef(text: string, portal: PortalName): string | null {
  switch (portal) {
    case 'magicbricks':
    case '99acres':
    case 'housing':
    case 'nobroker':
    case 'makaan':
    case 'commonfloor':
    case 'squareyards': {
      const labeled = text.match(
        /(?:listing|property|id|ref(?:erence)?)\s*(?:id|no\.?|number)?\s*[:\-#]?\s*([A-Za-z0-9_-]{4,32})/i
      );
      return labeled?.[1] || null;
    }
    case 'unknown': {
      const labeled = text.match(
        /(?:listing|property)\s*(?:id|ref)?\s*[:\-#]?\s*([A-Za-z0-9_-]{4,32})/i
      );
      return labeled?.[1] || null;
    }
    default: {
      const _never: never = portal;
      return _never;
    }
  }
}

function looksLikeLead(text: string): boolean {
  return /\b(enquir(?:y|ies)|inquir(?:y|ies)|lead|interested buyer|site visit|property alert|buyer enquiry)\b/i.test(
    text
  );
}

/**
 * Parse an email body the org already has. Does not fetch links.
 */
export function parsePortalEmail(input: PortalEmailInput): PortalEmailParseResult {
  const from = input.from || '';
  const subject = input.subject || '';
  const body = haystack(input);
  const portal = detectPortal(from, subject, body);
  const contactPhone = extractPhone(body);
  const contactEmail = extractEmail(body);
  const contactName = extractName(body);
  const listingRef = extractListingRef(body, portal);
  const locality = extractLocality(body);
  const city = extractCity(body);
  const bhk = extractBhk(body);
  const budgetMax = extractBudgetMax(body);

  const isPortalLead =
    portal !== 'unknown' || (looksLikeLead(body) && Boolean(contactPhone || contactEmail));

  const summaryParts = [
    portal !== 'unknown' ? portal : null,
    contactName,
    bhk != null ? `${bhk} BHK` : null,
    locality,
    city,
    contactPhone,
  ].filter(Boolean);

  return {
    isPortalLead,
    portal,
    contactName,
    contactPhone,
    contactEmail,
    listingRef,
    locality,
    city,
    bhk,
    budgetMax,
    currency: 'INR',
    summary: summaryParts.join(' · ').slice(0, 200) || subject.slice(0, 200),
  };
}
