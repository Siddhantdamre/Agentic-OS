import { planStepLabel } from '../plan-step-label';

describe('planStepLabel', () => {
  it('names the app and what is done, not an internal tool id', () => {
    expect(planStepLabel('google-sheets', 'sheets_read')).toBe('Google Sheets · Read');
    expect(planStepLabel('gmail', 'gmail_send')).toBe('Gmail · Send');
    expect(planStepLabel('google-calendar', 'calendar_create_event')).toBe('Google Calendar · Create event');
  });

  it('understands a full tool id as well as a separate tool and action', () => {
    expect(planStepLabel('mcp.google-sheets.sheets_read', '')).toBe('Google Sheets · Read');
    expect(planStepLabel('mcp.hubspot.create_contact', 'create_contact')).toBe('HubSpot · Create contact');
  });

  it('never prints mcp. or an underscore', () => {
    for (const [t, a] of [['mcp.some-new-app.do_the_thing', ''], ['some_app', 'run_report'], ['x', '']] as const) {
      expect(planStepLabel(t, a)).not.toMatch(/mcp\.|_/);
    }
  });

  it('falls back to the app alone when there is no action', () => {
    expect(planStepLabel('slack', '')).toBe('Slack');
  });
});
