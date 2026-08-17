'use client';

import React, { useState } from 'react';
import { Zap, Play, CheckCircle2, AlertCircle, RefreshCw, Mail, Calendar, MessageSquare, Database, BarChart3 } from 'lucide-react';

interface ToolActionResult {
  tool: string;
  action: string;
  status: 'executed' | 'simulated' | 'error';
  message: string;
  data: any;
  timestamp: string;
}

export const AutonomousActionConsole: React.FC = () => {
  const [selectedTool, setSelectedTool] = useState('gmail');
  const [actionInput, setActionInput] = useState('');
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<ToolActionResult[]>([]);

  // Each connector validates its own required fields before checking OAuth
  // connection, so the demo payload must satisfy them or every quick-trigger
  // fails with a field-validation error instead of a "not connected" result.
  const demoPayload = (tool: string, input: string): Record<string, any> => {
    switch (tool) {
      case 'gmail':
        return {
          query: input,
          to: 'lead@company.com',
          recipient: 'lead@company.com',
          subject: 'Following up on our conversation',
          body: input,
        };
      case 'google-calendar':
        return {
          query: input,
          summary: 'Sales Strategy Demo Call',
          startTime: new Date(Date.now() + 24 * 3600000).toISOString(),
        };
      case 'hubspot':
        return {
          query: input,
          email: 'lead@company.com',
          firstname: 'Demo',
          lastname: 'Lead',
        };
      default:
        return { query: input, recipient: 'lead@company.com', summary: 'Sales Strategy Demo Call' };
    }
  };

  const handleRunAction = async (toolName?: string, customInput?: string) => {
    const targetTool = toolName || selectedTool;
    const input = customInput || actionInput;

    try {
      setExecuting(true);
      setError(null);
      const res = await fetch('/api/agent/tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: targetTool,
          action: 'autonomous_execute',
          payload: demoPayload(targetTool, input),
        }),
      });

      const data = await res.json();
      if (data.success && data.result) {
        setLogs((prev) => [data.result, ...prev]);
        setActionInput('');
      } else {
        setError(data.error || 'Failed to run autonomous action');
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to run autonomous action');
    } finally {
      setExecuting(false);
    }
  };

  const getToolIcon = (tool: string) => {
    switch (tool.toLowerCase()) {
      case 'gmail': return <Mail className="w-4 h-4 text-blue-400" />;
      case 'google-calendar': return <Calendar className="w-4 h-4 text-emerald-400" />;
      case 'whatsapp': return <MessageSquare className="w-4 h-4 text-emerald-500" />;
      case 'hubspot': return <Database className="w-4 h-4 text-amber-500" />;
      case 'meta-ads': return <BarChart3 className="w-4 h-4 text-purple-400" />;
      default: return <Zap className="w-4 h-4 text-amber-400" />;
    }
  };

  return (
    <div className="bg-white border border-cream-300 rounded-3xl p-6 shadow-sm space-y-6">
      <div className="flex items-center justify-between border-b border-cream-200 pb-4">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/20 flex items-center justify-center border border-amber-500/30">
            <Zap className="w-5 h-5 text-amber-600 animate-pulse" />
          </div>
          <div>
            <h2 className="text-lg font-serif font-bold text-heading">Autonomous Tool Action Console</h2>
            <p className="text-xs text-slate-500">Test & trigger real autonomous agent side-effects (Gmail, Calendar, CRM)</p>
          </div>
        </div>

        <span className="text-[11px] font-bold uppercase tracking-wider px-3 py-1 bg-emerald-500/10 text-emerald-700 rounded-full border border-emerald-500/20 flex items-center space-x-1">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
          <span>Active Engine</span>
        </span>
      </div>

      {/* Quick Trigger Buttons */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { id: 'gmail', label: 'Dispatch Gmail Follow-Up', icon: Mail },
          { id: 'google-calendar', label: 'Book Google Calendar Demo', icon: Calendar },
          { id: 'hubspot', label: 'Log Contact in HubSpot CRM', icon: Database },
          { id: 'meta-ads', label: 'Fetch Meta Ads Insights', icon: BarChart3 },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => handleRunAction(item.id, `Triggered ${item.label}`)}
              disabled={executing}
              className="p-3 bg-cream-100 hover:bg-amber-500/10 border border-cream-300 hover:border-amber-500/40 rounded-2xl text-left transition-all group disabled:opacity-50 space-y-2"
            >
              <div className="flex items-center justify-between">
                <Icon className="w-4 h-4 text-amber-600" />
                <Play className="w-3 h-3 text-slate-400 group-hover:text-amber-600 transition-colors" />
              </div>
              <span className="text-xs font-bold text-slate-700 block line-clamp-1">{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Error Display */}
      {error && (
        <div className="p-3.5 bg-red-50 border border-red-200 rounded-2xl text-xs text-red-700 flex items-start space-x-2">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Action Logs Feed */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Live Action Execution Stream</h3>
        {logs.length === 0 ? (
          <div className="p-6 text-center text-xs text-slate-400 bg-cream-50 border border-dashed border-cream-300 rounded-2xl">
            Click any action button above to trigger live autonomous tool execution!
          </div>
        ) : (
          <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
            {logs.map((log, idx) => (
              <div
                key={idx}
                className="p-3.5 bg-cream-100/70 border border-cream-300 rounded-2xl space-y-1.5 text-xs transition-all hover:bg-cream-100"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    {getToolIcon(log.tool)}
                    <span className="font-bold text-heading uppercase tracking-wider text-[11px]">{log.tool}</span>
                    <span className="text-slate-400">•</span>
                    <span className="text-emerald-700 font-semibold text-[11px]">{log.action}</span>
                  </div>
                  <span className="text-[10px] text-slate-400 font-mono">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </span>
                </div>

                <p className="text-slate-700 font-medium">{log.message}</p>

                <pre className="bg-slate-900 text-emerald-300 p-2 rounded-xl text-[10px] font-mono overflow-x-auto">
                  {JSON.stringify(log.data, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
