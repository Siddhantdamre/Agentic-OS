/**
 * @jest-environment node
 *
 * A page that is in the sidebar but not in the phone menu cannot be reached from a phone. This
 * compares the two lists so a new page cannot be added to one and forgotten in the other.
 */
import fs from 'fs';
import path from 'path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const hrefs = (src: string) => [...src.matchAll(/href:\s*'([^']+)'/g)].map((m) => m[1]);

describe('navigation parity', () => {
  const sidebar = hrefs(read('shell/AppShell.tsx'));
  const phone = new Set(hrefs(read('a11y/BottomTabs.tsx')));

  it('finds both lists', () => {
    expect(sidebar.length).toBeGreaterThan(15);
    expect(phone.size).toBeGreaterThan(15);
  });

  it('offers every sidebar page on a phone too', () => {
    expect(sidebar.filter((h) => !phone.has(h))).toEqual([]);
  });
});
