import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

import TeamSizePage from '../onboarding/team-size/page';
import BusinessTypePage from '../onboarding/business-type/page';

/** Controls with no text must still have a name, or a screen reader says only "button" or "slider". */
describe('onboarding controls have names', () => {
  it('team size: the slider and the back button', () => {
    render(<TeamSizePage />);
    expect(screen.getByRole('slider', { name: /team size/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /back/i })).toBeTruthy();
  });

  it('business type: the back button', () => {
    render(<BusinessTypePage />);
    expect(screen.getByRole('button', { name: /back/i })).toBeTruthy();
  });
});
