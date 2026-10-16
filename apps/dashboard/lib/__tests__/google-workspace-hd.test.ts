import { googleWorkspaceHd } from '../google-workspace-hd';

describe('googleWorkspaceHd', () => {
  const prev = process.env.GOOGLE_WORKSPACE_HD;
  afterEach(() => {
    if (prev === undefined) delete process.env.GOOGLE_WORKSPACE_HD;
    else process.env.GOOGLE_WORKSPACE_HD = prev;
  });

  it('fails closed when unset or blank', () => {
    delete process.env.GOOGLE_WORKSPACE_HD;
    expect(googleWorkspaceHd()).toBeNull();
    process.env.GOOGLE_WORKSPACE_HD = '  ';
    expect(googleWorkspaceHd()).toBeNull();
  });

  it('returns the configured domain or explicit wildcard', () => {
    process.env.GOOGLE_WORKSPACE_HD = 'acme.com';
    expect(googleWorkspaceHd()).toBe('acme.com');
    process.env.GOOGLE_WORKSPACE_HD = '*';
    expect(googleWorkspaceHd()).toBe('*');
  });
});
