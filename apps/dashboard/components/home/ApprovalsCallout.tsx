'use client';

import React from 'react';
import Link from 'next/link';
import { ClipboardCheck } from 'lucide-react';
import { usePendingApprovalCount } from '@/lib/use-pending-approvals';

/** The one thing on Home that needs the person now: approvals waiting. Nothing at all when there are none. */
export function ApprovalsCallout() {
  const n = usePendingApprovalCount();
  if (!n || n < 1) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-amber-950">
        <ClipboardCheck className="h-5 w-5 shrink-0" aria-hidden="true" />
        <span>{n === 1 ? '1 approval is waiting for you' : `${n} approvals are waiting for you`}</span>
      </p>
      <Link
        href="/approvals"
        className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-heading focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-700"
      >
        Review →
      </Link>
    </div>
  );
}
