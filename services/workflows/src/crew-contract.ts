/**
 * Pure crew helpers. Safe to import from Temporal workflow isolate
 * (no Node, pg, or fetch).
 */

export const MAX_CREW_SPAWN = 3;

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

export function buildCrewSynthesisPrompt(
  userMessage: string,
  reports: { employeeName: string; employeeRole: string; task: string; reply: string }[]
): string {
  const blocks = reports.map((r, i) => {
    const reply = r.reply && r.reply.trim() ? r.reply.trim() : '(no reply)';
    return [
      `### Specialist ${i + 1}: ${r.employeeName} (${r.employeeRole})`,
      `Assigned task: ${r.task}`,
      'Report:',
      reply,
    ].join('\n');
  });
  return [
    'You are the manager synthesizing a multi-employee crew.',
    'Combine the specialist reports into one clear answer for the user.',
    'Do not redo their tool work. If a specialist hit notConnected, say so honestly.',
    'Do not mention Temporal, crews, or internal routing unless asked.',
    '',
    'Original request:',
    userMessage,
    '',
    ...blocks,
  ].join('\n');
}
