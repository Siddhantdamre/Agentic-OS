jest.mock('@darex/workflows/dist/route-employee', () => ({ route: () => null }));
jest.mock('@darex/workflows/dist/tool-executor', () => ({
  mergeRuntimeAllowlist: (list: string[] = [], connected: string[] = []) => [...new Set([...list, ...connected])],
}));

import { allowlistForEmployeeTurn, allowlistForLockedEmployeeTurn } from '@/lib/ask-employee';

const GOOGLE_ACCOUNTS = [
  'gmail',
  'google-calendar',
  'google-drive',
  'google-docs',
  'google-sheets',
  'google-slides',
  'google-forms',
  'google-chat',
  'google-meet',
  'google-contacts',
  'google-tasks',
  'google-analytics',
  'google-search-console',
  'google-business-profile',
  'google-cloud',
  'google-ads',
];

describe('oauth tools from chat', () => {
  it('an empty card is core reads only, not every connected Google account', () => {
    const tools = allowlistForEmployeeTurn([], [], [], 'Executive');
    expect(tools).toEqual(expect.arrayContaining(['web-search', 'database-query']));
    for (const account of GOOGLE_ACCOUNTS) {
      expect(tools).not.toContain(account);
    }
    expect(tools).not.toContain('terminal-run-command');
    expect(tools).not.toContain('sandbox');
  });

  it('a locked employee keeps only the accounts that employee owns', () => {
    const tools = allowlistForLockedEmployeeTurn(['gmail'], [], 'Sales & Lead Gen');
    expect(tools).toContain('gmail');
    expect(tools).not.toContain('google-drive');
    expect(tools).not.toContain('microsoft-outlook');
  });
});
