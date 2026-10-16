/**
 * Versioned prompt and policy registry. Every version points at its parent, so any change can be read, compared and
 * undone. A version only becomes `active` through the rollout rules, never by being written here.
 */

export type VersionStatus = 'draft' | 'shadow' | 'canary' | 'active' | 'rolled_back';

export interface Version {
  id: string;
  key: string;
  text: string;
  parent: string | null;
  createdAt: string;
  status: VersionStatus;
  approvedBy?: string;
}

export interface VersionDiff {
  from: string;
  to: string;
  added: string[];
  removed: string[];
  changed: boolean;
}

export interface Registry {
  create(input: { key: string; text: string; parent?: string | null; now?: string }): Version;
  get(id: string): Version | undefined;
  history(key: string): Version[];
  active(key: string): Version | undefined;
  setStatus(id: string, status: VersionStatus, approvedBy?: string): Version;
  diff(fromId: string, toId: string): VersionDiff;
  rollback(id: string, now?: string): Version;
}

const lines = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export function diffText(from: string, to: string): { added: string[]; removed: string[] } {
  const a = lines(from);
  const b = lines(to);
  const sa = new Set(a);
  const sb = new Set(b);
  return { added: b.filter((l) => !sa.has(l)), removed: a.filter((l) => !sb.has(l)) };
}

export class InMemoryRegistry implements Registry {
  private byId = new Map<string, Version>();
  private seq = 0;

  create(input: { key: string; text: string; parent?: string | null; now?: string }): Version {
    const parent = input.parent ?? null;
    if (parent !== null) {
      const p = this.byId.get(parent);
      if (!p) throw new Error(`parent version ${parent} does not exist`);
      if (p.key !== input.key) throw new Error('a version can only descend from a version of the same key');
    }
    const v: Version = {
      id: `${input.key}@${++this.seq}`,
      key: input.key,
      text: input.text,
      parent,
      createdAt: input.now ?? new Date().toISOString(),
      status: 'draft',
    };
    this.byId.set(v.id, v);
    return { ...v };
  }

  get(id: string): Version | undefined {
    const v = this.byId.get(id);
    return v ? { ...v } : undefined;
  }

  history(key: string): Version[] {
    return [...this.byId.values()].filter((v) => v.key === key).map((v) => ({ ...v }));
  }

  active(key: string): Version | undefined {
    return this.history(key).filter((v) => v.status === 'active').pop();
  }

  /** Raw status write. It does not check the order of stages: use rollout.ts `advance` for that. */
  setStatus(id: string, status: VersionStatus, approvedBy?: string): Version {
    const v = this.byId.get(id);
    if (!v) throw new Error(`unknown version ${id}`);
    v.status = status;
    if (approvedBy) v.approvedBy = approvedBy;
    if (status === 'active') {
      for (const o of this.byId.values()) if (o.key === v.key && o.id !== v.id && o.status === 'active') o.status = 'rolled_back';
    }
    return { ...v };
  }

  diff(fromId: string, toId: string): VersionDiff {
    const a = this.byId.get(fromId);
    const b = this.byId.get(toId);
    if (!a || !b) throw new Error('both versions must exist to compare them');
    const d = diffText(a.text, b.text);
    return { from: fromId, to: toId, ...d, changed: d.added.length + d.removed.length > 0 };
  }

  /** Mark this version rolled back and make its parent active again. Returns the parent. */
  rollback(id: string): Version {
    const v = this.byId.get(id);
    if (!v) throw new Error(`unknown version ${id}`);
    if (!v.parent) throw new Error('this is the first version: there is nothing earlier to go back to');
    const p = this.byId.get(v.parent)!;
    v.status = 'rolled_back';
    p.status = 'active';
    return { ...p };
  }
}
