import { channelName, welcomeText, starterPrompts } from '../ask-ai-welcome';

const JARGON = /OAuth|database_query|web_search|web_extract|file_ops|mcp\.|\/connectors|\bTrueForge\b|invent/i;
/** The words a person reads: a link's address is not one of them. */
const read = (md: string) => md.replace(/\]\([^)]*\)/g, ']');

describe('Ask AI first message', () => {
  it('speaks plainly to a workspace with nothing connected', () => {
    const t = welcomeText('Maple Realty', []);
    expect(t).toContain('Maple Realty');
    expect(read(t)).not.toMatch(JARGON);
    expect(t).toMatch(/Connect/);
    expect(t).toMatch(/\]\(\/connectors\)/);
    expect(t).toMatch(/before it is sent/i);
  });

  it('names the connected apps in words, not codes', () => {
    const t = welcomeText('Maple Realty', ['gmail', 'google-calendar', 'whatsapp']);
    expect(t).toContain('Gmail');
    expect(t).toContain('Google Calendar');
    expect(t).toContain('WhatsApp');
    expect(read(t)).not.toMatch(JARGON);
    expect(t).not.toMatch(/google-calendar/);
  });

  it('makes an unknown channel code readable instead of printing it raw', () => {
    expect(channelName('google-calendar')).toBe('Google Calendar');
    expect(channelName('some_new-thing')).toBe('Some new thing');
    expect(channelName('')).toBe('');
  });
});

describe('starter prompts', () => {
  it('always offers four useful things, none of which need an app to be connected', () => {
    const s = starterPrompts([]);
    expect(s.length).toBe(4);
    for (const x of s) {
      expect(x.label.length).toBeGreaterThan(5);
      expect(x.prompt.length).toBeGreaterThan(15);
      expect(`${x.label} ${x.prompt}`).not.toMatch(JARGON);
    }
  });

  it('never makes up an address or contact for the person to send to', () => {
    for (const ch of [[], ['gmail'], ['gmail', 'google-calendar', 'hubspot', 'whatsapp', 'google-ads']]) {
      for (const x of starterPrompts(ch)) expect(x.prompt).not.toMatch(/@company\.com|example\.(com|test)|lead@/i);
    }
  });

  it('puts what a connected app can do first, and still shows only four', () => {
    const s = starterPrompts(['gmail', 'google-calendar']);
    expect(s.length).toBe(4);
    expect(s[0].label).toMatch(/email|inbox|reply/i);
    expect(s.some((x) => /calendar|tomorrow|schedule/i.test(x.label + x.prompt))).toBe(true);
  });

  it('always offers to say who owes the owner money, however many apps are connected', () => {
    for (const ch of [[], ['gmail'], ['gmail', 'google-calendar', 'hubspot', 'whatsapp', 'google-ads']]) {
      const s = starterPrompts(ch);
      expect(s.length).toBe(4);
      expect(s.some((x) => /owes me money/i.test(x.label))).toBe(true);
    }
  });

  it('does not offer an app task for an app that is not connected', () => {
    const labels = starterPrompts([]).map((x) => x.label + x.prompt).join(' ');
    expect(labels).not.toMatch(/Gmail|HubSpot|Calendar|Ads/i);
  });
});
