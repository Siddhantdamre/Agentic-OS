/**
 * @jest-environment node
 *
 * WhatsApp auto-reply without the agent: settings validation, the fixed
 * message (with cooldown) and the simple AI reply.
 */
const query = jest.fn();
jest.mock('@/lib/db', () => ({
  pool: { query: jest.fn() },
  getOrgScopedClient: jest.fn(async () => ({ client: { query, release: jest.fn() }, orgId: 'org-1' })),
}));
const deliver = jest.fn();
jest.mock('@/lib/inbound-agent', () => ({ deliverInboundReply: (...a: unknown[]) => deliver(...a) }));
const chat = jest.fn();
jest.mock('@/lib/litellm-client', () => ({ chatCompletion: (...a: unknown[]) => chat(...a) }));

import {
  isWithinBusinessHours,
  normalizeNumbers,
  parseAutoReply,
  personaWithInstructions,
  shouldAutoReply,
  validateAutoReply,
} from '@/lib/whatsapp-auto-reply-config';
import { runWhatsAppAutoReply, simpleSystemPrompt } from '@/lib/whatsapp-auto-reply';

const job = (autoReply: unknown) =>
  ({
    orgId: 'org-1',
    conversationId: 'conv-1',
    userMessage: 'What are your hours?',
    inboundEventId: 'MSG1',
    autoReply,
  }) as never;

beforeEach(() => {
  query.mockReset();
  deliver.mockReset().mockResolvedValue(undefined);
  chat.mockReset();
});

describe('auto-reply settings', () => {
  it('unset or broken settings mean the full agent (today’s behaviour)', () => {
    expect(parseAutoReply(undefined).mode).toBe('agent');
    expect(parseAutoReply({ mode: 'weird' }).mode).toBe('agent');
    expect(parseAutoReply({ mode: 'off' }).mode).toBe('off');
  });
  it('validates input strictly', () => {
    expect(validateAutoReply({ mode: 'nope' })).toMatchObject({ ok: false });
    expect(validateAutoReply({ mode: 'fixed', message: '  ' })).toMatchObject({ ok: false });
    expect(validateAutoReply({ mode: 'fixed', message: 'hi', cooldownMinutes: 0 })).toMatchObject({ ok: false });
    expect(validateAutoReply({ mode: 'ai_simple', instructions: 'x'.repeat(4001) })).toMatchObject({ ok: false });
    expect(validateAutoReply({ mode: 'fixed', message: ' hi ', cooldownMinutes: 60 })).toEqual({
      ok: true,
      value: {
        mode: 'fixed',
        instructions: '',
        message: 'hi',
        cooldownMinutes: 60,
        fallbackTemplate: null,
        audience: 'everyone',
        numbers: [],
        replyTo: 'every_message',
        employeeId: null,
        hours: { mode: 'always', timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' },
        readMedia: true,
        humanPauseHours: 2,
        holdingReply: { enabled: false, message: 'Thanks for your message. A teammate is checking and will reply shortly.' },
      },
    });
    expect(validateAutoReply({ mode: 'agent' })).toMatchObject({ ok: true });
    expect(validateAutoReply({ mode: 'agent', fallbackTemplate: { name: 'Bad Name', language: 'en' } })).toMatchObject({ ok: false });
    expect(validateAutoReply({ mode: 'agent', fallbackTemplate: { name: 'we_reply', language: 'en_US' } })).toMatchObject({
      ok: true,
      value: { fallbackTemplate: { name: 'we_reply', language: 'en_US' } },
    });
    expect(validateAutoReply({ mode: 'agent', fallbackTemplate: { name: '', language: '' } })).toMatchObject({ ok: true, value: { fallbackTemplate: null } });
  });
});

describe('runWhatsAppAutoReply', () => {
  const fixed = { mode: 'fixed', instructions: '', message: 'We will reply soon.', cooldownMinutes: 720, fallbackTemplate: null, audience: 'everyone', numbers: [], replyTo: 'every_message', employeeId: null, hours: { mode: 'always', timezone: 'UTC', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }, readMedia: true, humanPauseHours: 2 };
  const simple = { mode: 'ai_simple', instructions: 'Open 9-6 Mon-Sat.', message: '', cooldownMinutes: 720 };

  it('fixed: sends the canned message with no model call', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await runWhatsAppAutoReply(job(fixed));
    expect(chat).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1]).toBe('We will reply soon.');
    expect(deliver.mock.calls[0][2]).toMatchObject({ savedByWorkflow: false, sendKey: 'autoreply:MSG1' });
  });

  it('fixed: stays quiet inside the cooldown (bot or human already replied)', async () => {
    query.mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 });
    await runWhatsAppAutoReply(job(fixed));
    expect(deliver).not.toHaveBeenCalled();
  });

  it('ai_simple: answers from the business info and recent history, no agent', async () => {
    query.mockResolvedValue({
      rows: [
        { role: 'user', content: 'What are your hours?' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Are you open Sunday?' },
      ].reverse(),
    });
    chat.mockResolvedValue('  We are closed on Sunday.  ');
    await runWhatsAppAutoReply(job(simple));
    const [messages, opts] = chat.mock.calls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Open 9-6 Mon-Sat.');
    expect(messages[messages.length - 1]).toEqual({ role: 'user', content: 'Are you open Sunday?' });
    expect(opts).toMatchObject({ orgId: 'org-1' });
    expect(deliver.mock.calls[0][1]).toBe('We are closed on Sunday.');
  });

  it('ai_simple: a model failure or empty answer sends nothing', async () => {
    query.mockResolvedValue({ rows: [{ role: 'user', content: 'hi' }] });
    chat.mockRejectedValueOnce(new Error('LiteLLM HTTP 500'));
    await runWhatsAppAutoReply(job(simple));
    chat.mockResolvedValueOnce('   ');
    await runWhatsAppAutoReply(job(simple));
    expect(deliver).not.toHaveBeenCalled();
  });

  it('prompt tells the model not to guess', () => {
    expect(simpleSystemPrompt('')).toMatch(/teammate will follow up/);
    expect(simpleSystemPrompt('')).toContain('(none provided)');
  });
});

describe('who gets a reply', () => {
  const cfg = (over: Record<string, unknown>) => parseAutoReply({ mode: 'agent', ...over });

  it('normalizes numbers and rejects junk', () => {
    expect(normalizeNumbers('+91 98123-45678, 919812345678\n(415) 555-2671')).toEqual(['919812345678', '4155552671']);
    expect(normalizeNumbers(['14155552671'])).toEqual(['14155552671']);
    expect(normalizeNumbers('12345')).toBeNull();
    expect(normalizeNumbers('abc')).toBeNull();
    expect(normalizeNumbers('')).toEqual([]);
  });

  it('everyone: replies unless off', () => {
    expect(shouldAutoReply(cfg({}), '919812345678', true)).toEqual({ reply: true });
    expect(shouldAutoReply(cfg({ mode: 'off' }), '919812345678', true)).toMatchObject({ reply: false });
  });

  it('allow list: only listed numbers, country code optional in the list', () => {
    const c = cfg({ audience: 'allow_list', numbers: ['919812345678', '9700000002'] });
    expect(shouldAutoReply(c, '919812345678', true)).toEqual({ reply: true });
    expect(shouldAutoReply(c, '919700000002', true)).toEqual({ reply: true });
    expect(shouldAutoReply(c, '919999999999', true)).toMatchObject({ reply: false, reason: 'number is not on the allow list' });
    expect(shouldAutoReply(c, '55@lid', true)).toMatchObject({ reply: false });
  });

  it('block list: everyone except listed numbers; unknown ids are not blocked', () => {
    const c = cfg({ audience: 'block_list', numbers: ['919812345678'] });
    expect(shouldAutoReply(c, '919812345678', true)).toMatchObject({ reply: false, reason: 'number is blocked' });
    expect(shouldAutoReply(c, '919700000002', true)).toEqual({ reply: true });
    expect(shouldAutoReply(c, '55@lid', true)).toEqual({ reply: true });
  });

  it('new conversations only: later messages get no automatic reply', () => {
    const c = cfg({ replyTo: 'new_conversations' });
    expect(shouldAutoReply(c, '919812345678', true)).toEqual({ reply: true });
    expect(shouldAutoReply(c, '919812345678', false)).toMatchObject({ reply: false });
  });

  it('validates the new settings', () => {
    expect(validateAutoReply({ mode: 'agent', audience: 'allow_list', numbers: '' })).toMatchObject({ ok: false });
    expect(validateAutoReply({ mode: 'agent', audience: 'allow_list', numbers: 'not a number' })).toMatchObject({ ok: false });
    expect(validateAutoReply({ mode: 'agent', audience: 'nobody' })).toMatchObject({ ok: false });
    expect(validateAutoReply({ mode: 'agent', replyTo: 'never' })).toMatchObject({ ok: false });
    expect(validateAutoReply({ mode: 'agent', audience: 'block_list', numbers: ['+91 98123 45678'], replyTo: 'new_conversations' })).toMatchObject({
      ok: true,
      value: { audience: 'block_list', numbers: ['919812345678'], replyTo: 'new_conversations' },
    });
  });

  it('owner instructions guide the AI employee in agent mode only', () => {
    expect(personaWithInstructions('Sarah, sales.', cfg({ instructions: 'Never promise discounts.' }))).toContain('Never promise discounts.');
    expect(personaWithInstructions('Sarah, sales.', cfg({ mode: 'ai_simple', instructions: 'x' }))).toBe('Sarah, sales.');
    expect(personaWithInstructions('Sarah, sales.', cfg({}))).toBe('Sarah, sales.');
  });

  it('employee choice: id, automatic, or rejected', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(validateAutoReply({ mode: 'agent', employeeId: id })).toMatchObject({ ok: true, value: { employeeId: id } });
    expect(validateAutoReply({ mode: 'agent', employeeId: '' })).toMatchObject({ ok: true, value: { employeeId: null } });
    expect(validateAutoReply({ mode: 'agent', employeeId: 'auto' })).toMatchObject({ ok: true, value: { employeeId: null } });
    expect(validateAutoReply({ mode: 'agent', employeeId: 'not-a-uuid' })).toMatchObject({ ok: false });
    expect(parseAutoReply({ mode: 'agent', employeeId: 'junk' }).employeeId).toBeNull();
  });

  describe('business hours', () => {
    const kolkata = { mode: 'outside_hours', timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '18:00' };
    // 2026-09-30 is a Wednesday. 04:30Z = 10:00 IST (open); 13:00Z = 18:30 IST (closed); 2026-09-27 is a Sunday.
    const open = new Date('2026-09-30T04:30:00Z');
    const closedEvening = new Date('2026-09-30T13:00:00Z');
    const sunday = new Date('2026-09-27T05:00:00Z');

    it('knows open and closed in the business timezone', () => {
      const h = { ...kolkata, mode: 'always' } as never;
      expect(isWithinBusinessHours(h, open)).toBe(true);
      expect(isWithinBusinessHours(h, closedEvening)).toBe(false);
      expect(isWithinBusinessHours(h, sunday)).toBe(false);
      expect(isWithinBusinessHours(h, new Date('2026-09-30T12:29:00Z'))).toBe(true); // 17:59 IST
      expect(isWithinBusinessHours(h, new Date('2026-09-30T12:30:00Z'))).toBe(false); // 18:00 IST closes
    });

    it('away message: replies only when closed', () => {
      const c = parseAutoReply({ mode: 'fixed', message: 'x', hours: kolkata });
      expect(shouldAutoReply(c, '919812345678', true, open)).toMatchObject({ reply: false, reason: 'business hours: team is open' });
      expect(shouldAutoReply(c, '919812345678', true, closedEvening)).toEqual({ reply: true });
      expect(shouldAutoReply(c, '919812345678', true, sunday)).toEqual({ reply: true });
    });

    it('open-hours only: replies only when open', () => {
      const c = parseAutoReply({ mode: 'agent', hours: { ...kolkata, mode: 'inside_hours' } });
      expect(shouldAutoReply(c, '919812345678', true, open)).toEqual({ reply: true });
      expect(shouldAutoReply(c, '919812345678', true, closedEvening)).toMatchObject({ reply: false });
    });

    it('validates hours, pause and media settings', () => {
      expect(validateAutoReply({ mode: 'agent', hours: { mode: 'outside_hours', timezone: 'Mars/Base', days: [1], start: '09:00', end: '18:00' } })).toMatchObject({ ok: false });
      expect(validateAutoReply({ mode: 'agent', hours: { ...kolkata, days: [] } })).toMatchObject({ ok: false });
      expect(validateAutoReply({ mode: 'agent', hours: { ...kolkata, start: '18:00', end: '09:00' } })).toMatchObject({ ok: false });
      expect(validateAutoReply({ mode: 'agent', hours: { ...kolkata, start: '9am' } })).toMatchObject({ ok: false });
      expect(validateAutoReply({ mode: 'agent', humanPauseHours: 3 })).toMatchObject({ ok: false });
      expect(validateAutoReply({ mode: 'agent', readMedia: 'yes' })).toMatchObject({ ok: false });
      expect(validateAutoReply({ mode: 'agent', hours: kolkata, humanPauseHours: 0, readMedia: false })).toMatchObject({
        ok: true,
        value: { hours: kolkata, humanPauseHours: 0, readMedia: false },
      });
      expect(parseAutoReply({ mode: 'agent' })).toMatchObject({ humanPauseHours: 2, readMedia: true, hours: { mode: 'always' } });
    });
  });

  it('waiting message for unsure AI answers: off by default, editable, bounded', () => {
    expect(parseAutoReply({ mode: 'agent' }).holdingReply.enabled).toBe(false);
    const ok = validateAutoReply({ mode: 'agent', holdingReply: { enabled: true, message: ' One moment please. ' } });
    expect(ok).toMatchObject({ ok: true, value: { holdingReply: { enabled: true, message: 'One moment please.' } } });
    expect(validateAutoReply({ mode: 'agent', holdingReply: { enabled: true, message: '' } })).toMatchObject({
      ok: true,
      value: { holdingReply: { enabled: true, message: expect.stringContaining('teammate') } },
    });
    expect(validateAutoReply({ mode: 'agent', holdingReply: { enabled: 'yes' } })).toMatchObject({ ok: false });
    expect(validateAutoReply({ mode: 'agent', holdingReply: { enabled: true, message: 'x'.repeat(301) } })).toMatchObject({ ok: false });
  });
});
