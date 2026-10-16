import {
  TEAM_EMPLOYEE_CAP,
  deriveToolCount,
  employeeIdsForRequest,
  filterEmployeesBySearch,
  normalizeAskMode,
  parseToolAllowlist,
  toggleTeamSelection,
  type AskEmployeeOption,
} from '../ask-mode-selection';

const roster: AskEmployeeOption[] = [
  {
    id: '1',
    name: 'Marcus',
    role: 'Growth',
    toolCount: 3,
    toolCountLabel: 'connected',
    status: 'active',
  },
  {
    id: '2',
    name: 'Sarah',
    role: 'Customer Support',
    toolCount: 2,
    toolCountLabel: 'connected',
    status: 'active',
  },
  {
    id: '3',
    name: 'Emma',
    role: 'Finance',
    toolCount: 1,
    toolCountLabel: 'tools',
    status: 'active',
  },
];

describe('ask-mode-selection', () => {
  describe('normalizeAskMode', () => {
    it('accepts auto, single, team and defaults unknown to auto', () => {
      expect(normalizeAskMode('auto')).toBe('auto');
      expect(normalizeAskMode('single')).toBe('single');
      expect(normalizeAskMode('team')).toBe('team');
      expect(normalizeAskMode('crew')).toBe('auto');
      expect(normalizeAskMode(undefined)).toBe('auto');
    });
  });

  describe('filterEmployeesBySearch', () => {
    it('filters by name or role case-insensitively', () => {
      expect(filterEmployeesBySearch(roster, 'mar')).toEqual([roster[0]]);
      expect(filterEmployeesBySearch(roster, 'finance')).toEqual([roster[2]]);
      expect(filterEmployeesBySearch(roster, '  SUPPORT ')).toEqual([roster[1]]);
      expect(filterEmployeesBySearch(roster, '')).toHaveLength(3);
      expect(filterEmployeesBySearch(roster, 'zzz')).toHaveLength(0);
    });
  });

  describe('toggleTeamSelection', () => {
    it('adds and removes ids', () => {
      expect(toggleTeamSelection([], 'a').ids).toEqual(['a']);
      expect(toggleTeamSelection(['a', 'b'], 'a').ids).toEqual(['b']);
    });

    it(`hard-caps at ${TEAM_EMPLOYEE_CAP} and reports atCap`, () => {
      const full = ['a', 'b', 'c'];
      const blocked = toggleTeamSelection(full, 'd');
      expect(blocked.ids).toEqual(full);
      expect(blocked.atCap).toBe(true);
      expect(blocked.added).toBe(false);

      const atTwo = toggleTeamSelection(['a', 'b'], 'c');
      expect(atTwo.ids).toEqual(['a', 'b', 'c']);
      expect(atTwo.atCap).toBe(true);
      expect(atTwo.added).toBe(true);
    });
  });

  describe('employeeIdsForRequest', () => {
    it('sends [] for auto, one id for single, up to cap for team', () => {
      expect(employeeIdsForRequest('auto', ['x', 'y'])).toEqual([]);
      expect(employeeIdsForRequest('single', ['x', 'y'])).toEqual(['x']);
      expect(employeeIdsForRequest('team', ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c']);
    });
  });

  describe('deriveToolCount', () => {
    it('labels allowlist length as tools when channels are unknown', () => {
      expect(deriveToolCount(['gmail', 'hubspot'], null)).toEqual({
        count: 2,
        label: 'tools',
      });
    });

    it('counts connected tools when channels are known', () => {
      expect(deriveToolCount(['gmail', 'hubspot', 'web_search'], ['gmail'])).toEqual({
        count: 2, // gmail + always-ready web_search
        label: 'connected',
      });
    });

    it('parses string allowlists', () => {
      expect(parseToolAllowlist('gmail,slack')).toEqual(['gmail', 'slack']);
      expect(parseToolAllowlist('["notion"]')).toEqual(['notion']);
    });
  });
});
