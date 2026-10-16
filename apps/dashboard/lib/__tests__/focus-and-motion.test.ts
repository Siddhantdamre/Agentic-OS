/**
 * @jest-environment node
 *
 * Keyboard focus and reduced motion live in one place, globals.css, so no screen has to remember them.
 * Measured in a real browser before this rule existed: of 169 keyboard stops across 11 pages, 6 showed no outline or
 * ring at all (the sign-in and sign-up fields and the conversation reply box). This test pins the rule; the browser
 * check (focus-check.js) proves it wins over the `outline-none` utility classes on the actual screens.
 */
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'globals.css'), 'utf8');

describe('globals.css', () => {
  it('shows a visible outline on keyboard focus for every interactive element', () => {
    const rule = css.match(/:is\([^{]*\):focus-visible[^{]*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    const body = rule![1];
    expect(body).toMatch(/outline:\s*\d+px\s+solid\s+#[0-9a-f]{3,8}/i);
    expect(body).not.toMatch(/outline:\s*none|transparent/i);
  });

  it('raises the rule above the utility classes that clear the outline (a doubled pseudo-class)', () => {
    // `.focus\:outline-none:focus` has specificity (0,2,0); a single `:focus-visible` would lose to it.
    expect(css).toMatch(/:focus-visible:focus-visible/);
  });

  it('does not ring elements that are only focused by script (tabindex -1)', () => {
    expect(css).toMatch(/\[tabindex\]:not\(\[tabindex="-1"\]\)/);
  });

  it('honours the reduced-motion setting', () => {
    const block = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/animation-duration:\s*0?\.01ms/);
    expect(block![1]).toMatch(/transition-duration:\s*0?\.01ms/);
  });
});
