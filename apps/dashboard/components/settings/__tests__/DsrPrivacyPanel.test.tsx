import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { DsrPrivacyPanel } from '../DsrPrivacyPanel';

describe('DsrPrivacyPanel delete visibility', () => {
  beforeEach(() => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ requests: [] }) } as Response)
    ) as unknown as typeof fetch;
  });

  it.each(['admin', 'member', 'auditor', null, undefined])(
    'hides Delete for role %s but keeps Export',
    async (role) => {
      render(<DsrPrivacyPanel orgSlug="acme" orgName="Acme" viewerRole={role as string | null | undefined} />);
      await waitFor(() => expect(global.fetch).toHaveBeenCalled());
      expect(screen.getByText('Export org data')).toBeTruthy();
      expect(screen.queryByText('Delete org data')).toBeNull();
    }
  );

  it('shows Delete for owner', async () => {
    render(<DsrPrivacyPanel orgSlug="acme" orgName="Acme" viewerRole="owner" />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(screen.getByText('Delete org data')).toBeTruthy();
  });
});
