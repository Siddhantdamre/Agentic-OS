/**
 * @jest-environment node
 *
 * On a phone, a control has to be big enough to tap. Measured in a real browser at 375 px wide before this rule:
 * 143 controls were under the 24 px minimum of WCAG 2.2, and five of them repeated on every card or page
 * ("Test & details", "View Details & Test", "Connector Settings", "Connect missing tools", and the banner's
 * dismiss button). The fix is one touch-only rule (desktop looks the same) and a class on those controls.
 * The browser check (mobile-check.js) measures the real result.
 */
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('touch targets', () => {
  it('has a touch-only rule that makes .touch-target at least 44 px tall and wide', () => {
    const css = read('app/globals.css');
    const block = css.match(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/\.touch-target\s*\{[^}]*min-height:\s*44px/);
    expect(block![1]).toMatch(/\.touch-target\s*\{[^}]*min-width:\s*44px/);
  });

  const CONTROLS: Array<[string, RegExp]> = [
    ['app/(dashboard)/connectors/page.tsx', /className="[^"]*touch-target[^"]*"[^>]*>\s*<ExternalLink[^>]*\/>\s*<span>Test & details/],
    ['app/(dashboard)/integrations/page.tsx', /className="[^"]*touch-target[^"]*"\s*>\s*<span>View Details & Test/],
    ['app/(dashboard)/skills/page.tsx', /className="[^"]*touch-target[^"]*"\s*>\s*<Plug[^>]*\/>\s*<span>Connector Settings/],
    ['app/(dashboard)/employees/page.tsx', /className="[^"]*touch-target[^"]*"\s*>\s*Connect missing tools/],
    ['components/SystemDegradationBanner.tsx', /className="[^"]*touch-target[^"]*"\s*aria-label="Dismiss status banner"/],
  ];
  it.each(CONTROLS)('%s marks its small control as a touch target', (file, re) => {
    expect(read(file)).toMatch(re);
  });
});
