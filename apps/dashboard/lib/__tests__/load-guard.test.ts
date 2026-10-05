/**
 * When a page's script files cannot be loaded, the page still appears, and then nothing responds to clicks. The
 * person cannot tell a dead page from a slow one. The guard is a tiny script written into the server-rendered HTML
 * (so it runs even when every other script file is missing) that says so on screen. It must:
 *   - speak up as soon as a Next.js script or style file fails to load,
 *   - speak up if the page has not come alive after a generous wait,
 *   - stay silent for a healthy page, for an unrelated failed image or ad, and for a page that comes alive late,
 *   - never show twice.
 */
import { LOAD_GUARD_SCRIPT, LOAD_GUARD_TIMEOUT_MS, LOAD_GUARD_BANNER_ID } from '@/lib/load-guard';

const banner = () => document.getElementById(LOAD_GUARD_BANNER_ID);
const run = () => (window as unknown as { eval: (s: string) => void }).eval(LOAD_GUARD_SCRIPT);
const failToLoad = (tag: 'script' | 'link' | 'img', url: string) => {
  const el = document.createElement(tag);
  if (tag === 'link') (el as HTMLLinkElement).href = url;
  else (el as HTMLScriptElement).src = url;
  document.head.appendChild(el);
  el.dispatchEvent(new Event('error')); // resource errors do not bubble; the guard listens in the capture phase
};

beforeEach(() => {
  jest.useFakeTimers();
  document.body.innerHTML = '';
  document.head.innerHTML = '';
  delete (window as unknown as { __darexAlive?: boolean }).__darexAlive;
});
afterEach(() => jest.useRealTimers());

describe('load guard', () => {
  it('says so at once when a Next.js script file fails to load', () => {
    run();
    failToLoad('script', '/_next/static/chunks/app/(auth)/register/page-abc.js');
    const b = banner();
    expect(b).not.toBeNull();
    expect(b!.getAttribute('role')).toBe('alert');
    expect(b!.textContent).toMatch(/failed to load|didn.?t load|reload/i);
    expect(b!.textContent).not.toMatch(/undefined|Error:|chunk/i);
  });

  it('says so when a Next.js style file fails to load', () => {
    run();
    failToLoad('link', '/_next/static/css/abc.css');
    expect(banner()).not.toBeNull();
  });

  it('ignores a failed image or a script that is not ours', () => {
    run();
    failToLoad('img', '/_next/static/media/logo.png');
    failToLoad('script', 'https://ads.example.com/tracker.js');
    expect(banner()).toBeNull();
  });

  it('says so when the page has not come alive after the wait', () => {
    run();
    jest.advanceTimersByTime(LOAD_GUARD_TIMEOUT_MS - 1);
    expect(banner()).toBeNull();
    jest.advanceTimersByTime(2);
    expect(banner()).not.toBeNull();
  });

  it('stays silent for a page that came alive', () => {
    run();
    (window as unknown as { __darexAlive: boolean }).__darexAlive = true;
    jest.advanceTimersByTime(LOAD_GUARD_TIMEOUT_MS * 3);
    expect(banner()).toBeNull();
  });

  it('shows only one banner however many files fail', () => {
    run();
    failToLoad('script', '/_next/static/chunks/a.js');
    failToLoad('script', '/_next/static/chunks/b.js');
    jest.advanceTimersByTime(LOAD_GUARD_TIMEOUT_MS * 2);
    expect(document.querySelectorAll(`#${LOAD_GUARD_BANNER_ID}`)).toHaveLength(1);
  });

  it('offers a reload button', () => {
    run();
    failToLoad('script', '/_next/static/chunks/a.js');
    expect(banner()!.querySelector('button')?.textContent).toMatch(/reload/i);
  });
});
