import { assertProductionBoot } from '@/lib/boot-guards';

/**
 * Next.js instrumentation — runs once when the Node server starts.
 * Edge runtime must not load Node-only boot checks.
 */
export function register(): void {
  if (process.env.NEXT_RUNTIME === 'edge') return;
  assertProductionBoot();
}
