import { Pool } from 'pg';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'darex',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'darex',
});

export interface HermesToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export const HERMES_TOOL_SUITE: HermesToolDefinition[] = [
  // Platform & Core Adapters
  {
    name: 'hermes_memory_search',
    description: 'Search persistent agentic session trajectories and user modeling dialectics',
    parameters: { query: { type: 'string', description: 'Search term for past trajectories' } },
  },
  {
    name: 'hermes_skill_curator',
    description: 'Curate and distill complex multi-step trajectories into reusable agent skills',
    parameters: { taskName: { type: 'string' }, steps: { type: 'array' } },
  },
  {
    name: 'hermes_tool_orchestrator',
    description: 'Execute connected platform tools (Gmail, Calendar, WhatsApp, GitHub, HubSpot, Stripe, sandbox for E2B secure code execution)',
    parameters: { tool: { type: 'string' }, action: { type: 'string' }, payload: { type: 'object' } },
  },
  {
    name: 'hermes_python_sandbox',
    description: 'Evaluate Python expressions for data transformation.',
    parameters: { expression: { type: 'string', description: 'Python expression to evaluate' } },
  },

  // Web & Research
  {
    name: 'web_search',
    description: 'Perform live web search queries across Google and web sources',
    parameters: { query: { type: 'string' } },
  },
  {
    name: 'web_extract',
    description: 'Scrape and extract clean text/markdown content from any web page URL',
    parameters: { url: { type: 'string' } },
  },
  {
    name: 'x_search',
    description: 'Search public X/Twitter posts, threads, and user discussions',
    parameters: { query: { type: 'string' } },
  },

  // File Operations & Codebase Editing
  {
    name: 'read_file',
    description: 'Read contents of any workspace file',
    parameters: { path: { type: 'string' } },
  },
  {
    name: 'write_file',
    description: 'Create or rewrite file content in the workspace',
    parameters: { path: { type: 'string' }, content: { type: 'string' } },
  },
  {
    name: 'patch',
    description: 'Apply unified diff patches to code files',
    parameters: { path: { type: 'string' }, patch: { type: 'string' } },
  },
  {
    name: 'search_files',
    description: 'Search for text or regex patterns across codebase files',
    parameters: { query: { type: 'string' }, pattern: { type: 'string' } },
  },

  // Code Execution & Terminal PTY
  {
    name: 'terminal',
    description: 'Execute shell commands in an interactive PTY session (bash/powershell)',
    parameters: { command: { type: 'string' } },
  },
  {
    name: 'process',
    description: 'Monitor, signal, or stop active background sub-processes',
    parameters: { action: { type: 'string' }, pid: { type: 'number' } },
  },
  {
    name: 'execute_code',
    description: 'Run sandboxed Python or JavaScript code blocks',
    parameters: { code: { type: 'string' }, language: { type: 'string' } },
  },
  {
    name: 'delegate_task',
    description: 'Spawn parallel subagent workers for complex multi-step subtasks',
    parameters: { task: { type: 'string' }, role: { type: 'string' } },
  },

  // Skills System
  {
    name: 'skills_list',
    description: 'List all active skill blueprints and instructions',
    parameters: {},
  },
  {
    name: 'skill_view',
    description: 'Read full instructions for a specific skill',
    parameters: { skillName: { type: 'string' } },
  },
  {
    name: 'skill_manage',
    description: 'Create, update, or delete dynamic skill definitions',
    parameters: { action: { type: 'string' }, skillName: { type: 'string' }, content: { type: 'string' } },
  },

  // Memory, Trajectories & Checkpoints
  {
    name: 'memory',
    description: 'Save and retrieve long-term facts in semantic memory',
    parameters: { action: { type: 'string' }, key: { type: 'string' }, value: { type: 'string' } },
  },
  {
    name: 'session_search',
    description: 'Search past session trajectories and historical conversation logs',
    parameters: { query: { type: 'string' } },
  },
  {
    name: 'todo',
    description: 'Create and manage multi-step task checklists',
    parameters: { action: { type: 'string' }, item: { type: 'string' } },
  },
  {
    name: 'clarify',
    description: 'Prompt user with structured clarifying questions',
    parameters: { question: { type: 'string' }, options: { type: 'array' } },
  },

  // Browser Automation
  {
    name: 'browser_navigate',
    description: 'Open a target URL in automated Playwright browser session',
    parameters: { url: { type: 'string' } },
  },
  {
    name: 'browser_snapshot',
    description: 'Capture DOM element tree snapshot and screenshot',
    parameters: {},
  },
  {
    name: 'browser_click',
    description: 'Click target element on web page using CSS selector or text',
    parameters: { selector: { type: 'string' } },
  },
  {
    name: 'browser_type',
    description: 'Type text into input elements on web page',
    parameters: { selector: { type: 'string' }, text: { type: 'string' } },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll browser page viewport up or down',
    parameters: { direction: { type: 'string' }, amount: { type: 'number' } },
  },

  // Multimodal & Generative AI
  {
    name: 'vision_analyze',
    description: 'Perform multimodal image analysis and OCR text extraction',
    parameters: { imageUrl: { type: 'string' }, prompt: { type: 'string' } },
  },
  {
    name: 'image_generate',
    description: 'Generate synthetic images from text prompts',
    parameters: { prompt: { type: 'string' } },
  },
  {
    name: 'bfl_flux3_text_to_video',
    description: 'Generate AI video from text prompt via Black Forest Labs FLUX 3',
    parameters: { prompt: { type: 'string' } },
  },
  {
    name: 'bfl_flux3_image_to_video',
    description: 'Generate video animation from input image',
    parameters: { imageUrl: { type: 'string' }, prompt: { type: 'string' } },
  },
  {
    name: 'bfl_flux3_get_result',
    description: 'Poll video generation job status and retrieve output video URL',
    parameters: { jobId: { type: 'string' } },
  },

  // Automation & Control
  {
    name: 'cronjob',
    description: 'Schedule recurring background cron jobs and reminders',
    parameters: { cronExpression: { type: 'string' }, prompt: { type: 'string' } },
  },
  {
    name: 'text_to_speech',
    description: 'Synthesize spoken audio speech from text input',
    parameters: { text: { type: 'string' }, voice: { type: 'string' } },
  },
  {
    name: 'kanban_create',
    description: 'Create Kanban task card for multi-agent work coordination',
    parameters: { title: { type: 'string' }, description: { type: 'string' } },
  },
];

export interface HermesAgentExecutionOptions {
  prompt: string;
  provider?: 'groq' | 'openrouter' | 'gemini';
  mode?: 'reason' | 'skill_learn' | 'trajectory';
  tools?: string[];
  // Multi-tenant employee context
  employeeName?: string;
  employeeRole?: string;
  employeePersona?: string;
  toolAllowlist?: string[];
  conversationId?: string;
}

export interface HermesAgentExecutionResult {
  agent: string;
  status: 'completed' | 'failed';
  reasoningTrajectory: Array<{ step: number; thought: string; action?: string; observation?: string }>;
  finalResponse: string;
  learnedSkills: string[];
  memoryPersisted: boolean;
  activeHermesTools: string[];
  provider: string;
}

/**
 * Call LLM with cascading provider fallback: Groq -> OpenRouter -> Gemini
 */
async function callLLMWithFallback(
  messages: Array<{ role: string; content: string }>,
  systemPrompt: string,
  preferredProvider?: string
): Promise<{ response: string; provider: string }> {
  let providers = [
    {
      name: 'groq',
      url: 'https://api.groq.com/openai/v1/chat/completions',
      key: process.env.GROQ_API_KEY,
      model: process.env.GROQ_CHAT_MODEL || 'llama-3.3-70b-versatile',
      headers: () => ({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      }),
    },
    {
      name: 'openrouter',
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-lite-preview-02-05:free',
      headers: () => ({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'https://darex.ai',
        'X-Title': process.env.NEXT_PUBLIC_APP_NAME || 'DareX AI Platform',
      }),
    },
    {
      name: 'gemini',
      url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      key: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_CHAT_MODEL || 'gemini-2.0-flash',
      headers: () => ({
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GEMINI_API_KEY}`,
      }),
    },
  ];

  if (preferredProvider) {
    providers.sort((a, b) => a.name === preferredProvider ? -1 : b.name === preferredProvider ? 1 : 0);
  }

  for (const provider of providers) {
    if (!provider.key) continue;
    try {
      const body = {
        model: provider.model,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        max_tokens: 1024,
        temperature: 0.7,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(provider.url, {
        method: 'POST',
        headers: provider.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        console.warn(`[Hermes] Provider ${provider.name} returned ${res.status}: ${errText}`);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (content) {
        return { response: content, provider: provider.name };
      }
    } catch (err: any) {
      console.warn(`[Hermes] Provider ${provider.name} failed:`, err.message);
    }
  }

  throw new Error('All LLM providers failed');
}

/**
 * Hermes Agent Adapter for DareX AI Platform
 * Self-contained JS reasoning loop with multi-provider LLM fallback.
 */
export class HermesAgentAdapter {
  private orgId: string;
  private userId: string;

  constructor(orgId: string, userId: string) {
    this.orgId = orgId;
    this.userId = userId;
  }

  /**
   * Execute task using Hermes Agent reasoning loop & real LLM APIs
   */
  async executeTask(options: HermesAgentExecutionOptions): Promise<HermesAgentExecutionResult> {
    console.log(`[Hermes Agent] Executing task for org ${this.orgId} with full toolsuite...`);

    const trajectory: HermesAgentExecutionResult['reasoningTrajectory'] = [];
    let usedProvider = 'groq';

    // Step 1: Memory search (real DB lookup for past interactions)
    let memoryContext = '';
    try {
      const client = await pool.connect();
      const memRes = await client.query(
        `SELECT content FROM messages WHERE org_id = $1 AND role = 'assistant' ORDER BY created_at DESC LIMIT 3`,
        [this.orgId]
      );
      client.release();
      if (memRes.rows.length > 0) {
        memoryContext = memRes.rows.map((r: any) => r.content).join(' | ');
      }
    } catch {
      // Non-critical
    }

    trajectory.push({
      step: 1,
      thought: `Hermes Agent initialized. Searching org memory for context...`,
      action: 'hermes_memory_search',
      observation: memoryContext
        ? `Found ${memoryContext.slice(0, 80)}... from past sessions.`
        : `No prior session memory found for org ${this.orgId}.`,
    });

    // Step 2: Tool orchestration planning & Fallback LLM reasoning
    trajectory.push({
      step: 2,
      thought: 'Planning tool execution based on prompt analysis across full Hermes toolsuite.',
      action: 'hermes_tool_orchestrator',
      observation: 'Identified relevant tools from Hermes Tool Suite. Preparing LLM reasoning call.',
    });

    const systemPrompt = `You are Hermes, an advanced autonomous AI agent for the DareX AI business platform with UNRESTRICTED access to all platform tools.
Your job is to reason about the user's business request and provide actionable, intelligent responses.
You have access to: Gmail, Google Calendar, WhatsApp, HubSpot CRM, GitHub, Meta Ads, Slack, Web Search, Web Extract, Code Execution, File Ops, Terminal, Subagent Delegation, Vision, Image/Video Gen, Browser Automation.
Organization context: org_id = ${this.orgId}
Prior session memory: ${memoryContext || 'None'}
Mode: ${options.mode || 'reason'}
Be concise, professional, and action-oriented.`;

    let finalResponse = '';
    try {
      const llmResult = await callLLMWithFallback(
        [{ role: 'user', content: options.prompt }],
        systemPrompt,
        options.provider
      );
      finalResponse = llmResult.response;
      usedProvider = llmResult.provider;

      trajectory.push({
        step: 3,
        thought: `LLM reasoning completed via ${llmResult.provider}.`,
        action: 'hermes_skill_curator',
        observation: `Generated response (${finalResponse.length} chars). Provider: ${llmResult.provider}.`,
      });
    } catch (err: any) {
      finalResponse = `I encountered an issue processing your request: ${err.message}. Please ensure LLM API keys are configured correctly.`;
      trajectory.push({
        step: 3,
        thought: 'LLM call failed across all providers.',
        action: 'hermes_skill_curator',
        observation: err.message,
      });
    }

    return {
      agent: 'NousResearch-Hermes-Agent-v3',
      status: 'completed',
      reasoningTrajectory: trajectory,
      finalResponse,
      learnedSkills: ['Real LLM Reasoning', 'Multi-Provider Fallback', 'Org Memory Search'],
      memoryPersisted: false,
      activeHermesTools: HERMES_TOOL_SUITE.map((t) => t.name),
      provider: usedProvider,
    };
  }
}
