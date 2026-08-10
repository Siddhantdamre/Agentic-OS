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
  Inbox,
  Send,
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

  const getToolIcon = (tool: string) => {
    switch (tool.toLowerCase()) {
      case 'gmail': return <Mail className="w-5 h-5 text-blue-600" />;
      case 'google-calendar': return <Calendar className="w-5 h-5 text-sky-600" />;
      case 'whatsapp': return <MessageSquare className="w-5 h-5 text-emerald-600" />;
      case 'hubspot': return <Database className="w-5 h-5 text-amber-600" />;
      case 'meta-ads': case 'google-ads': return <BarChart2 className="w-5 h-5 text-purple-600" />;
      case 'stripe': case 'razorpay': return <CreditCard className="w-5 h-5 text-indigo-600" />;
      default: return <Zap className="w-5 h-5 text-amber-500" />;
    }
  };

  const handleApprove = async () => {
    try {
      setStatus('executing');
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
      }
    } catch (err) {
      console.error('Action approval execution failed:', err);
      setStatus('pending');
    }
  };

  const handleCancel = () => {
    setStatus('cancelled');
  };

  const emailsList = executionResult?.data?.emails;

  return (
    <div className="my-3 bg-white border-2 border-amber-500/30 rounded-3xl p-5 shadow-lg space-y-4 text-xs font-sans">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-cream-200 pb-3">
        <div className="flex items-center space-x-3">
          <div className="w-9 h-9 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0">
            {getToolIcon(actionData.tool)}
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-heading text-sm font-serif capitalize">
                {actionData.tool.replace('-', ' ')} Action Proposal
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-amber-500/20 text-amber-800 font-bold">
                REQUIRES PERMISSION
              </span>
            </div>
            <p className="text-[11px] text-slate-500">{actionData.explanation}</p>
          </div>
        </div>

        {/* Status Badge */}
        <span
          className={`text-[10px] font-bold uppercase tracking-wider px-3 py-1 rounded-full flex items-center space-x-1 ${
            status === 'pending'
              ? 'bg-amber-500/10 text-amber-700 border border-amber-500/20 animate-pulse'
              : status === 'approved'
              ? 'bg-emerald-500/10 text-emerald-700 border border-emerald-500/20'
              : status === 'executing'
              ? 'bg-blue-500/10 text-blue-700 border border-blue-500/20'
              : 'bg-slate-100 text-slate-500 border border-slate-200'
          }`}
        >
          {status === 'pending' && <ShieldAlert className="w-3.5 h-3.5 text-amber-600" />}
          {status === 'approved' && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
          {status === 'executing' && <RefreshCw className="w-3.5 h-3.5 text-blue-600 animate-spin" />}
          {status === 'cancelled' && <XCircle className="w-3.5 h-3.5 text-slate-400" />}
          <span>
            {status === 'pending'
              ? 'Pending User Approval'
              : status === 'approved'
              ? 'Approved & Executed'
              : status === 'executing'
              ? 'Executing Tool...'
              : 'Action Cancelled'}
          </span>
        </span>
      </div>

      {/* Action Parameters */}
      {status === 'pending' && (
        <div className="bg-cream-100/80 border border-cream-300 rounded-2xl p-3.5 space-y-2">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Action Payload Parameters</span>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <div>
              <span className="text-slate-500 block text-[10px]">Action Type:</span>
              <span className="font-mono text-heading font-semibold">{actionData.action}</span>
            </div>
            {Object.entries(actionData.params).map(([key, val]) => (
              <div key={key}>
                <span className="text-slate-500 block text-[10px] capitalize">{key}:</span>
                <span className="font-mono text-heading font-medium truncate block">{String(val)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Execution Result — rendered based on actual tool status */}
      {status === 'approved' && executionResult && (() => {
        const toolStatus = resultStatus || executionResult?.status;

        // ✅ Real execution success
        if (toolStatus === 'executed') {
          return (
            <div className="p-4 bg-emerald-500/10 border border-emerald-500/30 rounded-2xl space-y-3 text-emerald-950">
              <div className="flex items-center space-x-2 font-bold text-xs">
                <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                <span>{executionResult.message}</span>
              </div>
              {Array.isArray(emailsList) && emailsList.length > 0 ? (
                <div className="space-y-2 pt-1 border-t border-emerald-500/20">
                  <span className="text-[11px] font-bold text-emerald-900 block">📬 Synced Inbox Highlights:</span>
                  <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                    {emailsList.map((em: any, idx: number) => (
                      <div key={em.id || idx} className="p-3 bg-white/90 border border-emerald-500/20 rounded-xl space-y-1 text-[11px]">
                        <div className="flex items-center justify-between font-bold text-heading">
                          <span className="truncate max-w-[65%]">{em.subject}</span>
                          <span className="text-[10px] text-slate-400 font-mono font-normal">{em.date?.slice(0, 16)}</span>
                        </div>
                        <div className="text-emerald-700 font-medium text-[10px]">From: {em.from}</div>
                        <p className="text-slate-600 line-clamp-2 text-[10px]">{em.snippet}</p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <pre className="bg-slate-900 text-emerald-300 p-2.5 rounded-xl text-[10px] font-mono overflow-x-auto">
                  {JSON.stringify(executionResult.data, null, 2)}
                </pre>
              )}
            </div>
          );
        }

        // ⚠️ Not connected — guide user to /connectors
        if (toolStatus === 'simulated' || toolStatus === 'not_connected') {
          return (
            <div className="p-4 bg-amber-500/10 border border-amber-500/30 rounded-2xl space-y-2">
              <div className="flex items-center space-x-2 font-bold text-xs text-amber-800">
                <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
                <span>{actionData.tool.replace('-', ' ')} is not connected yet</span>
              </div>
              <p className="text-[11px] text-amber-700">
                Connect <strong>{actionData.tool}</strong> via OAuth to enable real execution.
              </p>
              <a
                href="/connectors"
                className="inline-flex items-center space-x-1 mt-1 px-3 py-1.5 bg-amber-500 hover:bg-amber-600 text-heading text-[11px] font-bold rounded-lg transition-colors"
              >
                <Zap className="w-3 h-3" />
                <span>Connect {actionData.tool} at /connectors</span>
              </a>
            </div>
          );
        }

        // ❌ API error
        return (
          <div className="p-4 bg-red-500/10 border border-red-500/30 rounded-2xl space-y-2">
            <div className="flex items-center space-x-2 font-bold text-xs text-red-800">
              <XCircle className="w-4 h-4 text-red-600 shrink-0" />
              <span>Tool Execution Error</span>
            </div>
            <p className="text-[11px] text-red-700">{executionResult.message}</p>
            {executionResult.data && (
              <pre className="bg-slate-900 text-red-300 p-2 rounded-xl text-[10px] font-mono overflow-x-auto">
                {JSON.stringify(executionResult.data, null, 2)}
              </pre>
            )}
          </div>
        );
      })()}

      {/* Action Decision Buttons */}
      {status === 'pending' && (
        <div className="flex items-center space-x-3 pt-1">
          <button
            onClick={handleApprove}
            className="flex-1 py-2.5 px-4 bg-amber-500 hover:bg-amber-600 text-heading font-bold text-xs rounded-xl flex items-center justify-center space-x-2 shadow-sm transition-all"
          >
            <Play className="w-3.5 h-3.5" />
            <span>Approve & Execute Action</span>
          </button>

          <button
            onClick={handleCancel}
            className="py-2.5 px-4 bg-cream-200 hover:bg-cream-300 text-slate-600 font-semibold text-xs rounded-xl transition-all"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};
