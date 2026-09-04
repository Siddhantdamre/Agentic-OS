import { NextResponse } from 'next/server';
import { getScopedClient } from '@/lib/db';
import { decisionBriefActivity } from '@darex/workflows/dist/activities/decision-brief';

/**
 * A brief on one business question, from this workspace's records AND the market.
 *
 * The org comes from the session via `getScopedClient` — never from the request
 * body. A brief reads a tenant's own documents and conversations, so an org id
 * a caller could set is an org id a caller could change.
 *
 * Runs inline rather than through Temporal on purpose: this is a person waiting
 * at a screen for an answer, and there is nothing to lose if the tab closes —
 * the brief writes nothing and sends nothing. The durable path exists for work
 * that must survive a restart, which is sends, payments and signatures.
 */
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const { client, orgId } = await getScopedClient();
    try {
      const body = (await request.json().catch(() => ({}))) as {
        question?: string;
        internalOnly?: boolean;
        maxRounds?: number;
      };

      const question = String(body.question || '').trim();
      if (!question) {
        return NextResponse.json({ error: 'A question is required.' }, { status: 400 });
      }
      if (question.length > 500) {
        return NextResponse.json(
          { error: 'Keep the question under 500 characters.' },
          { status: 400 }
        );
      }

      const started = Date.now();
      const result = await decisionBriefActivity({
        orgId,
        question,
        internalOnly: body.internalOnly === true,
        // Two rounds is a brief. The deep-research activity is the tool for a
        // long look, and it is reachable on its own.
        maxRounds: Math.min(Math.max(1, body.maxRounds ?? 2), 3),
        maxSources: 8,
      });

      return NextResponse.json({
        question,
        verdict: result.brief.verdict,
        findings: result.brief.findings,
        openQuestions: result.brief.openQuestions,
        rejected: result.brief.rejected,
        evidence: {
          internalSources: result.brief.internalSourceCount,
          externalPublishers: result.brief.externalDomainCount,
        },
        gathered: result.gathered,
        rendered: result.rendered,
        elapsedMs: Date.now() - started,
      });
    } finally {
      client.release();
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    // Never leak a stack to the browser; the brief is a read-only operation and
    // a failure here means "no answer", not a broken workspace.
    return NextResponse.json(
      { error: 'The brief could not be produced.', detail: message.slice(0, 200) },
      { status: 500 }
    );
  }
}
