/**
 * @jest-environment node
 *
 * Slack interactions: the button's orgId is only honoured when the clicking
 * workspace (team.id) is the one bound to that org's Slack connection (CH-S02).
 */
jest.mock('@/lib/db', () => ({ getOrgScopedClient: jest.fn() }));
jest.mock('@/lib/nango-server', () => ({ getNangoConnection: jest.fn() }));
jest.mock('@darex/workflows/dist/workflow-client', () => ({ signalWorkItemDecision: jest.fn() }));

import {
  assertSlackTeamMatchesOrg,
  parseSlackInteraction,
  slackTeamIdFromConnection,
} from '@/lib/slack-interact';

function interaction(teamId: string | null, orgId = 'org-a'): string {
  const payload: Record<string, unknown> = {
    type: 'block_actions',
    actions: [
      {
        action_id: 'work_item_approve',
        value: JSON.stringify({ workItemId: 'wi-1', decision: 'approve', orgId }),
      },
    ],
  };
  if (teamId) payload.team = { id: teamId };
  return new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
}

describe('slack interaction team binding', () => {
  it('parses team id from the payload', () => {
    const parsed = parseSlackInteraction(interaction('T111'));
    expect(parsed).toMatchObject({ workItemId: 'wi-1', decision: 'approve', orgId: 'org-a', teamId: 'T111' });
  });

  it('reads the team id from Nango raw credentials or connection_config', () => {
    expect(slackTeamIdFromConnection({ credentials: { raw: { team: { id: 'T1' } } } })).toBe('T1');
    expect(slackTeamIdFromConnection({ connection_config: { 'team.id': 'T2' } })).toBe('T2');
    expect(slackTeamIdFromConnection({})).toBeNull();
    expect(slackTeamIdFromConnection(null)).toBeNull();
  });

  it('accepts a click from the org-bound workspace', async () => {
    const parsed = parseSlackInteraction(interaction('T111'))!;
    const res = await assertSlackTeamMatchesOrg(parsed, async () => ({
      credentials: { raw: { team: { id: 'T111' } } },
    }));
    expect(res).toEqual({ ok: true });
  });

  it('rejects a click from another workspace claiming the org', async () => {
    const parsed = parseSlackInteraction(interaction('T999'))!;
    const res = await assertSlackTeamMatchesOrg(parsed, async () => ({
      credentials: { raw: { team: { id: 'T111' } } },
    }));
    expect(res).toEqual({ ok: false, reason: 'team_mismatch' });
  });

  it('fails closed when team or binding is missing', async () => {
    const noTeam = parseSlackInteraction(interaction(null))!;
    expect(await assertSlackTeamMatchesOrg(noTeam, async () => ({}))).toEqual({
      ok: false,
      reason: 'missing_team',
    });
    const parsed = parseSlackInteraction(interaction('T111'))!;
    expect(await assertSlackTeamMatchesOrg(parsed, async () => null)).toEqual({
      ok: false,
      reason: 'org_has_no_slack_workspace',
    });
  });
});
