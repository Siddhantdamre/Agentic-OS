import React from 'react';
import { Bot, ShieldCheck, Zap, Sparkles, MessageSquare, CheckCircle } from 'lucide-react';

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[#0C1311] text-[#FAF9F0] flex items-center justify-center p-4 md:p-8 relative overflow-hidden font-sans">
      {/* Background Glowing Gradient Orbs */}
      <div className="absolute -top-40 -left-40 w-96 h-96 bg-[#F0C05A]/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute -bottom-40 -right-40 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl pointer-events-none" />

      {/* Main Container */}
      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-center z-10">
        
        {/* Left Side: Brand Visual & Showcase (Hidden on Mobile) */}
        <div className="hidden lg:flex lg:col-span-5 flex-col justify-between space-y-8 pr-4">
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-[#F0C05A] text-[#121917] font-bold text-xl flex items-center justify-center shadow-lg shadow-[#F0C05A]/20">
                D
              </div>
              <span className="text-xl font-bold tracking-tight text-[#FAF9F0]">
                DareX<span className="text-[#F0C05A] font-mono text-xs ml-1">.ai</span>
              </span>
            </div>

            <h2 className="text-3xl font-extrabold leading-tight text-emerald-50">
              Build your AI-powered workforce.
            </h2>
            <p className="text-sm text-emerald-200/70 leading-relaxed">
              Multi-tenant autonomous AI employees with custom personas, durable memory, and cross-channel execution across WhatsApp, Email, CRM, and Ads.
            </p>
          </div>

          {/* Feature Showcase Cards */}
          <div className="space-y-3">
            {[
              {
                icon: Bot,
                title: 'Modular AI Employees',
                desc: 'Sales reps, support agents & marketing specialists in one platform.',
              },
              {
                icon: ShieldCheck,
                title: 'Multi-Tenant Security',
                desc: 'Row Level Security (RLS) data isolation per organization.',
              },
              {
                icon: Zap,
                title: 'Durable & Idempotent',
                desc: 'Temporal workflow execution — zero conversation context loss.',
              },
            ].map((item, idx) => (
              <div
                key={idx}
                className="p-3.5 rounded-2xl bg-[#16201D]/70 border border-emerald-900/50 backdrop-blur-md flex items-start gap-3.5 hover:border-[#F0C05A]/30 transition"
              >
                <div className="p-2 rounded-xl bg-emerald-950/80 text-[#F0C05A] border border-emerald-800/40 shrink-0">
                  <item.icon className="w-4 h-4" />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-emerald-100">{item.title}</h4>
                  <p className="text-[11px] text-emerald-300/60 leading-snug">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Footer Badge */}
          <div className="flex items-center gap-2 text-[11px] text-emerald-500 font-mono pt-2 border-t border-emerald-950">
            <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
            <span>Secure • Private to your business</span>
          </div>
        </div>

        {/* Right Side: Auth Form Container */}
        <div className="lg:col-span-7 flex justify-center">
          <div className="w-full max-w-md bg-[#16201D]/90 border border-emerald-900/70 rounded-3xl p-6 md:p-8 shadow-2xl backdrop-blur-2xl relative overflow-hidden">
            {/* Subtle Top Glowing Line */}
            <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-transparent via-[#F0C05A] to-transparent opacity-80" />
            {children}
          </div>
        </div>

      </div>
    </div>
  );
}
