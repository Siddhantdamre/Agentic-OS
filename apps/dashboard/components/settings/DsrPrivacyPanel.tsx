'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Download, Trash2, ShieldAlert } from 'lucide-react';

type DsrRequestRow = {
  id: string;
  kind: string;
  status: string;
  progress: Record<string, unknown>;
  result: Record<string, unknown>;
  downloadPath: string | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
};

type Props = {
  orgSlug: string;
  orgName: string;
  /** Role of the signed-in user. Delete is owner-only; the server enforces it too. */
  viewerRole?: string | null;
};

export function DsrPrivacyPanel({ orgSlug, orgName, viewerRole = null }: Props) {
  // Fail closed: hidden until the role is known to be owner. Server re-checks.
  const canDelete = viewerRole === 'owner';
  const [requests, setRequests] = useState<DsrRequestRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'export' | 'delete' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionOk, setActionOk] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const fetchRequests = useCallback(async () => {
    try {
      const res = await fetch('/api/dsr');
      if (res.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (res.status === 403) {
        setLoadError('Only owners and admins can view data subject requests.');
        setRequests([]);
        return;
      }
      if (!res.ok) {
        setLoadError('We couldn’t load DSR history. Please try again.');
        return;
      }
      const data = (await res.json()) as { requests?: DsrRequestRow[] };
      setRequests(data.requests || []);
      setLoadError(null);
    } catch {
      setLoadError('Failed to load DSR history');
    }
  }, []);

  useEffect(() => {
    void fetchRequests();
  }, [fetchRequests]);

  useEffect(() => {
    const hasOpen = requests.some((r) => r.status === 'pending' || r.status === 'running');
    if (!hasOpen) return;
    const t = setInterval(() => {
      void fetchRequests();
    }, 3000);
    return () => clearInterval(t);
  }, [requests, fetchRequests]);

  const startExport = async () => {
    setBusy('export');
    setActionError(null);
    setActionOk(null);
    try {
      const res = await fetch('/api/dsr/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; dsrRequestId?: string };
      if (!res.ok) {
        setActionError(data.error || 'We couldn’t prepare your export. Please try again.');
        return;
      }
      setActionOk(`Export queued (${data.dsrRequestId?.slice(0, 8)}…). Download appears when completed.`);
      await fetchRequests();
    } catch {
      setActionError('Export request failed');
    } finally {
      setBusy(null);
    }
  };

  const startDelete = async () => {
    setBusy('delete');
    setActionError(null);
    setActionOk(null);
    try {
      const res = await fetch('/api/dsr/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: confirmText }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; dsrRequestId?: string };
      if (!res.ok) {
        setActionError(data.error || 'We couldn’t delete that. Please try again.');
        return;
      }
      setConfirmOpen(false);
      setConfirmText('');
      setActionOk(`Delete queued (${data.dsrRequestId?.slice(0, 8)}…). Progress updates below.`);
      await fetchRequests();
    } catch {
      setActionError('Delete request failed');
    } finally {
      setBusy(null);
    }
  };

  const confirmHint = orgSlug || orgName;

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="bg-white border border-cream-300 rounded-3xl p-8 space-y-4 shadow-sm">
        <h2 className="text-lg font-serif font-bold text-heading flex items-center gap-2">
          <ShieldAlert className="w-5 h-5 text-amber-700" />
          Privacy &amp; data subject requests
        </h2>
        <p className="text-sm text-slate-600">
          Export a JSON copy of this organization&apos;s Darex data, or permanently delete org
          memory, conversations, and related agent state. Export is available to owners and admins;
          delete is owner-only and irreversible.
        </p>

        <div className="flex flex-wrap gap-3 pt-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void startExport()}
            className="px-5 py-2.5 bg-amber-500 hover:bg-amber-600 font-semibold text-heading text-xs rounded-xl shadow-md transition-colors disabled:opacity-50 inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" />
            {busy === 'export' ? 'Starting…' : 'Export org data'}
          </button>
          {canDelete && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => {
              setConfirmOpen(true);
              setActionError(null);
            }}
            className="px-5 py-2.5 bg-red-600 hover:bg-red-700 font-semibold text-white text-xs rounded-xl shadow-md transition-colors disabled:opacity-50 inline-flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Delete org data
          </button>
          )}
        </div>

        {actionOk && <p className="text-xs font-medium text-emerald-700">{actionOk}</p>}
        {actionError && <p className="text-xs font-medium text-red-700">{actionError}</p>}
      </div>

      {canDelete && confirmOpen && (
        <div className="bg-red-50 border border-red-200 rounded-3xl p-6 space-y-4">
          <h3 className="text-sm font-bold text-red-900">Confirm irreversible delete</h3>
          <p className="text-xs text-red-800">
            Type <span className="font-mono font-semibold">{confirmHint}</span> to confirm. This
            permanently deletes your conversations, everything your AI employees have learned, and their saved progress for this business.
          </p>
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={confirmHint}
            className="w-full px-4 py-2.5 bg-white border border-red-200 rounded-xl text-sm font-medium focus:outline-none focus:border-red-500"
            autoComplete="off"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy !== null || !confirmText.trim()}
              onClick={() => void startDelete()}
              className="px-4 py-2 bg-red-600 text-white text-xs font-semibold rounded-xl disabled:opacity-50"
            >
              {busy === 'delete' ? 'Deleting…' : 'Confirm delete'}
            </button>
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => {
                setConfirmOpen(false);
                setConfirmText('');
              }}
              className="px-4 py-2 bg-white border border-cream-300 text-xs font-semibold rounded-xl"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border border-cream-300 rounded-3xl p-8 space-y-4 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-heading uppercase tracking-wider">Request history</h3>
          <button
            type="button"
            onClick={() => void fetchRequests()}
            className="text-xs font-semibold text-amber-700 hover:underline"
          >
            Refresh
          </button>
        </div>
        {loadError ? (
          <p className="text-sm text-red-700">{loadError}</p>
        ) : requests.length === 0 ? (
          <p className="text-sm text-slate-500">No export or delete requests yet.</p>
        ) : (
          <ul className="space-y-3">
            {requests.map((r) => {
              const doneCount = Array.isArray((r.progress as { doneTables?: unknown })?.doneTables)
                ? ((r.progress as { doneTables: unknown[] }).doneTables.length as number)
                : 0;
              return (
                <li
                  key={r.id}
                  className="border border-cream-300 rounded-2xl px-4 py-3 text-xs space-y-1"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-bold text-heading capitalize">
                      {r.kind} · {r.status}
                    </span>
                    <span className="text-slate-400 font-mono">{r.id.slice(0, 8)}</span>
                  </div>
                  <p className="text-slate-500">
                    Started {new Date(r.createdAt).toLocaleString()}
                    {r.completedAt ? ` · finished ${new Date(r.completedAt).toLocaleString()}` : ''}
                  </p>
                  {(r.status === 'running' || r.status === 'pending') && r.kind === 'delete' && (
                    <p className="text-amber-800">
                      Progress: {doneCount} table(s) done
                      {(r.progress as { currentTable?: string })?.currentTable
                        ? ` · current: ${(r.progress as { currentTable?: string }).currentTable}`
                        : ''}
                    </p>
                  )}
                  {r.error && <p className="text-red-700">{r.error}</p>}
                  {r.downloadPath && (
                    <a
                      href={r.downloadPath}
                      className="inline-flex items-center gap-1 text-amber-700 font-semibold hover:underline"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download JSON
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
