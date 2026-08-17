/**
 * Tool risk classes + confirm flags (R5).
 * Metadata only — webhook/inbound confirm enforcement is a later workstream.
 */

export type ToolRisk = 'read' | 'draft' | 'send' | 'pay' | 'sign' | 'publish' | 'delete';

const TOOL_RISKS: readonly ToolRisk[] = ['read', 'draft', 'send', 'pay', 'sign', 'publish', 'delete'];

export function isToolRisk(value: string): value is ToolRisk {
  return (TOOL_RISKS as readonly string[]).includes(value);
}

/** Irreversible classes require human confirm. read/draft do not. */
export function confirmForRisk(risk: ToolRisk): boolean {
  switch (risk) {
    case 'read':
    case 'draft':
      return false;
    case 'send':
    case 'pay':
    case 'sign':
    case 'publish':
    case 'delete':
      return true;
    default: {
      const _exhaustive: never = risk;
      return _exhaustive;
    }
  }
}
