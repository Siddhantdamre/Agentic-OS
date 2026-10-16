/**
 * Await a Temporal workflow handle while propagating client disconnect as cancel.
 */
export async function awaitCrewHandleWithAbort<T>(
  handle: {
    workflowId: string;
    result: () => Promise<T>;
    cancel: () => Promise<unknown>;
  },
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    await handle.cancel().catch(() => undefined);
    const err = new Error('Client aborted');
    err.name = 'AbortError';
    throw err;
  }

  const onAbort = () => {
    console.warn(`[crew] Client disconnected — cancelling Temporal workflow ${handle.workflowId}`);
    void handle.cancel().catch((cancelErr: unknown) => {
      console.error(`[crew] Failed to cancel workflow ${handle.workflowId}:`, cancelErr);
    });
  };

  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await handle.result();
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
