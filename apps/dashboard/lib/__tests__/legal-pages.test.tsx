import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({
  useRouter: () => ({ push: jest.fn() }),
  useSearchParams: () => ({ get: () => null }),
}));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...r }: any) => <a href={href} {...r}>{children}</a> }));

import { isPublicAuthPath, isAuthenticatedPublicPath } from '../session-cookie';
import RegisterPage from '../../app/(auth)/register/page';
import TermsPage from '../../app/(legal)/terms/page';
import PrivacyPage from '../../app/(legal)/privacy/page';

/**
 * Sign-up asks people to agree to Terms and a Privacy Policy. The agreement has to be a real choice (not
 * pre-ticked) and both documents have to open, from the sign-up page and for someone already signed in.
 */
describe('terms and privacy', () => {
  it('can be read without an account and by someone already signed in', () => {
    for (const p of ['/terms', '/privacy']) {
      expect(isPublicAuthPath(p)).toBe(true);
      expect(isAuthenticatedPublicPath(p)).toBe(true);
    }
    expect(isAuthenticatedPublicPath('/login')).toBe(false);
  });

  it('the sign-up checkbox starts unticked and the two links go to the real pages', () => {
    render(<RegisterPage />);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByRole('link', { name: 'Terms of Service' }).getAttribute('href')).toBe('/terms');
    expect(screen.getByRole('link', { name: 'Privacy Policy' }).getAttribute('href')).toBe('/privacy');
  });

  it('both pages open in a new tab from sign-up so a half-filled form is not lost', () => {
    render(<RegisterPage />);
    expect(screen.getByRole('link', { name: 'Terms of Service' }).getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('link', { name: 'Privacy Policy' }).getAttribute('target')).toBe('_blank');
  });

  it('say what the product really does with data, and that a lawyer has not yet reviewed them', () => {
    const { container, unmount } = render(<TermsPage />);
    expect(container.textContent).toMatch(/approve/i);
    expect(container.textContent).toMatch(/not yet been reviewed by a lawyer/i);
    unmount();
    const priv = render(<PrivacyPage />);
    expect(priv.container.textContent).toMatch(/export/i);
    expect(priv.container.textContent).toMatch(/delete/i);
    expect(priv.container.textContent).toMatch(/not yet been reviewed by a lawyer/i);
  });

  it('link back to the other document and to sign-up', () => {
    render(<PrivacyPage />);
    expect(screen.getByRole('link', { name: /terms/i }).getAttribute('href')).toBe('/terms');
    expect(screen.getByRole('link', { name: /back to sign up/i }).getAttribute('href')).toBe('/register');
  });
});
