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
    <div className="my-4 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden transition-all duration-300 font-sans">
      {/* Top Header */}
      <div className="p-5 border-b border-slate-100 flex items-start justify-between bg-slate-50/50">
        <div className="flex items-start space-x-4">
          <div className="w-10 h-10 rounded-xl bg-white border border-slate-200 flex items-center justify-center shrink-0 shadow-sm">
            {getToolIcon(actionData.tool)}
          </div>
          <div className="space-y-1">
            <div className="flex items-center space-x-2">
              <h3 className="font-semibold text-slate-900 text-sm capitalize">
                {actionData.tool.replace('-', ' ')} Integration
              </h3>
              {status === 'pending' && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-100 text-amber-800 text-[10px] font-medium tracking-wide">
                  <ShieldAlert className="w-3 h-3 mr-1" />
                  Authorization Required
                </span>
              )}
            </div>
            <p className="text-xs text-slate-500 leading-relaxed max-w-lg">
              {actionData.explanation}
            </p>
          </div>
        </div>
        
        {/* Status Indicator */}
        <div className="flex shrink-0">
          {status === 'approved' && (
            <span className="inline-flex items-center space-x-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-100">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>Executed</span>
            </span>
          )}
          {status === 'executing' && (
            <span className="inline-flex items-center space-x-1.5 text-xs font-medium text-blue-600 bg-blue-50 px-2.5 py-1 rounded-lg border border-blue-100">
              <RefreshCw className="w-3.5 h-3.5 animate-spin" />
              <span>Processing</span>
            </span>
          )}
          {status === 'cancelled' && (
            <span className="inline-flex items-center space-x-1.5 text-xs font-medium text-slate-500 bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-200">
              <XCircle className="w-3.5 h-3.5" />
              <span>Cancelled</span>
            </span>
          )}
        </div>
      </div>

      {/* Action Parameters (Pending) */}
      {status === 'pending' && (
        <div className="p-5 bg-white">
          {error && (
            <div className="mb-3 p-3 bg-red-50 border border-red-200 rounded-xl text-xs text-red-700 flex items-start space-x-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
          <div className="mb-3 flex items-center space-x-2 text-xs font-medium text-slate-700">
            <Zap className="w-4 h-4 text-slate-400" />
            <span>Action Details</span>
          </div>
          <div className="bg-slate-50 rounded-xl border border-slate-100 p-4 space-y-3">
            <div className="flex items-center">
              <span className="text-xs text-slate-500 min-w-fit">Operation</span>
              <span className="text-xs font-mono font-medium text-slate-900 bg-white px-2 py-1 rounded border border-slate-200">
                {actionData.action}
              </span>
            </div>
            {Object.entries(actionData.params).map(([key, val]) => (
              <div key={key} className="flex items-start gap-4">
                <span className="text-xs text-slate-500 pt-1 capitalize min-w-fit">{key}</span>
                <span className="text-xs font-mono text-slate-700 bg-white px-2 py-1 rounded border border-slate-200 break-words flex-1">
                  {String(val)}
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
            <div className="p-5 bg-white">
              <div className="flex items-center space-x-2 mb-4">
                <ShieldCheck className="w-4 h-4 text-emerald-500" />
                <span className="text-sm font-medium text-slate-900">{executionResult.message}</span>
              </div>
              
              {Array.isArray(emailsList) && emailsList.length > 0 ? (
                <div className="space-y-3">
                  <span className="text-xs font-medium text-slate-500 uppercase tracking-wider">Synced Inbox Highlights</span>
                  <div className="space-y-3 max-h-72 overflow-y-auto">
                    {emailsList.map((em: any, idx: number) => (
                      <div key={em.id || idx} className="p-4 bg-slate-50 rounded-xl border border-slate-100 hover:border-slate-200 transition-colors group cursor-default">
                        <div className="flex items-start justify-between mb-2">
                          <h4 className="font-semibold text-slate-900 text-sm line-clamp-1 pr-4">{em.subject}</h4>
                          <span className="text-[10px] text-slate-400 font-mono shrink-0 whitespace-nowrap">{em.date?.slice(0, 16)}</span>
                        </div>
                        <div className="text-xs text-slate-600 mb-2 font-medium">From: <span className="text-slate-900">{em.from}</span></div>
                        <p className="text-xs text-slate-500 line-clamp-2 leading-relaxed">{em.snippet}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="bg-slate-900 rounded-xl overflow-hidden">
                  <div className="flex items-center px-4 py-2 border-b border-slate-800 bg-slate-950">
                    <span className="text-[10px] font-mono text-slate-400">Response Payload</span>
                  </div>
                  <pre className="p-4 text-[11px] font-mono text-emerald-400 overflow-x-auto">
                    {JSON.stringify(executionResult.data, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          );
        }

        if (toolStatus === 'simulated' || toolStatus === 'not_connected') {
          return (
            <div className="p-5 bg-white border-t border-slate-100">
              <div className="p-4 bg-amber-50 rounded-xl border border-amber-200/60 flex items-start space-x-3">
                <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
                <div>
                  <h4 className="text-sm font-semibold text-amber-900 mb-1">{actionData.tool.replace('-', ' ')} is not connected</h4>
                  <p className="text-xs text-amber-700/80 mb-3 leading-relaxed">
                    You need to authorize DareX AI to access this service before we can execute actions on your behalf.
                  </p>
                  <a
                    href="/connectors"
                    className="inline-flex items-center space-x-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium rounded-lg transition-colors shadow-sm"
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
          <div className="p-5 bg-white border-t border-slate-100">
            <div className="p-4 bg-red-50 rounded-xl border border-red-100">
              <div className="flex items-center space-x-2 text-red-700 font-semibold text-sm mb-2">
                <XCircle className="w-4 h-4" />
                <span>Execution Failed</span>
              </div>
              <p className="text-xs text-red-600/80 mb-3">{executionResult.message}</p>
              {executionResult.data && (
                <pre className="bg-red-950/5 text-red-700 p-3 rounded-lg text-[10px] font-mono overflow-x-auto border border-red-900/10">
                  {JSON.stringify(executionResult.data, null, 2)}
                </pre>
              )}
            </div>
          </div>
        );
      })()}

      {/* Action Buttons */}
      {status === 'pending' && (
        <div className="px-5 pb-5 pt-2 bg-white flex items-center space-x-3">
          <button
            onClick={handleApprove}
            className="flex-1 py-2.5 px-4 bg-slate-900 hover:bg-slate-800 text-white font-medium text-xs rounded-xl flex items-center justify-center space-x-2 shadow-sm transition-all focus:ring-2 focus:ring-slate-900/20 focus:outline-none"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Approve & Execute</span>
          </button>

          <button
            onClick={handleCancel}
            className="py-2.5 px-6 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 font-medium text-xs rounded-xl transition-all focus:ring-2 focus:ring-slate-200 focus:outline-none"
          >
            Deny
          </button>
        </div>
      )}
    </div>
  );
};
