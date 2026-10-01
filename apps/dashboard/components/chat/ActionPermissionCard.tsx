'use client';

import React, { useState } from 'react';
import {
  ShieldAlert,
  CheckCircle2,
  XCircle,
  Play,
  RefreshCw,
  Mail,
  Calendar,
  MessageSquare,
  Database,
  BarChart2,
  CreditCard,
  Zap,
  ChevronRight,
  ShieldCheck,
  TerminalSquare,
  AlertCircle,
} from 'lucide-react';

export interface ProposedActionData {
  tool: string;
  action: string;
  params: Record<string, any>;
  explanation: string;
}

interface ActionPermissionCardProps {
  actionData: ProposedActionData;
  onExecutionComplete?: (result: any) => void;
}

export const ActionPermissionCard: React.FC<ActionPermissionCardProps> = ({
  actionData,
  onExecutionComplete,
}) => {
  const [status, setStatus] = useState<'pending' | 'executing' | 'approved' | 'cancelled'>('pending');
  const [executionResult, setExecutionResult] = useState<any>(null);
  const [resultStatus, setResultStatus] = useState<'executed' | 'simulated' | 'error' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const getToolIcon = (tool: string) => {
    switch (tool.toLowerCase()) {
      case 'gmail': return <Mail className="w-5 h-5 text-slate-700" />;
      case 'google-calendar': return <Calendar className="w-5 h-5 text-slate-700" />;
      case 'whatsapp': return <MessageSquare className="w-5 h-5 text-slate-700" />;
      case 'hubspot': return <Database className="w-5 h-5 text-slate-700" />;
      case 'meta-ads': case 'google-ads': return <BarChart2 className="w-5 h-5 text-slate-700" />;
      case 'stripe': case 'razorpay': return <CreditCard className="w-5 h-5 text-slate-700" />;
      default: return <TerminalSquare className="w-5 h-5 text-slate-700" />;
    }
  };

  const handleApprove = async () => {
    try {
      setStatus('executing');
      setError(null);
      const res = await fetch('/api/agent/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: actionData.tool,
          action: actionData.action,
          payload: actionData.params,
        }),
      });

      const data = await res.json();
      if (res.ok && data.success) {
        setStatus('approved');
        setExecutionResult(data.result);
        setResultStatus(data.result?.status || 'executed');
        if (onExecutionComplete) onExecutionComplete(data.result);
      } else {
        setStatus('pending');
        setError(data.error || 'Failed to execute action');
      }
    } catch (err: any) {
      setStatus('pending');
      setError(err?.message || 'Failed to execute action');
    }
  };

  const handleCancel = () => {
    setStatus('cancelled');
    setError(null);
  };

  const emailsList = executionResult?.data?.emails;

  return (
    <div className="my-3.5 bg-white border border-cream-200/90 rounded-2xl shadow-xs overflow-hidden transition-all duration-300 font-sans">
      {/* Top Header */}
      <div className="p-4 sm:p-5 border-b border-cream-200/80 flex items-start justify-between bg-cream-50/70 gap-3">
        <div className="flex items-start space-x-3.5 min-w-0">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0 shadow-xs">
            {getToolIcon(actionData.tool)}
          </div>
          <div className="space-y-1 min-w-0">
            <div className="flex items-center space-x-2 flex-wrap gap-y-1">
              <h3 className="font-semibold text-heading text-sm capitalize truncate">
                {actionData.tool.replace('-', ' ')} Action
              </h3>
              {status === 'pending' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-100/90 text-amber-800 border border-amber-300/60 text-[10px] font-semibold tracking-wide">
                  <ShieldAlert className="w-3 h-3 mr-1 text-amber-600" />
                  Permission Required
                </span>
              )}
            </div>
            <p className="text-xs text-slate-600 leading-relaxed max-w-lg">
              {actionData.explanation}
            </p>
          </div>
        </div>

        {/* Status Indicator */}
        <div className="flex shrink-0 pt-0.5">
          {status === 'approved' && (
            <span className="inline-flex items-center space-x-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200/60">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
              <span>Executed</span>
            </span>
          )}
          {status === 'executing' && (
            <span className="inline-flex items-center space-x-1.5 text-xs font-semibold text-amber-800 bg-amber-50 px-2.5 py-1 rounded-full border border-amber-300/60 animate-pulse">
              <RefreshCw className="w-3.5 h-3.5 text-amber-600 animate-spin" />
              <span>Running</span>
            </span>
          )}
          {status === 'cancelled' && (
            <span className="inline-flex items-center space-x-1.5 text-xs font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-full border border-slate-200">
              <XCircle className="w-3.5 h-3.5 text-slate-400" />
              <span>Declined</span>
            </span>
          )}
        </div>
      </div>

      {/* Action Parameters (Pending) */}
      {status === 'pending' && (
        <div className="p-4 sm:p-5 bg-white">
          {error && (
            <div className="mb-3.5 p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-start space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          <div className="mb-2.5 flex items-center space-x-1.5 text-xs font-semibold text-slate-700">
            <Zap className="w-3.5 h-3.5 text-amber-600" />
            <span>Target Operation & Parameters</span>
          </div>
          <div className="bg-cream-50/70 rounded-xl border border-cream-200/80 p-3.5 space-y-2.5">
            <div className="flex items-center gap-3">
              <span className="text-xs text-slate-500 min-w-fit font-medium">Operation:</span>
              <span className="text-xs font-mono font-semibold text-heading bg-white px-2 py-0.5 rounded border border-cream-300/80">
                {actionData.action}
              </span>
            </div>
            {Object.entries(actionData.params).map(([key, val]) => (
              <div key={key} className="flex items-start gap-3">
                <span className="text-xs text-slate-500 pt-0.5 capitalize min-w-fit font-medium">{key}:</span>
                <span className="text-xs font-mono text-slate-700 bg-white px-2 py-0.5 rounded border border-cream-300/80 break-words flex-1">
                  {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Execution Result */}
      {status === 'approved' && executionResult && (() => {
        const toolStatus = resultStatus || executionResult?.status;

        if (toolStatus === 'executed') {
          return (
            <div className="p-4 sm:p-5 bg-white">
              <div className="flex items-center space-x-2 mb-3.5">
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
                <span className="text-xs font-semibold text-slate-800">{executionResult.message}</span>
              </div>

              {Array.isArray(emailsList) && emailsList.length > 0 ? (
                <div className="space-y-2.5">
                  <span className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Synced Inbox Highlights</span>
                  <div className="space-y-2.5 max-h-72 overflow-y-auto">
                    {emailsList.map((em: any, idx: number) => (
                      <div key={em.id || idx} className="p-3.5 bg-cream-50/80 rounded-xl border border-cream-200/80 hover:border-amber-400/40 transition-colors group cursor-default">
                        <div className="flex items-start justify-between mb-1.5 gap-2">
                          <h4 className="font-semibold text-heading text-xs line-clamp-1 pr-2">{em.subject}</h4>
                          <span className="text-[10px] text-slate-400 font-mono shrink-0 whitespace-nowrap">{em.date?.slice(0, 16)}</span>
                        </div>
                        <div className="text-xs text-slate-600 mb-1.5 font-medium">From: <span className="text-heading">{em.from}</span></div>
                        <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">{em.snippet}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="bg-heading rounded-xl overflow-hidden">
                  <div className="flex items-center px-3.5 py-1.5 border-b border-slate-700 bg-slate-900">
                    <span className="text-[10px] font-mono text-slate-400">Response Payload</span>
                  </div>
                  <pre className="p-3 text-[11px] font-mono text-emerald-400 overflow-x-auto">
                    {JSON.stringify(executionResult.data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        }

        if (toolStatus === 'simulated' || toolStatus === 'not_connected') {
          return (
            <div className="p-4 sm:p-5 bg-white border-t border-cream-200/80">
              <div className="p-3.5 bg-amber-50 rounded-xl border border-amber-200/80 flex items-start space-x-3">
                <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-xs font-semibold text-amber-900 mb-1">{actionData.tool.replace('-', ' ')} is not connected</h4>
                  <p className="text-xs text-amber-800/80 mb-2.5 leading-relaxed">
                    Authorize DareX AI to access this service to execute live actions.
                  </p>
                  <a
                    href="/connectors"
                    className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold rounded-lg transition-colors shadow-xs"
                  >
                    <span>Configure Integration</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </div>
          );
        }

        return (
          <div className="p-4 sm:p-5 bg-white border-t border-cream-200/80">
            <div className="p-3.5 bg-rose-50 rounded-xl border border-rose-200/80">
              <div className="flex items-center space-x-2 text-rose-700 font-semibold text-xs mb-1.5">
                <XCircle className="w-4 h-4" />
                <span>Execution Failed</span>
              </div>
              <p className="text-xs text-rose-600/90 mb-2.5">{executionResult.message}</p>
              {executionResult.data && (
                <pre className="bg-rose-950/5 text-rose-700 p-2.5 rounded-lg text-[10px] font-mono overflow-x-auto border border-rose-900/10">
                  {JSON.stringify(executionResult.data, null, 2)}
                </pre>
              )}
            </div>
          </div>
        );
      })()}

      {/* Action Buttons */}
      {status === 'pending' && (
        <div className="px-4 pb-4 pt-1 bg-white flex items-center space-x-2.5">
          <button
            type="button"
            onClick={handleApprove}
            className="flex-1 py-2 px-4 bg-amber-500 hover:bg-amber-600 active:bg-amber-700 text-heading font-bold text-xs rounded-xl flex items-center justify-center space-x-2 shadow-xs transition-all cursor-pointer"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Approve & Execute</span>
          </button>

          <button
            type="button"
            onClick={handleCancel}
            className="py-2 px-5 bg-white hover:bg-cream-100 border border-cream-300 text-slate-600 font-semibold text-xs rounded-xl transition-all cursor-pointer"
          >
            Decline
          </button>
        </div>
      )}
    </div>
  );
};
