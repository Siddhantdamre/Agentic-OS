'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Building2, Check, ChevronRight, Loader2, Plus } from 'lucide-react';

type OrgMembership = {
  id: string;
  name: string;
  role: string;
  status: string;
  isActive: boolean;
  isDefault: boolean;
};

type MembershipsResponse = {
  activeOrgId: string;
  memberships: OrgMembership[];
};

/**
 * Workspace switcher for the icon sidebar.
 * Honest empty: 404 / missing table / empty list → render nothing (no fake orgs).
 */
export function OrganizationSwitcher() {
  const [memberships, setMemberships] = useState<OrgMembership[] | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/org/memberships', { cache: 'no-store' });
      // Endpoint missing, table not ready, or auth — hide rather than invent orgs.
      if (res.status === 404 || !res.ok) {
        setMemberships(null);
        return;
      }
      const data = (await res.json()) as MembershipsResponse;
      if (!Array.isArray(data.memberships) || data.memberships.length === 0) {
        setMemberships(null);
        return;
      }
      setMemberships(data.memberships);
      setActiveOrgId(data.activeOrgId ?? null);
    } catch {
      setMemberships(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setError(null);
        setCreating(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        setError(null);
        setCreating(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (!memberships || memberships.length === 0) return null;

  const active =
    memberships.find((m) => m.isActive || m.id === activeOrgId) ?? memberships[0];

  const switchTo = async (targetOrgId: string) => {
    if (targetOrgId === active.id || switchingId) return;
    setSwitchingId(targetOrgId);
    setError(null);
    try {
      const res = await fetch('/api/org/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetOrgId }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        success?: boolean;
      };
      if (!res.ok) {
        // Surface API text for 402 suspended / 403 not-a-member (and others).
        setError(
          typeof body.error === 'string' && body.error.trim()
            ? body.error
            : 'We couldn’t switch workspace. Please try again.'
        );
        setSwitchingId(null);
        return;
      }
      window.location.reload();
    } catch {
      setError('Switch failed');
      setSwitchingId(null);
    }
  };

  const createWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newName.trim();
    if (!name || createBusy) return;
    setCreateBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/org/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; next?: string };
      if (!res.ok) {
        setError(
          typeof body.error === 'string' && body.error.trim()
            ? body.error
            : 'We couldn’t create the workspace. Please try again.'
        );
        setCreateBusy(false);
        return;
      }
      // Session cookies now point at the new org; full load starts its onboarding.
      window.location.assign(typeof body.next === 'string' ? body.next : '/onboarding/name');
    } catch {
      setError('Could not create workspace');
      setCreateBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={`Workspace: ${active.name}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        title={active.name}
        onClick={() => {
          setOpen((v) => !v);
          setError(null);
        }}
        className={`w-12 h-12 rounded-2xl flex items-center justify-center transition-all group relative focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
          open
            ? 'bg-amber-500 text-heading shadow-md'
            : 'text-slate-500 hover:bg-cream-200 hover:text-heading'
        }`}
      >
        <Building2 className="w-5 h-5" />
        {!open ? (
          <span className="absolute left-full ml-3 px-2.5 py-1.5 bg-slate-900 text-white text-xs rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap font-medium z-50 shadow-lg max-w-[14rem] truncate">
            {active.name}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          id={listId}
          role="listbox"
          aria-label="Workspaces"
          className="absolute left-full top-0 ml-3 w-64 bg-white border border-cream-300 rounded-2xl shadow-lg z-50 overflow-hidden"
        >
          <div className="px-3.5 py-3 border-b border-cream-200 bg-cream-100/70">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-slate-500">
              Workspace
            </p>
            <p className="text-sm font-serif font-bold text-heading truncate" title={active.name}>
              {active.name}
            </p>
            <p className="text-[11px] text-slate-500 capitalize mt-0.5">
              {active.role}
              {active.status && active.status !== 'active' ? ` · ${active.status}` : ''}
            </p>
          </div>

          <ul className="max-h-64 overflow-y-auto py-1.5">
            {memberships.map((org) => {
              const isActive = org.isActive || org.id === activeOrgId;
              const busy = switchingId === org.id;
              return (
                <li key={org.id} role="option" aria-selected={isActive}>
                  <button
                    type="button"
                    disabled={Boolean(switchingId) || isActive}
                    onClick={() => void switchTo(org.id)}
                    className={`w-full text-left px-3.5 py-2.5 flex items-center gap-2.5 transition-colors disabled:cursor-default ${
                      isActive
                        ? 'bg-amber-500/15 text-heading'
                        : 'hover:bg-cream-100 text-slate-700 disabled:opacity-60'
                    }`}
                  >
                    <span className="w-8 h-8 rounded-xl bg-amber-500/20 text-amber-900 flex items-center justify-center shrink-0 text-xs font-bold font-serif">
                      {org.name.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold truncate">{org.name}</span>
                      <span className="block text-[11px] text-slate-500 capitalize">
                        {org.role}
                        {org.status === 'suspended' ? ' · suspended' : ''}
                      </span>
                    </span>
                    {busy ? (
                      <Loader2 className="w-4 h-4 animate-spin text-amber-700 shrink-0" />
                    ) : isActive ? (
                      <Check className="w-4 h-4 text-amber-700 shrink-0" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-slate-300 shrink-0" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="border-t border-cream-200 p-2">
            {creating ? (
              <form onSubmit={createWorkspace} className="flex items-center gap-2">
                <input
                  autoFocus
                  value={newName}
                  onChange={(ev) => setNewName(ev.target.value)}
                  maxLength={80}
                  placeholder="Workspace name"
                  aria-label="New workspace name"
                  className="min-w-0 flex-1 rounded-xl border border-cream-300 bg-white px-3 py-2 text-sm text-heading focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                />
                <button
                  type="submit"
                  disabled={createBusy || !newName.trim()}
                  className="rounded-xl bg-amber-500 px-3 py-2 text-sm font-semibold text-heading disabled:opacity-50 flex items-center gap-1.5"
                >
                  {createBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                  Create
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setCreating(true);
                  setError(null);
                }}
                className="w-full rounded-xl px-3 py-2 flex items-center gap-2 text-sm font-semibold text-slate-700 hover:bg-cream-100"
              >
                <Plus className="w-4 h-4 text-amber-700" />
                New workspace
              </button>
            )}
          </div>

          {error ? (
            <div
              role="alert"
              className="px-3.5 py-2.5 text-xs text-red-800 bg-red-50 border-t border-red-100"
            >
              {error}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
