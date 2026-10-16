/** Turns the evidence of where an employee keeps going wrong into ONE proposal for the owner to read. */
import { MIN_PER_TOPIC, type Topic } from '../replay/grade.js';

export type FailureKind = 'rejection' | 'edit' | 'thumbs_down' | 'replay_miss';
export interface FailureEvent { id: string; kind: FailureKind; topic: Topic }
export interface Cluster { topic: Topic; count: number; impact: number; byKind: Partial<Record<FailureKind, number>>; exampleIds: string[] }

/** A replay miss (invented number, over-promise) costs most; a small edit least. */
export const WEIGHT: Record<FailureKind, number> = { replay_miss: 3, rejection: 2, thumbs_down: 1, edit: 1 };

export function clusterFailures(events: FailureEvent[]): Cluster | null {
  const seen = new Set<string>();
  const map = new Map<Topic, Cluster>();
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const c = map.get(e.topic) ?? { topic: e.topic, count: 0, impact: 0, byKind: {}, exampleIds: [] };
    c.count++;
    c.impact += WEIGHT[e.kind];
    c.byKind[e.kind] = (c.byKind[e.kind] ?? 0) + 1;
    if (c.exampleIds.length < 3) c.exampleIds.push(e.id);
    map.set(e.topic, c);
  }
  const ok = [...map.values()].filter((c) => c.count >= MIN_PER_TOPIC);
  ok.sort((a, b) => b.impact - a.impact || b.count - a.count || a.topic.localeCompare(b.topic));
  return ok[0] ?? null;
}

const KIND_WORDS: Record<FailureKind, string> = { replay_miss: 'replay misses', rejection: 'rejected drafts', thumbs_down: 'thumbs-downs', edit: 'edited drafts' };

export function proposalSummary(input: { cluster: Cluster; change: string; kind: 'instruction' | 'knowledge' }): string {
  const { cluster: c, change, kind } = input;
  const parts = (Object.keys(c.byKind) as FailureKind[]).map((k) => `${c.byKind[k]} ${KIND_WORDS[k]}`).join(', ');
  return [
    `What I noticed: replies about ${c.topic} went wrong ${c.count} times (${parts}).`,
    `What I want to change: ${change}`,
    `Why: this is the topic where you corrected me most, and fixing it saves you the most rework.`,
    `How we'll test it: the new wording is tried on past ${c.topic} messages I was not tuned on, next to the current wording. It only goes forward if it is better overall, no worse on any topic, and makes up no numbers or promises.`,
    `Nothing changes until ${kind === 'instruction' ? 'an admin' : 'you'} approves it. It starts as a silent trial, then 10% of messages, and I cannot give myself new tools or take away your approval step.`,
  ].join('\n');
}
