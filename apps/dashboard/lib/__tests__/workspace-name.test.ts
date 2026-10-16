import { parseWorkspaceName, WORKSPACE_NAME_MAX } from '../workspace-name';

describe('parseWorkspaceName', () => {
  it('trims and collapses whitespace', () => {
    expect(parseWorkspaceName('  Acme   Pune  ')).toBe('Acme Pune');
  });
  it('rejects empty, non-string, too long and control characters', () => {
    expect(parseWorkspaceName('   ')).toBeNull();
    expect(parseWorkspaceName(42)).toBeNull();
    expect(parseWorkspaceName(undefined)).toBeNull();
    expect(parseWorkspaceName('x'.repeat(WORKSPACE_NAME_MAX + 1))).toBeNull();
    expect(parseWorkspaceName('bad\u0007name')).toBeNull();
  });
  it('accepts the maximum length', () => {
    expect(parseWorkspaceName('x'.repeat(WORKSPACE_NAME_MAX))).toHaveLength(WORKSPACE_NAME_MAX);
  });
});
