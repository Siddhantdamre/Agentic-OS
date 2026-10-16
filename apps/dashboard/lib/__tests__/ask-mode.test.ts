import {
  ASK_TEAM_MAX,
  autoRoutingReason,
  dedupeIds,
  fixedTeamCrewPlan,
  parseAskModeBody,
  resolveAskMode,
  autoPlanEmployee,
  stampPlanStepsForMode,
  validateEmployeeSelection,
  type OrgEmployeeRow,
} from '../ask-mode';
import { heuristicCrewPlan } from '../crew-planner';
import type { CrewRosterMember } from '@darex/shared-types';

const FINANCE: OrgEmployeeRow = {
  id: '11111111-1111-1111-1111-111111111111',
  name: 'Finance',
  role: 'Finance',
  status: 'active',
  tool_allowlist: ['stripe'],
};
const SARAH: OrgEmployeeRow = {
  id: '22222222-2222-2222-2222-222222222222',
  name: 'Sarah',
  role: 'Sales',
  status: 'active',
  tool_allowlist: ['gmail', 'hubspot'],
};
const GROWTH: OrgEmployeeRow = {
  id: '33333333-3333-3333-3333-333333333333',
  name: 'Growth',
  role: 'Growth',
  status: 'active',
  tool_allowlist: ['apollo'],
};
const OPS: OrgEmployeeRow = {
  id: '44444444-4444-4444-4444-444444444444',
  name: 'Operations',
  role: 'Operations',
  status: 'active',
  tool_allowlist: ['google-sheets'],
};
const PAUSED: OrgEmployeeRow = {
  id: '55555555-5555-5555-5555-555555555555',
  name: 'Paused Emp',
  role: 'Support',
  status: 'paused',
  tool_allowlist: ['zendesk'],
};
const OTHER_ORG_ID = '99999999-9999-9999-9999-999999999999';

const ORG = [FINANCE, SARAH, GROWTH, OPS, PAUSED];

describe('parseAskModeBody', () => {
  it('treats omitted mode as undefined and ignores plan flag', () => {
    expect(parseAskModeBody({ prompt: 'hi' })).toEqual({ mode: undefined, employeeIds: undefined });
    expect(parseAskModeBody({ mode: 'plan' }).mode).toBeUndefined();
  });
});

describe('validateEmployeeSelection / resolveAskMode', () => {
  it('auto ignores employeeIds', () => {
    const result = validateEmployeeSelection({
      mode: 'auto',
      employeeIds: [SARAH.id, FINANCE.id, GROWTH.id, OPS.id],
      orgEmployees: ORG,
      previouslySavedIds: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mode).toBe('auto');
    expect(result.employees).toEqual([]);
  });

  it('resolveAskMode auto leaves routing open for the domain router', () => {
    const resolved = resolveAskMode({
      bodyMode: 'auto',
      bodyEmployeeIds: [SARAH.id, FINANCE.id],
      conversationMode: 'single',
      conversationEmployeeIds: [SARAH.id],
      lastChoiceMode: 'single',
      lastChoiceEmployeeIds: [SARAH.id],
      conversationIsUnset: false,
      orgEmployees: ORG,
      messageText: 'Create a payment link for invoice 1042',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.selection.persistMode).toBe('auto');
    expect(resolved.selection.persistEmployeeIds).toEqual([]);
    expect(resolved.selection.turnMode).toBe('auto');
    expect(resolved.selection.turnEmployeeIds).toEqual([]);
    expect(resolved.selection.routing.overriddenByMention).toBe(false);
    expect(resolved.selection.routing.reason).toMatch(/Auto/i);
  });

  it('resolveAskMode single locks the selected employee for the turn', () => {
    const resolved = resolveAskMode({
      bodyMode: 'single',
      bodyEmployeeIds: [SARAH.id],
      conversationMode: 'auto',
      conversationEmployeeIds: [],
      lastChoiceMode: 'auto',
      lastChoiceEmployeeIds: [],
      conversationIsUnset: true,
      orgEmployees: ORG,
      messageText: 'draft a follow-up email',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.selection.persistMode).toBe('single');
    expect(resolved.selection.persistEmployeeIds).toEqual([SARAH.id]);
    expect(resolved.selection.turnMode).toBe('single');
    expect(resolved.selection.turnEmployeeIds).toEqual([SARAH.id]);
    expect(resolved.selection.routing.employeeNames).toEqual(['Sarah']);
    expect(resolved.selection.routing.reason).toMatch(/Locked to Sarah/);
  });

  it('resolveAskMode team keeps the fixed member set (cap 3)', () => {
    const resolved = resolveAskMode({
      bodyMode: 'team',
      bodyEmployeeIds: [GROWTH.id, FINANCE.id, OPS.id],
      conversationMode: 'auto',
      conversationEmployeeIds: [],
      lastChoiceMode: 'auto',
      lastChoiceEmployeeIds: [],
      conversationIsUnset: true,
      orgEmployees: ORG,
      messageText: 'hi',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.selection.persistMode).toBe('team');
    expect(resolved.selection.turnMode).toBe('team');
    expect(resolved.selection.turnEmployeeIds).toEqual([GROWTH.id, FINANCE.id, OPS.id]);
    expect(resolved.selection.routing.reason).toMatch(/Team:/);
    expect(resolved.selection.routing.employeeNames).toEqual(['Growth', 'Finance', 'Operations']);
  });

  it('single requires exactly 1 id', () => {
    const none = validateEmployeeSelection({
      mode: 'single',
      employeeIds: [],
      orgEmployees: ORG,
      previouslySavedIds: [],
    });
    expect(none.ok).toBe(false);

    const two = validateEmployeeSelection({
      mode: 'single',
      employeeIds: [SARAH.id, FINANCE.id],
      orgEmployees: ORG,
      previouslySavedIds: [],
    });
    expect(two.ok).toBe(false);

    const one = validateEmployeeSelection({
      mode: 'single',
      employeeIds: [SARAH.id],
      orgEmployees: ORG,
      previouslySavedIds: [],
    });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.employees.map((e) => e.id)).toEqual([SARAH.id]);
  });

  it('team rejects more than ASK_TEAM_MAX after dedupe', () => {
    expect(ASK_TEAM_MAX).toBe(3);
    const four = validateEmployeeSelection({
      mode: 'team',
      employeeIds: [SARAH.id, FINANCE.id, GROWTH.id, OPS.id],
      orgEmployees: ORG,
      previouslySavedIds: [],
    });
    expect(four.ok).toBe(false);
    if (four.ok) return;
    expect(four.error).toMatch(/1 to 3/);

    const collapseOk = validateEmployeeSelection({
      mode: 'team',
      employeeIds: [SARAH.id, FINANCE.id, GROWTH.id, SARAH.id],
      orgEmployees: ORG,
      previouslySavedIds: [],
    });
    expect(collapseOk.ok).toBe(true);
  });

  it('rejects other-org / unknown id as fresh selection', () => {
    const result = validateEmployeeSelection({
      mode: 'single',
      employeeIds: [OTHER_ORG_ID],
      orgEmployees: ORG,
      previouslySavedIds: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Unknown employeeId/);
  });

  it('paused id produces fallback to auto, not a locked route', () => {
    const fresh = validateEmployeeSelection({
      mode: 'single',
      employeeIds: [PAUSED.id],
      orgEmployees: ORG,
      previouslySavedIds: [],
    });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.mode).toBe('auto');
    expect(fresh.employees).toEqual([]);
    expect(fresh.fallbackNotice).toMatch(/not active/i);

    const resolved = resolveAskMode({
      bodyMode: 'single',
      bodyEmployeeIds: [PAUSED.id],
      conversationMode: 'auto',
      conversationEmployeeIds: [],
      lastChoiceMode: 'auto',
      lastChoiceEmployeeIds: [],
      conversationIsUnset: true,
      orgEmployees: ORG,
      messageText: 'send the invoice',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.selection.turnMode).toBe('auto');
    expect(resolved.selection.routing.fallbackNotice).toBeTruthy();
    expect(resolved.selection.routing.employeeIds).toEqual([]);
  });

  it('@Name override beats single mode for that message only', () => {
    const resolved = resolveAskMode({
      bodyMode: 'single',
      bodyEmployeeIds: [SARAH.id],
      conversationMode: 'single',
      conversationEmployeeIds: [SARAH.id],
      lastChoiceMode: 'single',
      lastChoiceEmployeeIds: [SARAH.id],
      conversationIsUnset: false,
      orgEmployees: ORG,
      messageText: '@Finance please create a payment link',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.selection.persistMode).toBe('single');
    expect(resolved.selection.persistEmployeeIds).toEqual([SARAH.id]);
    expect(resolved.selection.turnMode).toBe('single');
    expect(resolved.selection.turnEmployeeIds).toEqual([FINANCE.id]);
    expect(resolved.selection.routing.overriddenByMention).toBe(true);
    expect(resolved.selection.routing.employeeNames).toEqual(['Finance']);
    expect(resolved.selection.routing.reason).toMatch(/Locked to Finance/);
  });

  it('@Name override beats team mode for that message only without changing persist', () => {
    const resolved = resolveAskMode({
      bodyMode: 'team',
      bodyEmployeeIds: [GROWTH.id, OPS.id],
      conversationMode: 'team',
      conversationEmployeeIds: [GROWTH.id, OPS.id],
      lastChoiceMode: 'team',
      lastChoiceEmployeeIds: [GROWTH.id, OPS.id],
      conversationIsUnset: false,
      orgEmployees: ORG,
      messageText: '@Finance please create a payment link',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.selection.persistMode).toBe('team');
    expect(resolved.selection.persistEmployeeIds).toEqual([GROWTH.id, OPS.id]);
    expect(resolved.selection.turnMode).toBe('single');
    expect(resolved.selection.turnEmployeeIds).toEqual([FINANCE.id]);
    expect(resolved.selection.routing.overriddenByMention).toBe(true);
  });
});

describe('helpers', () => {
  it('dedupeIds preserves order', () => {
    expect(dedupeIds([SARAH.id, FINANCE.id, SARAH.id])).toEqual([SARAH.id, FINANCE.id]);
  });

  it('fixedTeamCrewPlan does not invent membership', () => {
    const plan = fixedTeamCrewPlan('do the work', [GROWTH, FINANCE, OPS]);
    expect(plan.mode).toBe('crew');
    expect(plan.specialists.map((s) => s.employeeId)).toEqual([GROWTH.id, FINANCE.id, OPS.id]);
  });

  it('fixedTeamCrewPlan keeps members a greeting heuristic would drop, capped at 3', () => {
    // Greeting heuristic stays solo on the first active roster member (Sarah here).
    const roster: CrewRosterMember[] = [SARAH, GROWTH, OPS, FINANCE].map((e) => ({
      id: e.id,
      name: e.name,
      role: e.role || '',
      persona: '',
      tool_allowlist: Array.isArray(e.tool_allowlist) ? e.tool_allowlist.map(String) : [],
      status: 'active' as const,
    }));
    const heuristic = heuristicCrewPlan('hi', roster);
    expect(heuristic.mode).toBe('solo');
    expect(heuristic.specialists.map((s) => s.employeeId)).toEqual([SARAH.id]);
    expect(heuristic.specialists.some((s) => s.employeeId === FINANCE.id)).toBe(false);

    const four = [GROWTH, FINANCE, OPS, SARAH];
    const fixed = fixedTeamCrewPlan('hi', four);
    expect(fixed.mode).toBe('crew');
    expect(fixed.specialists).toHaveLength(ASK_TEAM_MAX);
    expect(fixed.specialists.map((s) => s.employeeId)).toEqual([
      GROWTH.id,
      FINANCE.id,
      OPS.id,
    ]);
    // Finance would have been dropped by the greeting heuristic; fixed team still includes them.
    expect(fixed.specialists.some((s) => s.employeeId === FINANCE.id)).toBe(true);
    expect(fixed.specialists.some((s) => s.employeeId === SARAH.id)).toBe(false);
  });

  it('stampPlanStepsForMode locks single and assigns team across members only', () => {
    const steps = [
      { id: 'step-1', description: 'a', tool: 'stripe', action: 'x', enabled: true },
      { id: 'step-2', description: 'b', tool: 'apollo', action: 'y', enabled: true },
    ];
    const single = stampPlanStepsForMode(steps, 'single', [SARAH]);
    expect(single.every((s) => s.employeeId === SARAH.id)).toBe(true);

    const team = stampPlanStepsForMode(steps, 'team', [FINANCE, GROWTH]);
    expect(team[0].employeeId).toBe(FINANCE.id);
    expect(team[1].employeeId).toBe(GROWTH.id);
  });

  it('autoRoutingReason says why in words a customer uses, not the router\u2019s internal notes', () => {
    const cases: Array<[string, RegExp]> = [
      ['low confidence — support, not round-robin', /not sure which team fits/i],
      ['low confidence — Executive fallback', /no clear match/i],
      ['general question — executive, not a specialist', /general question/i],
      ['greeting — solo support, no crew', /greeting/i],
      ['about the assistant — solo support, no crew', /about the assistant/i],
      ['emergency keyword — dispatch, not ISA', /urgent/i],
      ['daily brief — Executive', /daily summary/i],
      ['founder/company question — Research', /research/i],
      ['keyword match', /matches/i],
    ];
    for (const [raw, want] of cases) {
      const text = autoRoutingReason('Emma', raw);
      expect(text).toMatch(/^Routed to Emma: /);
      expect(text).toMatch(want);
      expect(text).not.toMatch(/round-robin|ISA|crew|fallback|keyword|confidence|specialist/i);
    }
  });

  it('autoRoutingReason formats domain routes', () => {
    expect(autoRoutingReason('Finance', 'payment link')).toBe('Routed to Finance: payment link');
  });
});

describe('autoPlanEmployee', () => {
  const rows: OrgEmployeeRow[] = [
    { id: 'a', name: 'Growth', role: 'Growth', status: 'active' },
    { id: 'e', name: 'Exec', role: 'Executive', status: 'active' },
    { id: 'p', name: 'Paused', role: 'Research', status: 'paused' },
  ];
  it('uses the routed employee when active', () => {
    expect(autoPlanEmployee(rows, 'a')?.id).toBe('a');
  });
  it('falls back to the Executive when routing found nobody or a paused one', () => {
    expect(autoPlanEmployee(rows, null)?.id).toBe('e');
    expect(autoPlanEmployee(rows, 'p')?.id).toBe('e');
  });
  it('returns null with no active employee', () => {
    expect(autoPlanEmployee([rows[2]], null)).toBeNull();
  });
});
