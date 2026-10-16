/**
 * Provider circuit breaker for in-process model failover.
 * After FAILURE_THRESHOLD consecutive failures, skip the provider for RESET_MS.
 */

interface BreakerState {
  failures: number;
  openedAt: number;
  isOpen: boolean;
}

const breakers = new Map<string, BreakerState>();
const FAILURE_THRESHOLD = 3;
const RESET_MS = 60_000;

export function isProviderAvailable(providerName: string): boolean {
  const state = breakers.get(providerName);
  if (!state || !state.isOpen) return true;
  if (Date.now() - state.openedAt > RESET_MS) {
    state.isOpen = false;
    state.failures = 0;
    breakers.set(providerName, state);
    return true;
  }
  return false;
}

export function recordProviderFailure(providerName: string): void {
  const state = breakers.get(providerName) || { failures: 0, openedAt: 0, isOpen: false };
  state.failures += 1;
  if (state.failures >= FAILURE_THRESHOLD) {
    state.isOpen = true;
    state.openedAt = Date.now();
    console.warn(`[circuit-breaker] Provider ${providerName} opened for ${RESET_MS}ms`);
  }
  breakers.set(providerName, state);
}

export function recordProviderSuccess(providerName: string): void {
  breakers.delete(providerName);
}

/** Test-only reset. */
export function _resetCircuitBreakersForTests(): void {
  breakers.clear();
}
