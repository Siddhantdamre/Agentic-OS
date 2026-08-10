'use client';

import React, { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Sparkles, MessageSquare, Clock, AlertTriangle, CheckCircle2, ArrowUpRight, Send, RefreshCw } from 'lucide-react';

export const dynamic = 'force-dynamic';

function HomeContent() {
  const searchParams = useSearchParams();
  const [isWarmup, setIsWarmup] = useState(searchParams?.get('warmup') === 'true');
  const [provisionProgress, setProvisionProgress] = useState(35);
  const [askQuery, setAskQuery] = useState('');
  
  const [stats, setStats] = useState<any>(null);
  const [needsAttention, setNeedsAttention] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Simulate warm-up state progress polling
  useEffect(() => {
    if (isWarmup) {
      const timer = setInterval(() => {
        setProvisionProgress((prev) => {
          if (prev >= 100) {
            clearInterval(timer);
            setIsWarmup(false);
            return 100;
          }
          return prev + 25;
        });
      }, 2500);
      return () => clearInterval(timer);
    }
  }, [isWarmup]);

  useEffect(() => {
    fetch('/api/dashboard/stats')
      .then(res => res.json())
      .then(data => {
        setStats(data);
        setLoading(false);
      })
      .catch(err => {
        console.error(err);
        setLoading(false);
      });

    fetch('/api/conversations?status=needs_attention')
      .then(res => res.json())
      .then(data => {
        setNeedsAttention(data.conversations || []);
      })
      .catch(err => console.error(err));
  }, []);

  if (loading) {
    return <div className="p-8 text-center text-slate-500 font-serif">Loading snapshot...</div>;
  }

  const firstName = stats?.userEmail ? stats.userEmail.split('@')[0].charAt(0).toUpperCase() + stats.userEmail.split('@')[0].slice(1) : 'Owner';

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      {/* Top Welcome Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold text-heading">
            Good Morning, {firstName}
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            Here is your daily snapshot across your AI employees and connected channels.
          </p>
        </div>
      </div>

      {/* Warm-Up State Card (when onboarding just submitted) */}
      {isWarmup ? (
        <div className="bg-white border-2 border-amber-500/30 rounded-3xl p-8 shadow-lg relative overflow-hidden">
          <div className="flex items-start space-x-5">
            <div className="p-4 bg-amber-500/20 rounded-2xl shrink-0">
              <Sparkles className="w-8 h-8 text-amber-600 animate-spin" />
            </div>
            <div className="space-y-3 flex-1">
              <div className="flex items-center justify-between">
                <h2 className="text-xl font-serif font-bold text-heading">
                  Your business is coming online...
                </h2>
                <span className="text-sm font-bold text-amber-600 bg-amber-500/10 px-3 py-1 rounded-full">
                  {provisionProgress}% Complete
                </span>
              </div>
              <p className="text-slate-600 text-sm">
                Provisioning AI employee roster (Sarah, Emma, Marcus), establishing Nango OAuth connectors, and setting up Chatwoot channel webhooks.
              </p>

              {/* Progress bar */}
              <div className="w-full bg-cream-200 h-3 rounded-full overflow-hidden">
                <div
                  className="bg-amber-500 h-full transition-all duration-700 ease-out"
                  style={{ width: `${provisionProgress}%` }}
                />
              </div>

              {/* Live steps checklist */}
              <div className="grid grid-cols-3 gap-4 pt-2 text-xs font-medium text-slate-600">
                <div className="flex items-center space-x-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                  <span>AI Employees Created</span>
                </div>
                <div className="flex items-center space-x-2">
                  <CheckCircle2 className={`w-4 h-4 ${provisionProgress >= 50 ? 'text-emerald-500' : 'text-slate-300'}`} />
                  <span>Nango Credentials Isolated</span>
                </div>
                <div className="flex items-center space-x-2">
                  <CheckCircle2 className={`w-4 h-4 ${provisionProgress >= 100 ? 'text-emerald-500' : 'text-slate-300'}`} />
                  <span>Channels Connected</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* Main Grid Layout */}
      <div className="grid grid-cols-12 gap-8">
        {/* Left 8 Cols — Snapshot & Cards */}
        <div className="col-span-8 space-y-8">
          {/* Today's Snapshot 4-Stat Grid */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Conversations</span>
              <div className="text-3xl font-bold text-heading">{stats?.conversationCount || 0}</div>
              <span className="text-xs text-emerald-600 font-medium">{stats?.conversationChangePct || '↑ +18%'} from yesterday</span>
            </div>

            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Avg Response</span>
              <div className="text-3xl font-bold text-heading">{stats?.avgResponseMs ? (stats.avgResponseMs / 1000).toFixed(1) + 's' : 'N/A'}</div>
              <span className="text-xs text-emerald-600 font-medium">{stats?.aiAutomationRate ? stats.aiAutomationRate + '% AI automated' : 'AI powered'}</span>
            </div>

            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Needs Attention</span>
              <div className="text-3xl font-bold text-amber-600">{stats?.needsAttentionCount || 0}</div>
              <span className="text-xs text-amber-600 font-medium">Human review queued</span>
            </div>

            <div className="bg-cream-200/70 border border-cream-300 p-5 rounded-2xl space-y-2 shadow-sm">
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Channels Connected</span>
              <div className="text-3xl font-bold text-heading">{stats?.channelCount || 0}</div>
              <span className="text-xs text-emerald-600 font-medium">Active channels</span>
            </div>
          </div>

          {/* AI Employees Roster Preview */}
          <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-4 shadow-sm">
            <h2 className="text-lg font-serif font-bold text-heading">Active AI Employee Roster</h2>
            
            {stats?.aiEmployees && stats.aiEmployees.length > 0 ? (
              <div className="grid grid-cols-3 gap-4">
                {stats.aiEmployees.map((emp: any) => (
                  <div key={emp.id} className="p-4 rounded-2xl bg-cream-100 border border-cream-300 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-heading">{emp.name}</span>
                      <span className="text-xs font-semibold px-2.5 py-0.5 bg-amber-500/20 text-amber-700 rounded-full">{emp.role}</span>
                    </div>
                    <p className="text-xs text-slate-500">{emp.description || 'No description'}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-8 text-center bg-cream-50 border border-dashed border-cream-300 rounded-2xl">
                <p className="text-slate-500">No AI employees configured yet — set them up in the Employees section</p>
              </div>
            )}
          </div>
        </div>

        {/* Right 4 Cols — Needs Attention Queue & Activity Feed */}
        <div className="col-span-4 space-y-8">
          {/* Needs Your Attention Stack */}
          <div className="bg-white border border-cream-300 rounded-3xl p-6 space-y-4 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-serif font-bold text-heading">Needs Attention</h2>
              <span className="w-6 h-6 rounded-full bg-amber-500 text-heading text-xs font-bold flex items-center justify-center">{needsAttention.length}</span>
            </div>

            <div className="space-y-3">
              {needsAttention.length > 0 ? (
                needsAttention.map((conv: any) => (
                  <div key={conv.id} className="p-3.5 bg-amber-500/10 border border-amber-500/30 rounded-2xl space-y-1">
                    <div className="flex items-center justify-between text-xs font-semibold text-amber-700">
                      <span className="flex items-center space-x-1">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span>{conv.subject || 'Needs Review'}</span>
                      </span>
                      <span className="capitalize">{conv.channel || 'System'}</span>
                    </div>
                    <p className="text-xs text-slate-700">{conv.snippet || 'This conversation requires human review.'}</p>
                  </div>
                ))
              ) : (
                <div className="p-4 text-center bg-cream-50 border border-dashed border-cream-300 rounded-2xl text-slate-500 text-sm">
                  No conversations need attention.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom "Ask Anything" Chat Bar */}
      <div className="bg-white border border-cream-300 rounded-3xl p-4 shadow-lg flex items-center space-x-4">
        <Sparkles className="w-6 h-6 text-amber-600 shrink-0 ml-2" />
        <input
          type="text"
          value={askQuery}
          onChange={(e) => setAskQuery(e.target.value)}
          placeholder="Ask your business anything (e.g., 'Which channels brought in the most leads this week?')"
          className="flex-1 bg-transparent border-none focus:outline-none text-heading font-medium placeholder:text-slate-400"
        />
        <button
          onClick={() => {
            if (askQuery.trim()) {
              window.location.href = '/ask-ai?q=' + encodeURIComponent(askQuery);
            }
          }}
          className="p-3 bg-amber-500 hover:bg-amber-600 text-heading rounded-2xl transition-colors shadow-sm"
        >
          <Send className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-slate-500 font-serif">Loading snapshot...</div>}>
      <HomeContent />
    </Suspense>
  );
}
