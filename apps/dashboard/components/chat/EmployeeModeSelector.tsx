'use client';

import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Users, Sparkles, UserRound, X } from 'lucide-react';
import {
  AskEmployeeOption,
  AskMode,
  AskRouting,
  TEAM_EMPLOYEE_CAP,
  employeeIdsForRequest,
  employeeInitials,
  filterEmployeesBySearch,
  toggleTeamSelection,
} from '@/lib/ask-mode-selection';

export type { AskEmployeeOption, AskMode, AskRouting };

export interface EmployeeModeSelectorProps {
  mode: AskMode;
  employeeIds: string[];
  employees: AskEmployeeOption[];
  disabled?: boolean;
  onChange: (next: { mode: AskMode; employeeIds: string[] }) => void;
  /** When true, open the panel (e.g. from "Not right? Pick someone"). */
  requestOpen?: boolean;
  onRequestOpenConsumed?: () => void;
  /** When set with requestOpen, switch to this mode before opening. */
  requestMode?: AskMode;
}

const MODE_OPTIONS: Array<{ id: AskMode; label: string; hint: string }> = [
  { id: 'auto', label: 'Auto', hint: 'Roster routes each message' },
  { id: 'single', label: 'Pick one', hint: 'Lock to one employee' },
  { id: 'team', label: 'Team', hint: `Up to ${TEAM_EMPLOYEE_CAP} employees` },
];

function useIsMobile(breakpoint = 768): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [breakpoint]);
  return mobile;
}

function Avatar({ employee, size = 'md' }: { employee: AskEmployeeOption; size?: 'sm' | 'md' }) {
  const dim = size === 'sm' ? 'w-7 h-7 text-[10px]' : 'w-9 h-9 text-xs';
  if (employee.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={employee.avatarUrl}
        alt=""
        className={`${dim} rounded-xl object-cover border border-amber-500/30 shrink-0`}
      />
    );
  }
  return (
    <div
      className={`${dim} rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-800 font-bold flex items-center justify-center shrink-0`}
      aria-hidden
    >
      {employeeInitials(employee.name)}
    </div>
  );
}

function triggerLabel(
  mode: AskMode,
  employeeIds: string[],
  employees: AskEmployeeOption[]
): string {
  if (mode === 'auto') return 'Auto';
  if (mode === 'single') {
    const emp = employees.find((e) => e.id === employeeIds[0]);
    return emp ? emp.name : 'Pick one';
  }
  if (employeeIds.length === 0) return 'Team';
  if (employeeIds.length === 1) {
    const emp = employees.find((e) => e.id === employeeIds[0]);
    return emp ? emp.name : 'Team · 1';
  }
  return `Team · ${employeeIds.length}`;
}

export function EmployeeModeSelector({
  mode,
  employeeIds,
  employees,
  disabled,
  onChange,
  requestOpen,
  onRequestOpenConsumed,
  requestMode,
}: EmployeeModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlight, setHighlight] = useState(0);
  const isMobile = useIsMobile();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const labelId = useId();

  const activeEmployees = employees.filter((e) => e.status === 'active');
  const filtered = filterEmployeesBySearch(activeEmployees, search);
  const atTeamCap = mode === 'team' && employeeIds.length >= TEAM_EMPLOYEE_CAP;

  const close = useCallback(() => {
    setOpen(false);
    setSearch('');
    setHighlight(0);
  }, []);

  const openPanel = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    setHighlight(0);
  }, [disabled]);

  useEffect(() => {
    if (!requestOpen) return;
    if (requestMode && requestMode !== mode) {
      const ids =
        requestMode === 'auto'
          ? []
          : requestMode === 'single'
            ? employeeIds.slice(0, 1)
            : employeeIds.slice(0, TEAM_EMPLOYEE_CAP);
      onChange({ mode: requestMode, employeeIds: ids });
    }
    openPanel();
    onRequestOpenConsumed?.();
  }, [requestOpen, requestMode, mode, employeeIds, onChange, openPanel, onRequestOpenConsumed]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => searchRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  useEffect(() => {
    setHighlight(0);
  }, [search, mode]);

  const setMode = (next: AskMode) => {
    if (next === 'auto') {
      onChange({ mode: 'auto', employeeIds: [] });
      close();
      return;
    }
    if (next === 'single') {
      onChange({
        mode: 'single',
        employeeIds: employeeIds.slice(0, 1),
      });
      return;
    }
    onChange({
      mode: 'team',
      employeeIds: employeeIds.slice(0, TEAM_EMPLOYEE_CAP),
    });
  };

  const selectEmployee = (id: string) => {
    if (mode === 'auto') {
      onChange({ mode: 'single', employeeIds: [id] });
      close();
      return;
    }
    if (mode === 'single') {
      onChange({ mode: 'single', employeeIds: [id] });
      close();
      return;
    }
    const { ids } = toggleTeamSelection(employeeIds, id, TEAM_EMPLOYEE_CAP);
    onChange({ mode: 'team', employeeIds: ids });
  };

  const focusableCount =
    MODE_OPTIONS.length + (mode === 'auto' ? 0 : filtered.length);

  const moveHighlight = (delta: number) => {
    if (focusableCount === 0) return;
    setHighlight((h) => {
      const next = (h + delta + focusableCount) % focusableCount;
      return next;
    });
  };

  const activateHighlight = () => {
    if (highlight < MODE_OPTIONS.length) {
      setMode(MODE_OPTIONS[highlight].id);
      return;
    }
    const empIdx = highlight - MODE_OPTIONS.length;
    const emp = filtered[empIdx];
    if (emp) selectEmployee(emp.id);
  };

  const locked =
    mode === 'single'
      ? activeEmployees.find((e) => e.id === employeeIds[0])
      : null;
  const teamLocked =
    mode === 'team'
      ? activeEmployees.filter((e) => employeeIds.includes(e.id))
      : [];

  const panel = open ? (
    <div
      role="dialog"
      aria-labelledby={labelId}
      className={
        isMobile
          ? 'fixed inset-x-0 bottom-0 z-50 max-h-[85vh] rounded-t-3xl border border-cream-300 bg-white shadow-2xl flex flex-col'
          : 'absolute bottom-full mb-2 right-0 z-40 w-[min(100vw-1.5rem,22rem)] max-h-[24rem] rounded-2xl border border-cream-300 bg-white shadow-lg flex flex-col'
      }
    >
      {isMobile ? (
        <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-cream-200">
          <div className="h-1 w-10 rounded-full bg-cream-300 mx-auto absolute left-1/2 -translate-x-1/2 top-2" aria-hidden />
          <h2 id={labelId} className="text-sm font-bold text-heading pt-2">
            Who answers
          </h2>
          <button
            type="button"
            onClick={close}
            className="p-2 rounded-xl text-slate-500 hover:bg-cream-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ) : (
        <div className="px-3 pt-3 pb-1">
          <h2 id={labelId} className="text-xs font-bold text-heading">
            Who answers
          </h2>
        </div>
      )}

      <div className="px-3 pt-2 flex gap-1.5" role="group" aria-label="Answer mode">
        {MODE_OPTIONS.map((opt, idx) => {
          const selected = mode === opt.id;
          const focused = highlight === idx;
          return (
            <button
              key={opt.id}
              type="button"
              id={`${listId}-mode-${opt.id}`}
              aria-pressed={selected}
              onMouseEnter={() => setHighlight(idx)}
              onClick={() => setMode(opt.id)}
              className={`flex-1 min-w-0 px-2 py-2 rounded-xl text-[11px] font-semibold border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                selected
                  ? 'bg-amber-500/15 border-amber-500/50 text-amber-900'
                  : focused
                    ? 'bg-cream-100 border-cream-300 text-heading'
                    : 'bg-white border-cream-200 text-slate-600 hover:bg-cream-50'
              }`}
            >
              <span className="block truncate">{opt.label}</span>
              <span className="block text-[9px] font-normal text-slate-500 truncate mt-0.5">
                {opt.hint}
              </span>
            </button>
          );
        })}
      </div>

      {mode !== 'auto' ? (
        <>
          <div className="px-3 pt-2">
            <label className="sr-only" htmlFor={`${listId}-search`}>
              Search employees
            </label>
            <input
              id={`${listId}-search`}
              ref={searchRef}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  moveHighlight(1);
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  moveHighlight(-1);
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  activateHighlight();
                }
              }}
              placeholder="Search by name or role"
              className="w-full px-3 py-2 text-xs rounded-xl border border-cream-300 bg-cream-50/50 text-heading placeholder:text-slate-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            />
          </div>
          {mode === 'team' && atTeamCap ? (
            <p className="px-3 pt-2 text-[11px] text-amber-800 font-medium" role="status">
              Team is full ({TEAM_EMPLOYEE_CAP} max). Deselect someone to add another.
            </p>
          ) : null}
          <ul
            id={listId}
            role="listbox"
            aria-label="Active employees"
            aria-multiselectable={mode === 'team'}
            className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5 min-h-0"
          >
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-xs text-slate-500 text-center">
                No active employees match.
              </li>
            ) : (
              filtered.map((emp, idx) => {
                const optionIndex = MODE_OPTIONS.length + idx;
                const selected = employeeIds.includes(emp.id);
                const focused = highlight === optionIndex;
                const disabledOption = mode === 'team' && atTeamCap && !selected;
                const optionLabel = `${emp.name}, ${emp.role || 'employee'}`;
                return (
                  <li key={emp.id} role="option" aria-selected={selected} aria-disabled={disabledOption}>
                    <button
                      type="button"
                      disabled={disabledOption}
                      aria-label={optionLabel}
                      onMouseEnter={() => setHighlight(optionIndex)}
                      onClick={() => selectEmployee(emp.id)}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-40 disabled:cursor-not-allowed ${
                        selected
                          ? 'bg-amber-50 border border-amber-300'
                          : focused
                            ? 'bg-cream-100 border border-cream-300'
                            : 'border border-transparent hover:bg-cream-50'
                      }`}
                    >
                      <Avatar employee={emp} size="sm" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold text-heading truncate">
                          {emp.name}
                        </span>
                        <span className="block text-[10px] text-slate-500 truncate">
                          {emp.role || 'Employee'}
                          {' · '}
                          {emp.toolCount} {emp.toolCountLabel}
                        </span>
                      </span>
                      {selected ? (
                        <Check className="w-4 h-4 text-amber-700 shrink-0" aria-hidden />
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </>
      ) : (
        <p className="px-3 py-3 text-[11px] text-slate-500 leading-relaxed">
          Each message is routed to the best-matching active employee. You can still override one
          turn with @Name.
        </p>
      )}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative shrink-0">
      {isMobile && open ? (
        <button
          type="button"
          aria-hidden
          tabIndex={-1}
          className="fixed inset-0 z-40 bg-slate-900/40"
          onClick={close}
        />
      ) : null}
      {panel}
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Who answers"
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !open) {
            e.preventDefault();
            openPanel();
          } else if (e.key === 'Escape' && open) {
            e.preventDefault();
            close();
          }
        }}
        className={`inline-flex items-center gap-1.5 max-w-[9.5rem] sm:max-w-[11rem] px-2.5 py-2 rounded-xl text-xs font-semibold border shadow-sm transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 disabled:opacity-40 ${
          mode === 'auto'
            ? 'bg-white border-cream-300 text-slate-700 hover:bg-cream-50'
            : 'bg-amber-500/15 border-amber-500/45 text-amber-900 hover:bg-amber-500/25'
        }`}
      >
        {mode === 'auto' ? (
          <Sparkles className="w-3.5 h-3.5 text-amber-700 shrink-0" aria-hidden />
        ) : mode === 'team' ? (
          <Users className="w-3.5 h-3.5 text-amber-700 shrink-0" aria-hidden />
        ) : (
          <UserRound className="w-3.5 h-3.5 text-amber-700 shrink-0" aria-hidden />
        )}
        <span className="truncate">{triggerLabel(mode, employeeIds, activeEmployees)}</span>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden
        />
      </button>

      {(locked || teamLocked.length > 0) && (
        <div className="sr-only" aria-live="polite">
          {locked
            ? `Locked to ${locked.name}`
            : `Team: ${teamLocked.map((e) => e.name).join(', ')}`}
        </div>
      )}
    </div>
  );
}

/** Locked-employee strip shown above the composer. */
export function AskModeLockStrip({
  mode,
  employeeIds,
  employees,
  onClear,
}: {
  mode: AskMode;
  employeeIds: string[];
  employees: AskEmployeeOption[];
  onClear?: () => void;
}) {
  if (mode === 'auto') return null;
  const active = employees.filter((e) => e.status === 'active');
  const selected = active.filter((e) => employeeIds.includes(e.id));
  if (mode === 'single' && selected[0]) {
    const emp = selected[0];
    return (
      <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-xl bg-amber-50 border border-amber-200/80 text-[11px] text-amber-900">
        <Avatar employee={emp} size="sm" />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">Asking {emp.name}</span>
          {emp.role ? <span className="text-amber-800/80"> · {emp.role}</span> : null}
        </span>
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 text-[10px] font-semibold text-amber-800 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
          >
            Switch to Auto
          </button>
        ) : null}
      </div>
    );
  }
  if (mode === 'team' && selected.length > 0) {
    return (
      <div className="flex items-center flex-wrap gap-1.5 px-2.5 py-1.5 rounded-xl bg-amber-50 border border-amber-200/80 text-[11px] text-amber-900">
        <Users className="w-3.5 h-3.5 text-amber-700 shrink-0" aria-hidden />
        <span className="font-semibold shrink-0">Team</span>
        {selected.map((emp) => (
          <span
            key={emp.id}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-white border border-amber-200 font-medium"
          >
            {emp.name}
          </span>
        ))}
        {onClear ? (
          <button
            type="button"
            onClick={onClear}
            className="ml-auto shrink-0 text-[10px] font-semibold text-amber-800 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
          >
            Switch to Auto
          </button>
        ) : null}
      </div>
    );
  }
  if (mode === 'single' || mode === 'team') {
    return (
      <p className="text-[11px] text-amber-800 px-1 font-medium" role="status">
        {mode === 'single'
          ? 'Pick an employee — replies stay locked until you change mode.'
          : `Select 1–${TEAM_EMPLOYEE_CAP} employees for this chat.`}
      </p>
    );
  }
  return null;
}

/** Per-reply routing chip. */
export function AskRoutingChip({
  routing,
  handledBy,
  onPickSomeone,
}: {
  routing?: AskRouting;
  handledBy?: string;
  onPickSomeone?: () => void;
}) {
  if (!routing && !handledBy) return null;
  const reason =
    routing?.reason?.trim() ||
    (handledBy ? `Handled by ${handledBy}` : '');
  if (!reason && !routing?.fallbackNotice && !routing?.overriddenByMention) return null;

  return (
    <div className="flex flex-col gap-1 px-1 max-w-full">
      {reason ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-amber-900 bg-amber-50 border border-amber-200/80 px-2 py-0.5 rounded-lg">
            <Sparkles className="w-3 h-3 text-amber-700 shrink-0" aria-hidden />
            <span className="truncate">{reason}</span>
          </span>
          {onPickSomeone ? (
            <button
              type="button"
              onClick={onPickSomeone}
              className="text-[11px] font-semibold text-amber-800 underline-offset-2 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
            >
              Not right? Pick someone
            </button>
          ) : null}
        </div>
      ) : null}
      {routing?.overriddenByMention ? (
        <p className="text-[10px] text-slate-500 px-0.5">
          @Name overrode the mode for this message only.
        </p>
      ) : null}
      {routing?.fallbackNotice ? (
        <p className="text-[10px] text-amber-800/90 px-0.5" role="status">
          {routing.fallbackNotice}
        </p>
      ) : null}
    </div>
  );
}

/** Re-export for callers that build the POST body. */
export { employeeIdsForRequest, TEAM_EMPLOYEE_CAP };
