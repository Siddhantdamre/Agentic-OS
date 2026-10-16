import type {
  IcpProfile,
  PreferenceRule,
  RankedCandidate,
  WonAccountFeatures,
} from '@darex/shared-types';

function mode(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const key = raw.trim().toLowerCase();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return ranked.slice(0, 3).map(([k]) => k);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

export function buildIcpProfile(accounts: WonAccountFeatures[]): IcpProfile {
  const headcounts = accounts
    .map((a) => a.headcount)
    .filter((n): n is number => typeof n === 'number' && n > 0)
    .sort((a, b) => a - b);
  const industries = mode(accounts.map((a) => a.industry || ''));
  const geos = mode(accounts.map((a) => a.geo || ''));
  const tech = new Set<string>();
  for (const a of accounts) {
    for (const t of a.techTags || []) {
      if (t.trim()) tech.add(t.trim().toLowerCase());
    }
  }
  return {
    industries,
    geos,
    employeeMin: headcounts.length ? percentile(headcounts, 10) : 50,
    employeeMax: headcounts.length ? percentile(headcounts, 90) : 250,
    techTags: [...tech].slice(0, 20),
    decisionMakerTitles: ['vp sales', 'head of growth', 'ceo', 'founder'],
    sampleSize: accounts.length,
  };
}

export function applyPreferenceFilters(
  candidate: RankedCandidate,
  rules: PreferenceRule[],
): boolean {
  for (const rule of rules) {
    switch (rule.field) {
      case 'headcount': {
        const n = candidate.headcount;
        if (typeof n !== 'number') return false;
        const bound = Number(rule.value);
        if (rule.op === 'gte' && n < bound) return false;
        if (rule.op === 'lte' && n > bound) return false;
        break;
      }
      case 'industry': {
        const val = (candidate.industry || '').toLowerCase();
        const list = Array.isArray(rule.value) ? rule.value.map((v) => String(v).toLowerCase()) : [String(rule.value).toLowerCase()];
        if (rule.op === 'in' && !list.includes(val)) return false;
        if (rule.op === 'not_in' && list.includes(val)) return false;
        break;
      }
      case 'geo': {
        const val = (candidate.geo || '').toLowerCase();
        const list = Array.isArray(rule.value) ? rule.value.map((v) => String(v).toLowerCase()) : [String(rule.value).toLowerCase()];
        if (rule.op === 'in' && !list.includes(val)) return false;
        if (rule.op === 'not_in' && list.includes(val)) return false;
        break;
      }
      case 'title': {
        const val = (candidate.title || '').toLowerCase();
        const list = Array.isArray(rule.value) ? rule.value.map((v) => String(v).toLowerCase()) : [String(rule.value).toLowerCase()];
        if (rule.op === 'in' && !list.some((t) => val.includes(t))) return false;
        if (rule.op === 'not_in' && list.some((t) => val.includes(t))) return false;
        break;
      }
      default: {
        const _exhaustive: never = rule.field;
        void _exhaustive;
      }
    }
  }
  return true;
}

export function scoreCandidate(candidate: Omit<RankedCandidate, 'fit' | 'now' | 'score'>, icp: IcpProfile): RankedCandidate {
  const industry = (candidate.industry || '').toLowerCase();
  const geo = (candidate.geo || '').toLowerCase();
  const industryMatch = icp.industries.includes(industry) ? 1 : 0;
  const sizeInBand =
    typeof candidate.headcount === 'number' &&
    candidate.headcount >= icp.employeeMin &&
    candidate.headcount <= icp.employeeMax
      ? 1
      : 0;
  const geoMatch = icp.geos.includes(geo) ? 1 : 0;
  const tags = new Set((candidate.techTags || []).map((t) => t.toLowerCase()));
  const overlap = icp.techTags.filter((t) => tags.has(t)).length;
  const techOverlap = icp.techTags.length === 0 ? 0 : Math.min(1, overlap / Math.min(3, icp.techTags.length));

  const fit = 0.4 * industryMatch + 0.3 * sizeInBand + 0.2 * geoMatch + 0.1 * techOverlap;
  const types = new Set(candidate.activeSignals.map((s) => s.type));
  const now = Math.min(
    1,
    (types.has('hiring') ? 0.5 : 0) + (types.has('intent') ? 0.5 : 0) + (types.has('funding') ? 0.3 : 0),
  );
  const score = Math.round(100 * (0.6 * fit + 0.4 * now));
  return { ...candidate, fit, now, score };
}

export function rankCandidates(
  candidates: Array<Omit<RankedCandidate, 'fit' | 'now' | 'score'>>,
  icp: IcpProfile,
  prefs: PreferenceRule[],
): RankedCandidate[] {
  return candidates
    .map((c) => scoreCandidate(c, icp))
    .filter((c) => applyPreferenceFilters(c, prefs))
    .sort((a, b) => b.score - a.score);
}

/**
 * Converts a raw Apollo `mixed_people/search` result row into a lookalike
 * candidate shape. Returns null for rows with no identifiable company —
 * never fabricates a name/domain the API did not return.
 */
export function candidateFromApolloPerson(
  person: Record<string, unknown>,
  icp: IcpProfile,
): Omit<RankedCandidate, 'fit' | 'now' | 'score'> | null {
  const org = (person.organization && typeof person.organization === 'object'
    ? (person.organization as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const rawDomain = String(org.primary_domain || org.website_url || '').trim();
  const domain = rawDomain.replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
  const companyName = String(org.name || person.organization_name || '').trim();
  if (!companyName && !domain) return null;

  const firstName = typeof person.first_name === 'string' ? person.first_name : '';
  const lastName = typeof person.last_name === 'string' ? person.last_name : '';
  const contactName = [firstName, lastName].filter(Boolean).join(' ').trim() || undefined;
  const rawEmail = typeof person.email === 'string' ? person.email : '';
  const contactEmail = rawEmail && !rawEmail.includes('not_unlocked') ? rawEmail : undefined;
  const techTags = Array.isArray(org.technology_names)
    ? (org.technology_names as unknown[]).filter((t): t is string => typeof t === 'string')
    : [];

  return {
    companyName: companyName || domain,
    domain: domain || companyName.toLowerCase().replace(/\s+/g, ''),
    industry: typeof org.industry === 'string' ? org.industry : icp.industries[0],
    geo: typeof org.country === 'string' ? org.country : icp.geos[0],
    headcount: typeof org.estimated_num_employees === 'number' ? org.estimated_num_employees : undefined,
    techTags,
    title: typeof person.title === 'string' ? person.title : undefined,
    contactName,
    contactEmail,
    linkedin: typeof person.linkedin_url === 'string' ? person.linkedin_url : undefined,
    activeSignals: [],
  };
}

export function emptyIcp(): IcpProfile {
  return {
    industries: [],
    geos: [],
    employeeMin: 50,
    employeeMax: 250,
    techTags: [],
    decisionMakerTitles: ['vp sales', 'head of growth'],
    sampleSize: 0,
  };
}
