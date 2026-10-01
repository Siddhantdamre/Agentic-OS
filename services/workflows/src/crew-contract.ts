/**
 * Pure crew helpers. Safe to import from Temporal workflow isolate
 * (no Node, pg, or fetch).
 */

/**
 * Hard cap on parallel specialist children. Ask AI Team mode and the product
 * spec require 3 per message (UI and server must match). Greetings stay solo
 * unless the caller passes a fixed member set.
 */
export const MAX_CREW_SPAWN = 3;

/**
 * Manager synthesis must finish within this window. Prevents a hung manager
 * turn from holding the crew (and its children' results) open indefinitely.
 * Used by CrewWorkflow (Temporal activity timeout) and runCrewDirect (Promise.race).
 */
export const MANAGER_SYNTHESIS_TIMEOUT = '3 minutes' as const;
export const MANAGER_SYNTHESIS_TIMEOUT_MS = 180_000;

/** Cap each specialist report so manager synthesis stays within small context windows. */
export const SPECIALIST_REPORT_MAX_CHARS = 2_500;

export function truncateSpecialistReport(reply: string, maxChars = SPECIALIST_REPORT_MAX_CHARS): string {
  const text = reply && reply.trim() ? reply.trim() : '(no reply)';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}… [truncated]`;
}

/**
 * Reply to show when the manager finishes with no text at all. The specialists
 * still did the work, so surface their reports instead of a blank answer.
 */
export function fallbackCrewReply(
  spawned: Array<{ employeeName: string; result: { replyMessage?: string; error?: string } }>,
): string {
  const usable = spawned
    .map((s) => ({ name: s.employeeName, text: (s.result.replyMessage || '').trim() }))
    .filter((s) => s.text);
  if (usable.length === 0) {
    return 'The team finished, but no specialist returned a written result. Try again or ask one employee directly.';
  }
  return [
    'The manager did not write a summary, so here are the specialist reports:',
    ...usable.map((s) => `**${s.name}**\n${truncateSpecialistReport(s.text)}`),
  ].join('\n\n');
}

export function capCrewSpecialists<T>(items: T[]): T[] {
  return items.slice(0, MAX_CREW_SPAWN);
}

export function crewChildWorkflowId(
  parentId: string,
  index: number,
  employeeId: string,
  employeeName: string
): string {
  const slug = (employeeName || 'emp').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'emp';
  const id = (employeeId || 'x').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 12);
  return `${parentId}-spawn-${index}-${slug}-${id}`;
}

/**
 * Persona suffix for a Team-mode specialist. Out-of-scope work gets a short
 * "nothing for me" reply (with the employee's name) and no tool calls.
 */
export function buildFixedMemberPersonaSuffix(employeeName: string): string {
  const name = employeeName?.trim() || 'this employee';
  return [
    `Team mode: you (${name}) were explicitly selected for this crew.`,
    `If this message is outside your job, reply with a short "nothing for me" that includes your name (${name}) and do not call tools.`,
    'Do not invent work. You must still produce a report so the manager can keep you on the team.',
  ].join(' ');
}

export function applyFixedMemberPersona(persona: string, employeeName: string): string {
  const base = persona?.trim() || 'A helpful business AI assistant.';
  return `${base}\n\n${buildFixedMemberPersonaSuffix(employeeName)}`;
}

/** Shape shared by AgentTaskInput specialists when applying fixed-member instructions. */
export type FixedMemberSpecialistLike = {
  employeeName: string;
  employeePersona: string;
  userMessage: string;
};

/**
 * Apply Team-mode instructions to each capped specialist. Does not drop any
 * member — the planner is not consulted here.
 */
export function prepareFixedMemberSpecialists<T extends FixedMemberSpecialistLike>(
  specialists: T[],
  userMessage: string,
): T[] {
  return specialists.map((spec) => ({
    ...spec,
    employeePersona: applyFixedMemberPersona(spec.employeePersona, spec.employeeName),
    userMessage: spec.userMessage?.trim() ? spec.userMessage : userMessage,
  }));
}

export function buildCrewSynthesisPrompt(
  userMessage: string,
  reports: { employeeName: string; employeeRole: string; task: string; reply: string }[],
  opts?: { fixedMembers?: boolean },
): string {
  const blocks = reports.map((r, i) => {
    const reply = truncateSpecialistReport(r.reply);
    return [
      `### Specialist ${i + 1}: ${r.employeeName} (${r.employeeRole})`,
      `Assigned task: ${r.task}`,
      'Report:',
      reply,
    ].join('\n');
  });
  const fixedNote = opts?.fixedMembers
    ? [
        'This was a fixed Team roster. Some specialists may report "nothing for me".',
        'Keep those reports in the answer — do not pretend that person was not on the team.',
      ]
    : [];
  return [
    'You are the manager synthesizing a multi-employee crew.',
    'Combine the specialist reports into one clear answer for the user.',
    'Do not redo their tool work. If a specialist hit notConnected, say so honestly.',
    'If a specialist report says execution failed or timed out, do not invent facts on their behalf — state the gap.',
    ...fixedNote,
    'Do not mention Temporal, crews, or internal routing unless asked.',
    '',
    'Original request:',
    userMessage,
    '',
    ...blocks,
  ].join('\n');
}
