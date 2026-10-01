import { NextResponse } from 'next/server';
import {
  assertSlackTeamMatchesOrg,
  fireSlackDecisionSignal,
  parseSlackInteraction,
  persistSlackDecision,
  verifySlackSignature,
} from '@/lib/slack-interact';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const rawBody = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp') || '';
  const signature = request.headers.get('x-slack-signature') || '';
  const signingSecret = process.env.SLACK_SIGNING_SECRET || '';

  if (!verifySlackSignature({ signingSecret, timestamp, rawBody, signature })) {
    return new NextResponse('invalid signature', { status: 401 });
  }

  const parsed = parseSlackInteraction(rawBody);
  if (!parsed) {
    return NextResponse.json({ ok: true, ignored: true });
  }

  try {
    const binding = await assertSlackTeamMatchesOrg(parsed);
    if (!binding.ok) {
      console.warn('[slack.interactions] rejected:', binding.reason);
      return NextResponse.json({ ok: false, error: 'workspace_not_bound' }, { status: 403 });
    }
    const persisted = await persistSlackDecision(parsed);
    setImmediate(() => {
      void fireSlackDecisionSignal(persisted.workflowId, persisted.decision).catch((err) => {
        console.warn('[slack.interactions] signal failed:', err instanceof Error ? err.message : err);
      });
    });
    return NextResponse.json({ ok: true, workItemId: persisted.workItemId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[slack.interactions]', message);
    return NextResponse.json({ ok: true, error: 'persist_failed' });
  }
}
