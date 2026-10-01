  // THE MODEL COMES FROM THE WORKSPACE'S BUDGET, not from LITELLM_MODEL.
  //
  // The dashboard had its own route to the proxy — classification, crew
  // planning, plan generation and draft revision all arrived here — and every
  // one of them read the paid alias out of the environment. A workspace that
  // the budget gate had already degraded to the free tier went on paying full
  // price for all four, because the gate and this file had never met.
  //
  // checkLlmBudgetActivity fails OPEN by design: if the meter cannot be read
  // the turn proceeds on the normal tier, because a cost control that causes
  // an outage is a worse problem than the cost it was controlling.
  let model = process.env.LITELLM_MODEL || 'atomic-agent';
  try {
    const gate = await checkLlmBudgetActivity({ orgId: options.orgId });
    if (!gate.allowed) {
      // on_exceeded='stop'. Opt-in, rare, and the caller's fallback handles it.
      return '';
    }
    if (gate.modelOverride) model = gate.modelOverride;
  } catch {
    // Fail open, as above. The gate logs its own reason loudly.
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          // GPT-6 Astra supports reasoning in Chat Completions for non-tool
          // calls. OpenAI rejects temperature/top_p when reasoning is enabled,
          // and uses max_completion_tokens for the total generated budget.
          ...(model === 'darex-astra'
            ? {
                max_completion_tokens: options.maxTokens,
                reasoning_effort: process.env.DAREX_ASTRA_REASONING_EFFORT || 'high',
              }
            : {
                max_tokens: options.maxTokens,
                temperature: options.temperature ?? 0,
              }),
          // LiteLLM records the request-body `user` as `end_user` in its spend
          // log. Without it the call is billed to the proxy's own key and no
          // workspace can be charged, capped, or shown what it spent.
          user: options.orgId,
          messages,
        }),
        signal: controller.signal,
      });

      if (res.ok) {
        const data = await res.json();
        return data?.choices?.[0]?.message?.content || '';
      }

      // Non-2xx: retry only on transient server/rate errors.
      const body = await res.text().catch(() => '');
      if (!RETRYABLE_STATUSES.has(res.status) || attempt >= maxRetries) {
        throw new Error(`LiteLLM HTTP ${res.status}: ${body.slice(0, 300)}`);
      }
      lastError = new Error(`LiteLLM HTTP ${res.status}: ${body.slice(0, 300)}`);
    } catch (err: any) {
      controller.abort();
      // AbortError means the overall timeout elapsed — retrying is pointless.
      if (err?.name === 'AbortError') throw new Error(`LiteLLM request timed out after ${timeoutMs}ms`);
      lastError = err;
      if (attempt >= maxRetries) break;
    } finally {
      clearTimeout(timeout);
    }

    // Exponential backoff + jitter before the next attempt.
    await sleep(250 * Math.pow(2, attempt) + Math.floor(Math.random() * 250));
  }

  throw lastError ?? new Error('LiteLLM request failed');
}