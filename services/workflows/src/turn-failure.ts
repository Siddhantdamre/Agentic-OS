/**
 * What the customer sees when an AI employee's turn fails.
 *
 * The raw reason (a refused connection, a provider's response body, a SQL error) belongs in the logs and in the
 * result's `error` field, which drives retries. The chat gets one plain sentence and a neutral step label.
 */
const TIMED_OUT = /abort|timeout|timed out/i;

export function describeTurnFailure(details: string | undefined): {
  replyMessage: string;
  stepAction: string;
  stepResult: string;
} {
  const timedOut = TIMED_OUT.test(String(details ?? ''));
  return {
    replyMessage: timedOut
      ? 'That took longer than expected, so I stopped. Please try again — a shorter or more specific question can help.'
      : 'I couldn’t finish that just now. Please try again in a moment.',
    stepAction: 'Working on your request',
    stepResult: timedOut ? 'Took longer than expected.' : 'Could not be completed.',
  };
}
