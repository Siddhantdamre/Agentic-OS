'use client';

import React from 'react';
import Link from 'next/link';
import { HeartPulse, ExternalLink } from 'lucide-react';
import { StatusBadge, type StatusTone } from '@/components/a11y';
import type { PlatformObservability } from './types';

function readyTone(status: string | null | undefined): StatusTone {
  switch ((status || '').toLowerCase()) {
    case 'ok':
    case 'healthy':
      return 'success';
    case 'degraded':
      return 'warning';
    case 'unhealthy':
    case 'error':
      return 'danger';
    default:
      return 'neutral';
  }
}

function readyLabel(status: string | null | undefined): string {
  const s = (status || '').trim();
  if (!s) return 'unknown';
  return s;
}

type Props = {
  data: PlatformObservability | null;
  loading: boolean;
  error: string | null;
};

/**
 * Platform health strip. Missing signals render as unknown — never a fake green.
 */
export function PlatformHealthStrip({ data, loading, error }: Props) {
  const readyStatus = data?.ready?.status ?? null;
  const checks = data?.ready?.checks ?? {};
  const checkEntries = Object.entries(checks);

  return (
    <div className="bg-white border border-cream-300 rounded-3xl p-4 sm:p-5 shadow-sm space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <HeartPulse className="w-5 h-5 text-amber-700 shrink-0" aria-hidden="true" />
          <h2 className="text-sm font-serif font-bold text-heading">Platform health</h2>
          {loading ? (
            <StatusBadge label="loading" tone="pending" icon="clock" />
          ) : error ? (
            <StatusBadge label="unavailable" tone="danger" icon="error" />
          ) : (
            <StatusBadge
              label={readyLabel(readyStatus)}
              tone={readyTone(readyStatus)}
            />
          )}
        </div>
        <Link
          href="/api/health/ready"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-semibold text-slate-500 hover:text-heading"
        >
          /api/health/ready
          <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </Link>
      </div>

      {error ? (
        <p className="text-xs text-red-700">{error}</p>
      ) : null}

      {!loading && !error && (
        <div className="flex flex-wrap gap-2">
          {checkEntries.length === 0 ? (
            <StatusBadge label="checks unknown" tone="neutral" icon="none" />
          ) : (
            checkEntries.map(([name, check]) => (
              <StatusBadge
                key={name}
                label={`${name}: ${readyLabel(check?.status)}`}
                tone={readyTone(check?.status)}
                icon="none"
              />
            ))
          )}
          {data?.dunningCount != null ? (
            <StatusBadge
              label={`dunning ${data.dunningCount}`}
              tone={data.dunningCount > 0 ? 'warning' : 'neutral'}
              icon="none"
            />
          ) : (
            <StatusBadge label="dunning unknown" tone="neutral" icon="none" />
          )}
          {data?.llmCost === 'unknown' || data?.llmCost == null ? (
            <StatusBadge label="llm cost unknown" tone="neutral" icon="none" />
          ) : (
            <StatusBadge label={`llm $${Number(data.llmCost).toFixed(2)}`} tone="info" icon="none" />
          )}
          {Array.isArray(data?.alertOrgs) ? (
            <StatusBadge
              label={`alerts ${data.alertOrgs.length}`}
              tone={data.alertOrgs.length > 0 ? 'danger' : 'neutral'}
              icon="none"
            />
          ) : (
            <StatusBadge label="alerts unknown" tone="neutral" icon="none" />
          )}
        </div>
      )}
    </div>
  );
}
