import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const stateDir = process.env.ATOMIC_AGENT_STATE_DIR || '/data';
const activeProvider =
  process.env.ATOMIC_AGENT_ACTIVE_PROVIDER || 'darex-openrouter';

const providers = [];

if (process.env.OPENROUTER_API_KEY) {
  providers.push({
    id: 'darex-openrouter',
    kind: 'openrouter',
    apiKey: process.env.OPENROUTER_API_KEY,
    defaultChatModel: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat',
    supportsTools: true,
    supportsVision: true,
  });
}

if (process.env.GROQ_API_KEY) {
  providers.push({
    id: 'darex-groq',
    kind: 'openai-compatible',
    baseUrl:
      process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    apiKey: process.env.GROQ_API_KEY,
    defaultChatModel:
      process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile',
    supportsTools: true,
    supportsVision: false,
  });
}

if (process.env.GEMINI_API_KEY) {
  providers.push({
    id: 'darex-gemini',
    kind: 'openai-compatible',
    baseUrl:
      process.env.GEMINI_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: process.env.GEMINI_API_KEY,
    defaultChatModel: process.env.GEMINI_CHAT_MODEL || 'gemini-2.0-flash',
    supportsTools: true,
    supportsVision: true,
  });
}

// LiteLLM proxy route — owns the model fallback chain (infra/litellm/config.yaml).
// The agent always asks for model "atomic-agent"; LiteLLM picks the first
// healthy model in the chain (nemotron free -> deepseek-v4-flash-latest).
if (process.env.LITELLM_BASE_URL) {
  providers.push({
    id: 'darex-litellm',
    kind: 'openai-compatible',
    baseUrl: process.env.LITELLM_BASE_URL,
    apiKey: process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY || 'sk-darex-litellm-dev-key',
    defaultChatModel: process.env.LITELLM_MODEL || 'atomic-agent',
    supportsTools: true,
    supportsVision: true,
  });
}

const active =
  providers.find((p) => p.id === activeProvider) || providers[0];

if (!active) {
  throw new Error(
    'No LLM provider configured — set OPENROUTER_API_KEY, GROQ_API_KEY, or GEMINI_API_KEY',
  );
}

const config = {
  version: 35,
  log: { level: 'info' },
  agent: {
    tokenBudget: 32768,
    maxSteps: 30,
    toolTimeoutMs: 60000,
    approvalRequired: false,
    conversationMaxTokens: 20000,
    worldSnapshotMaxTokens: 12000,
  },
  http: {
    enabled: true,
    approvalMode: 'writes',
    hostAllowlist: null,
    maxResponseBytes: 1048576,
    defaultTimeoutMs: 30000,
  },
  web: {
    search: {
      enabled: true,
      provider: 'exa',
      maxResults: 8,
      timeoutMs: 15000,
      cacheTtlMinutes: 15,
      fallback: ['duckduckgo'],
      searxng: { instanceUrl: null },
      exa: {
        endpoint: 'https://mcp.exa.ai/mcp',
        apiEndpoint: 'https://api.exa.ai/search',
        apiKeyEnv: 'EXA_API_KEY',
      },
      brave: { apiKeyEnv: 'BRAVE_SEARCH_API_KEY' },
    },
  },
  tracing: { trace: { enabled: true, maxBytesPerSession: 262144 } },
  memory: {
    profile: {
      enabled: true,
      maxTokens: 600,
      contextualKeywordGate: true,
    },
    reflection: {
      enabled: true,
      timeoutMs: 15000,
      maxFactsPerCall: 4,
      autoStoreNotes: true,
      maxNotesPerCall: 3,
      typedNotes: { enabled: true },
      segmentation: {
        enabled: true,
        triggerEveryTurns: 2,
        windowTurns: 4,
      },
      anySpeaker: false,
    },
    notes: {
      enabled: true,
      maxEntries: 2000,
      maxContentChars: 8000,
      recallDefaultK: 6,
    },
    recallInjection: {
      enabled: true,
      k: 5,
      previewChars: 240,
      maxTokens: 900,
    },
    index: { enabled: true, limit: 30, previewChars: 80, maxTokens: 600 },
    dedup: { enabled: true, fts5Threshold: 0.82 },
    eviction: { utilityWeighted: true, maxAgeMs: 15552000000 },
    embeddings: {
      enabled: false,
      fts5Weight: 0.6,
      vectorWeight: 0.4,
      bruteForceCeiling: 500,
    },
    links: {
      enabled: true,
      autoGenerate: true,
      expansionDepth: 2,
      maxExpanded: 6,
      maxLinksPerCall: 3,
      minCandidates: 2,
      generatorTimeoutMs: 12000,
    },
    evolution: { enabled: false, maxPerWrite: 2, leaseMs: 60000 },
    lessons: {
      enabled: false,
      recallK: 2,
      maxTokens: 300,
      indexLimit: 20,
      maxEntries: 500,
      deprecationAgeMs: 2592000000,
    },
    procedures: {
      enabled: false,
      recallK: 2,
      maxTokens: 400,
      indexLimit: 20,
      maxEntries: 500,
      deprecationAgeMs: 2592000000,
    },
    consolidation: {
      enabled: false,
      intervalMs: 21600000,
      cooldownMs: 86400000,
      minClusterSize: 3,
      maxClustersPerTick: 5,
      requireSharedTag: true,
      distillTimeoutMs: 45000,
    },
    voting: {
      enabled: false,
      maxVotePerItem: 50,
      signalDecay: 0.95,
      scoreBlend: 0.6,
      eventLogMaxRows: 50000,
      profileFilterThreshold: 3,
    },
    retrieve: {
      rewriter: {
        enabled: false,
        timeoutMs: 3000,
        historyTurns: 3,
        gateMode: 'heuristic',
        embeddingGate: { threshold: 0.65, exemplars: null },
      },
    },
  },
  webhooks: {},
  vision: {
    enabled: false,
    autoDetect: true,
    maxImageBytes: 15728640,
    maxImagesPerCall: 3,
  },
  skills: {
    disabled: [],
    taps: [],
    clawhub: {
      enabled: true,
      apiBase: 'https://clawhub.ai',
      browseLimit: 20,
      nonSuspiciousOnly: true,
    },
  },
  tui: { theme: 'auto' },
  analytics: { enabled: false },
  telegram: {
    enabled: false,
    ownerUserId: null,
    parseMode: 'html',
    progressIndicator: true,
  },
  mcp: {
    servers: [
      {
        name: 'darex',
        description: 'DareX business connectors (WhatsApp, Gmail, Calendar, HubSpot, Meta/Google Ads, Slack, Notion, Stripe, Shopify, Zendesk, Intercom, Razorpay, web, DB)',
        enabled: true,
        transport: {
          kind: 'sse',
          url: process.env.ATOMIC_AGENT_MCP_URL || 'http://atomic-bridge:8790/sse',
        },
        trust: 'approval_gated',
      },
    ],
  },
  llm: {
    activeTextProvider: active.id,
    activeEmbeddingProvider: active.id,
    toolTransport: 'auto',
    providers,
  },
};

mkdirSync(stateDir, { recursive: true });
const target = join(stateDir, 'config.json');
writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
console.log(
  `[atomic-agent] wrote ${target} (active provider: ${active.id}, providers: ${providers.map((p) => p.id).join(', ')})`,
);
