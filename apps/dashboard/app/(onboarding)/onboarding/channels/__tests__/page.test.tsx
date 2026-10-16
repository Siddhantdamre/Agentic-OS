import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const push = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

import OnboardingChannelsPage from '../page';
import { useOnboardingStore } from '@/lib/store';

/**
 * The last onboarding step. A person who has just signed up reads this screen and presses its one big button.
 * What they must never meet: a button that is dead with no explanation, a red box that says
 * "Unexpected end of JSON input", or a sentence about "seeding a pending row".
 */
describe('onboarding: channels step', () => {
  beforeEach(() => {
    push.mockReset();
    useOnboardingStore.setState({ businessName: 'Acme Homes', teamSize: 5, businessType: 'real_estate', selectedChannels: ['whatsapp', 'email'] });
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  it('explains why the main button is disabled when no channel is chosen', () => {
    useOnboardingStore.setState({ selectedChannels: [] });
    render(<OnboardingChannelsPage />);
    const button = screen.getByRole('button', { name: /complete setup|finish|continue|bring/i });
    expect(button).toBeDisabled();
    expect(screen.getByText(/choose at least one/i)).toBeInTheDocument();
  });

  it('does not show the hint once a channel is chosen, and the button works', () => {
    render(<OnboardingChannelsPage />);
    expect(screen.queryByText(/choose at least one/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /complete setup|finish|continue|bring/i })).toBeEnabled();
  });

  it('shows a plain sentence, not a parser error, when the server answers with an empty failure', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new SyntaxError('Unexpected end of JSON input')),
    });
    render(<OnboardingChannelsPage />);
    fireEvent.click(screen.getByRole('button', { name: /complete setup|finish|continue|bring/i }));
    // The message is shown twice on purpose: once in the red box, once in a live region for screen readers.
    const shown = await screen.findAllByText(/couldn.?t|try again/i);
    for (const el of shown) expect(el.textContent).not.toMatch(/JSON|SyntaxError|Unexpected|undefined/i);
    expect(push).not.toHaveBeenCalled();
  });

  it('shows the server’s own sentence when it sends one', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ message: 'That business name is already taken.' }),
    });
    render(<OnboardingChannelsPage />);
    fireEvent.click(screen.getByRole('button', { name: /complete setup|finish|continue|bring/i }));
    expect((await screen.findAllByText(/already taken/i)).length).toBeGreaterThan(0);
  });

  it('keeps developer wording off the screen', () => {
    const { container } = render(<OnboardingChannelsPage />);
    expect(container.textContent).not.toMatch(/pending row|seeds a|mark the connector|Provisioning|Cloud API/i);
  });

  it('moves on to the dashboard after a successful save', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    render(<OnboardingChannelsPage />);
    fireEvent.click(screen.getByRole('button', { name: /complete setup|finish|continue|bring/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(String(push.mock.calls[0][0])).toMatch(/^\//);
  });
});
