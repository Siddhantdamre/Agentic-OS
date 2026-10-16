import { matchesDsrDeleteConfirm, normalizeConfirmPhrase } from '../dsr-confirm';
import { canDeleteDsr, canExportDsr, type HumanRole } from '../rbac';

describe('matchesDsrDeleteConfirm', () => {
  it('accepts matching org slug (case-insensitive)', () => {
    expect(
      matchesDsrDeleteConfirm({
        confirm: 'Acme-Corp',
        orgSlug: 'acme-corp',
        orgName: 'Acme Corporation',
      })
    ).toBe(true);
  });

  it('accepts exact org name (case-insensitive)', () => {
    expect(
      matchesDsrDeleteConfirm({
        confirm: '  Acme Corporation  ',
        orgSlug: 'acme-corp',
        orgName: 'Acme Corporation',
      })
    ).toBe(true);
  });

  it('rejects empty or mismatched confirmation', () => {
    expect(
      matchesDsrDeleteConfirm({
        confirm: '',
        orgSlug: 'acme-corp',
        orgName: 'Acme',
      })
    ).toBe(false);
    expect(
      matchesDsrDeleteConfirm({
        confirm: 'wrong',
        orgSlug: 'acme-corp',
        orgName: 'Acme',
      })
    ).toBe(false);
    expect(
      matchesDsrDeleteConfirm({
        confirm: null,
        orgSlug: 'acme-corp',
        orgName: 'Acme',
      })
    ).toBe(false);
  });

  it('normalizeConfirmPhrase trims and lowercases', () => {
    expect(normalizeConfirmPhrase('  Foo Bar  ')).toBe('foo bar');
    expect(normalizeConfirmPhrase(42)).toBe('');
  });
});

describe('DSR RBAC', () => {
  const roles: HumanRole[] = ['owner', 'admin', 'member', 'auditor', 'billing'];

  it('only owner may delete', () => {
    expect(canDeleteDsr('owner')).toBe(true);
    for (const role of roles.filter((r) => r !== 'owner')) {
      expect(canDeleteDsr(role)).toBe(false);
    }
  });

  it('owner and admin may export; member, auditor, and billing denied', () => {
    expect(canExportDsr('owner')).toBe(true);
    expect(canExportDsr('admin')).toBe(true);
    expect(canExportDsr('member')).toBe(false);
    expect(canExportDsr('auditor')).toBe(false);
    expect(canExportDsr('billing')).toBe(false);
  });
});
