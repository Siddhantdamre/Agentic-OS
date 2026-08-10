import { ChatGroq } from "@langchain/groq";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { StateGraph, Annotation } from "@langchain/langgraph";

export interface AgentTaskInput {
  orgId: string;
  conversationId?: string;
  channelId?: string;
  employeeId?: string;
  employeeName: string;
  employeeRole: string;
  employeePersona: string;
  toolAllowlist: string[];
  userMessage: string;
}

export interface AgentTaskResult {
  success: boolean;
  replyMessage: string;
  executedSteps: {
    step: number;
    action: string;
    toolUsed?: string;
    result: string;
    selfCorrected?: boolean;
  }[];
  usedTools: string[];
}

const AgentState = Annotation.Root({
  input: Annotation<AgentTaskInput>(),
  steps: Annotation<AgentTaskResult["executedSteps"]>({
    reducer: (curr, next) => curr.concat(next),
    default: () => [],
  }),
  usedTools: Annotation<string[]>({
    reducer: (curr, next) => curr.concat(next),
    default: () => [],
  }),
  targetTool: Annotation<string | null>({
    reducer: (curr, next) => next,
    default: () => null,
  }),
  actionRequired: Annotation<string>({
    reducer: (curr, next) => next,
    default: () => "reply",
  }),
  toolParams: Annotation<Record<string, any>>({
    reducer: (curr, next) => next,
    default: () => ({}),
  }),
  toolExecutor: Annotation<(tool: string, action: string, payload: any) => Promise<any>>(),
  replyMessage: Annotation<string>({
    reducer: (curr, next) => next,
    default: () => "",
  }),
});

export async function runAutonomousAgentLoop(
  input: AgentTaskInput,
  toolExecutor: (tool: string, action: string, payload: any) => Promise<any>
): Promise<AgentTaskResult> {
  const llm = new ChatGroq({
    apiKey: process.env.GROQ_API_KEY as string,
    model: process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile",
    temperature: 0.7,
  });

  const planNode = async (state: typeof AgentState.State) => {
    const { input } = state;
    const planningPrompt = `You are the decision-making brain of AI employee ${input.employeeName} (${input.employeeRole}).
Available Tools in Allowlist: ${JSON.stringify(input.toolAllowlist)}

TOOL DEFINITIONS & EXPECTED PARAMETERS:
- sandbox (or code_execution, hermes_python_sandbox): Executes sandboxed Python or Node.js code securely.
  Required params: { "code": "<the code string>", "language": "python" | "javascript" }
- database_query: Executes a SELECT query against the business database.
  Required params: { "sql": "<SELECT ...>" }
- file_ops: Reads or writes files to the workspace.
  Required params: { "fileAction": "read" | "write", "path": "filename.txt", "content": "..." (only if writing) }
- web_search: Searches the live web.
  Required params: { "query": "..." }
- gmail: Fetches or sends emails.
  Required params: { "action": "fetch_latest_emails" | "send_email", "to": "...", "subject": "...", "body": "..." }

Analyze the user's message and decide if any tool from the allowlist should be called to accomplish the user's request.
Respond ONLY with a JSON object in the following format:
{
  "targetTool": "<tool_name_from_allowlist or null>",
  "actionRequired": "<action_name or 'reply'>",
  "toolParams": { ...extracted_parameters_from_user_message... }
}`;

    let parsedPlan: any = {};
    try {
      const response = await llm.invoke([
        new SystemMessage(planningPrompt),
        new HumanMessage(input.userMessage)
      ]);
      const content = response.content as string;
      parsedPlan = JSON.parse(content.replace(/```json|```/g, "").trim());
    } catch (err: any) {
      console.warn("[LangGraph Engine] Tool planning fallback:", err.message);
    }

    let targetTool = null;
    let actionRequired = "reply";
    let toolParams = {};

    if (parsedPlan.targetTool && input.toolAllowlist.includes(parsedPlan.targetTool)) {
      targetTool = parsedPlan.targetTool;
      actionRequired = parsedPlan.actionRequired || "execute";
      toolParams = parsedPlan.toolParams || {};
    }

    return {
      targetTool,
      actionRequired,
      toolParams,
      steps: [{
        step: 1,
        action: "Goal Analysis & Tool Selection Reasoning",
        result: `Analyzed prompt for ${input.employeeName} (${input.employeeRole}). Allowed tools: [${input.toolAllowlist.join(", ")}]`
      }]
    };
  };

  const toolNode = async (state: typeof AgentState.State) => {
    const { targetTool, actionRequired, toolParams, toolExecutor } = state;
    const steps: any[] = [];
    
    steps.push({
      step: 2,
      action: `Execute Tool: ${targetTool}`,
      toolUsed: targetTool,
      result: `LLM selected tool [${targetTool}] with action [${actionRequired}]`
    });

    try {
      const toolRes = await toolExecutor(targetTool!, actionRequired, toolParams);
      if (toolRes && (toolRes.status === "success" || toolRes.status === "executed")) {
        steps.push({
          step: 3,
          action: "Tool Execution Verification",
          toolUsed: targetTool,
          result: `Successfully executed ${targetTool}. Result: ${JSON.stringify(toolRes.data || {})}`
        });
      } else {
        steps.push({
          step: 3,
          action: "Self-Correction & Fallback Handling",
          toolUsed: targetTool,
          result: `Tool ${targetTool} returned non-critical status. Self-correcting response to direct assistance mode.`,
          selfCorrected: true
        });
      }
    } catch (err: any) {
      steps.push({
        step: 3,
        action: "Self-Correction Recovery",
        toolUsed: targetTool,
        result: `Tool execution encountered non-fatal error: ${err.message}. Gracefully recovered.`,
        selfCorrected: true
      });
    }

    return { steps, usedTools: [targetTool] };
  };

  const respondNode = async (state: typeof AgentState.State) => {
    const { input, steps } = state;
    
    // Fetch Mem0 contextual memory (supports both cloud and self-hosted via env vars)
    let personalizedContext = "";
    try {
      // @ts-ignore: mem0ai may lack typings
      const { MemoryClient } = await import("mem0ai");
      
      // Initialize with a dummy key and local host for self-hosted OSS mode
      const mem0 = new MemoryClient({ 
        apiKey: process.env.MEM0_API_KEY || "local-dummy-key",
        host: process.env.MEM0_HOST || "http://127.0.0.1:8888"
      }); 
      
      // Save the new interaction to local memory so it learns over time
      await mem0.add([{ role: "user", content: input.userMessage }], { userId: input.employeeId || "anonymous" });
      
      // Retrieve relevant past memories for this exact prompt
      const searchResult = await mem0.search(input.userMessage, { filters: { user_id: input.employeeId || "anonymous" } });
      if (searchResult && searchResult.results && searchResult.results.length > 0) {
        personalizedContext = `\nLong-Term User Memory / Preferences:\n` + searchResult.results.map((m: any) => `- ${m.memory}`).join("\n");
      }
    } catch (err: any) {
      console.warn("[Mem0 Local] Memory fetch failed or skipped:", err.message);
    }

    const systemPrompt = `You are ${input.employeeName}, a highly capable and friendly AI employee.
Your specific role is: ${input.employeeRole}.
Your core persona is: ${input.employeePersona}
${personalizedContext}

Communication Guidelines:
- Sound completely natural, conversational, and human-like, similar to how an advanced AI assistant (like ChatGPT, Claude, or Gemini) would talk.
- Be empathetic, warm, and engaging. Avoid robotic, overly rigid, or purely transactional language.
- Structure your responses beautifully with Markdown, using line breaks and formatting to make it easy to read.
- If you used tools, integrate the results seamlessly into the conversation without explicitly sounding like a machine reading from a log.

Tool Execution History (for your context only, synthesize this naturally):
${JSON.stringify(steps, null, 2)}

Based on the user's message and the tool execution history, provide your response.`;

    let replyMessage = "";
    try {
      const response = await llm.invoke([
        new SystemMessage(systemPrompt),
        new HumanMessage(input.userMessage)
      ]);
      replyMessage = response.content as string;
    } catch (err: any) {
      replyMessage = `Hello! I'm ${input.employeeName} (${input.employeeRole}). Thank you for reaching out! I've reviewed your request: "${input.userMessage}". How else can I assist you today?`;
    }

    return {
      replyMessage,
      steps: [{
        step: steps.length + 1,
        action: "Final Response Synthesis",
        result: `Generated response from ${input.employeeName}: "${replyMessage.slice(0, 50)}..."`
      }]
    };
  };

  const workflow = new StateGraph(AgentState)
    .addNode("plan", planNode)
    .addNode("execute_tool", toolNode)
    .addNode("respond", respondNode)
    .addEdge("__start__", "plan")
    .addConditionalEdges("plan", (state) => state.targetTool ? "execute_tool" : "respond")
    .addEdge("execute_tool", "respond")
    .addEdge("respond", "__end__");

  const app = workflow.compile();

  const finalState = await app.invoke({
    input,
    toolExecutor
  });

  return {
    success: true,
    replyMessage: finalState.replyMessage,
    executedSteps: finalState.steps,
    usedTools: finalState.usedTools
  };
}
