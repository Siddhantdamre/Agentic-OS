/**
 * Lightweight Node runtime telemetry — no APM vendor.
 * Uses process.memoryUsage + a one-shot event-loop delay sample.
 */

export type RuntimeTelemetry = {
  uptimeSeconds: number;
  memory: {
    rssMb: number;
    heapUsedMb: number;
    heapTotalMb: number;
    externalMb: number;
  };
  eventLoopDelayMs: number;
};

function mb(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/** Single-sample event-loop delay via setImmediate (no native histogram dep). */
export function sampleEventLoopDelayMs(): Promise<number> {
  return new Promise((resolve) => {
    const start = performance.now();
    setImmediate(() => {
      resolve(Math.round((performance.now() - start) * 100) / 100);
    });
  });
}

export async function collectRuntimeTelemetry(): Promise<RuntimeTelemetry> {
  const mem = process.memoryUsage();
  const eventLoopDelayMs = await sampleEventLoopDelayMs();
  return {
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      rssMb: mb(mem.rss),
      heapUsedMb: mb(mem.heapUsed),
      heapTotalMb: mb(mem.heapTotal),
      externalMb: mb(mem.external),
    },
    eventLoopDelayMs,
  };
}
