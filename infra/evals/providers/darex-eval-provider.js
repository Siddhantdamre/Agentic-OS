'use strict';

/**
 * Promptfoo custom provider for Darex goldens.
 * Offline / DB / fixture only — never calls Ask AI or /api/agent.
 */

const { resolveScenarioOutput } = require('../lib/scenarios');

class DarexEvalProvider {
  id() {
    return 'darex-eval';
  }

  async callApi(prompt, context) {
    const vars = { prompt, ...((context && context.vars) || {}) };
    const resolved = await resolveScenarioOutput(vars);
    if (resolved.error) {
      return { error: resolved.error };
    }
    if (resolved.skip) {
      return {
        output: `SKIP: ${resolved.reason}`,
        tokenUsage: { total: 0, prompt: 0, completion: 0 },
        metadata: { skip: true, reason: resolved.reason, xfail: Boolean(resolved.xfail) },
      };
    }
    return {
      output: resolved.output,
      tokenUsage: { total: 0, prompt: 0, completion: 0 },
    };
  }
}

module.exports = DarexEvalProvider;
