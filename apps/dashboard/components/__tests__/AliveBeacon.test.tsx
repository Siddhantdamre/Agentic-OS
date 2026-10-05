import React from 'react';
import { render } from '@testing-library/react';
import { AliveBeacon } from '@/components/AliveBeacon';
import { LOAD_GUARD_BANNER_ID } from '@/lib/load-guard';

/** React marks the page alive; if the guard already warned (a slow start), the warning goes away on its own. */
describe('AliveBeacon', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    delete (window as unknown as { __darexAlive?: boolean }).__darexAlive;
  });

  it('marks the page alive once React has taken over', () => {
    render(<AliveBeacon />);
    expect((window as unknown as { __darexAlive?: boolean }).__darexAlive).toBe(true);
  });

  it('removes a warning that was shown while the page was still starting', () => {
    const b = document.createElement('div');
    b.id = LOAD_GUARD_BANNER_ID;
    document.body.appendChild(b);
    render(<AliveBeacon />);
    expect(document.getElementById(LOAD_GUARD_BANNER_ID)).toBeNull();
  });
});
