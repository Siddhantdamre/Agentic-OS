'use client';

import React, { useState, useEffect, Suspense } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Lock, Mail, ArrowRight, Eye, EyeOff, Sparkles, Loader2 } from 'lucide-react';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [ssoProviders, setSsoProviders] = useState<
    Array<{ id: string; name: string; configured: boolean }>
  >([]);

  // Read error from OAuth/SSO redirect (e.g. ?error=OAuth+denied)
  useEffect(() => {
    const oauthError = searchParams?.get('error');
    if (oauthError) {
      setError(decodeURIComponent(oauthError));
    }
  }, [searchParams]);

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/auth/sso')
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { providers?: Array<{ id: string; name: string; configured: boolean }> } | null) => {
        if (cancelled || !json?.providers) return;
        setSsoProviders(json.providers.filter((p) => p.configured));
      })
      .catch(() => {
        // Password login still works when the SSO catalog is unavailable.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          rememberMe,
          inviteToken: searchParams?.get('invite') || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok || data.status !== 'OK') {
        throw new Error(data.message || 'Login failed. Please check your credentials.');
      }

      const redirectTo = searchParams?.get('redirect');
      if (!data.onboardingComplete) {
        router.push('/onboarding/name');
      } else {
        router.push(redirectTo && redirectTo.startsWith('/') ? redirectTo : '/');
      }
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  // OAuth Login Handler — redirects to provider authorization URL
  const handleOAuthLogin = (provider: string) => {
    setOauthLoading(provider);
    setError('');
    const invite = searchParams?.get('invite');
    const qs = invite ? `?invite=${encodeURIComponent(invite)}` : '';
    window.location.href = `/api/auth/oauth/${provider}${qs}`;
  };

  const handleSsoLogin = (provider: string) => {
    setOauthLoading(`sso:${provider}`);
    setError('');
    const invite = searchParams?.get('invite');
    const qs = invite ? `?invite=${encodeURIComponent(invite)}` : '';
    window.location.href = `/api/auth/sso/${provider}${qs}`;
  };

  const demoEmail = process.env.NEXT_PUBLIC_DEMO_EMAIL;
  const demoPassword = process.env.NEXT_PUBLIC_DEMO_PASSWORD;

  const handleFillDemo = () => {
    if (!demoEmail || !demoPassword) return;
    setEmail(demoEmail);
    setPassword(demoPassword);
    setError('');
  };

  return (
    <div className="space-y-5">
      {/* Brand Header */}
      <div className="text-center space-y-1.5">
        <div className="w-12 h-12 rounded-2xl bg-[#F0C05A] text-[#121917] flex items-center justify-center mx-auto shadow-lg shadow-[#F0C05A]/20 font-bold text-2xl font-mono">
          D
        </div>
        <h1 className="text-2xl font-bold text-emerald-50">
          Welcome back to DareX<span className="text-[#F0C05A] font-mono text-xs ml-1">.ai</span>
        </h1>
        <p className="text-xs text-emerald-300/70">
          Sign in to supervise your autonomous AI employee workforce.
        </p>
      </div>

      {/* Demo Credentials Quick Fill Banner (only when NEXT_PUBLIC_DEMO_* env is set) */}
      {demoEmail && demoPassword && (
        <div className="p-3 rounded-2xl bg-[#1D2925] border border-emerald-800/40 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2 text-emerald-300">
            <Sparkles className="w-4 h-4 text-[#F0C05A]" />
            <span>Quick Demo Access</span>
          </div>
          <button
            type="button"
            onClick={handleFillDemo}
            className="text-[11px] font-bold text-[#F0C05A] hover:underline px-2.5 py-1 rounded-lg bg-[#F0C05A]/10 border border-[#F0C05A]/30 transition"
          >
            Auto-fill Demo
          </button>
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-950/60 border border-red-800/60 text-red-300 rounded-2xl text-xs font-medium text-center">
          {error}
        </div>
      )}

      {ssoProviders.length > 0 && (
        <div className="space-y-2">
          {ssoProviders.map((p) => (
            <button
              key={p.id}
              type="button"
              id={`login-sso-${p.id}-btn`}
              onClick={() => handleSsoLogin(p.id)}
              disabled={!!oauthLoading || loading}
              className="w-full flex items-center justify-center gap-2.5 py-2.5 px-3 bg-[#1C2825] hover:bg-[#23322E] border border-emerald-900/80 rounded-xl text-xs text-emerald-100 font-semibold transition shadow-sm hover:border-emerald-700 disabled:opacity-50"
            >
              {oauthLoading === `sso:${p.id}` ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : null}
              <span>
                {oauthLoading === `sso:${p.id}` ? 'Redirecting...' : `Continue with ${p.name}`}
              </span>
            </button>
          ))}
          <p className="text-[10px] text-emerald-600 text-center">
            SSO is optional. Email and password still work.
          </p>
        </div>
      )}

      {/* Social OAuth Provider Buttons */}
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-2">
          {/* Google OAuth */}
          <button
            type="button"
            id="login-google-btn"
            onClick={() => handleOAuthLogin('google')}
            disabled={!!oauthLoading || loading}
            className="flex items-center justify-center gap-2.5 py-2.5 px-3 bg-[#1C2825] hover:bg-[#23322E] border border-emerald-900/80 rounded-xl text-xs text-emerald-100 font-semibold transition shadow-sm hover:border-emerald-700 disabled:opacity-50"
          >
            {oauthLoading === 'google' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
              </svg>
            )}
            <span>{oauthLoading === 'google' ? 'Redirecting...' : 'Google'}</span>
          </button>

          {/* GitHub OAuth */}
          <button
            type="button"
            id="login-github-btn"
            onClick={() => handleOAuthLogin('github')}
            disabled={!!oauthLoading || loading}
            className="flex items-center justify-center gap-2.5 py-2.5 px-3 bg-[#1C2825] hover:bg-[#23322E] border border-emerald-900/80 rounded-xl text-xs text-emerald-100 font-semibold transition shadow-sm hover:border-emerald-700 disabled:opacity-50"
          >
            {oauthLoading === 'github' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <svg className="w-4 h-4 fill-current text-white" viewBox="0 0 24 24">
                <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
              </svg>
            )}
            <span>{oauthLoading === 'github' ? 'Redirecting...' : 'GitHub'}</span>
          </button>

          {/* Meta / Facebook OAuth */}
          <button
            type="button"
            id="login-meta-btn"
            onClick={() => handleOAuthLogin('facebook')}
            disabled={!!oauthLoading || loading}
            className="flex items-center justify-center gap-2.5 py-2.5 px-3 bg-[#1C2825] hover:bg-[#23322E] border border-emerald-900/80 rounded-xl text-xs text-emerald-100 font-semibold transition shadow-sm hover:border-emerald-700 disabled:opacity-50"
          >
            {oauthLoading === 'facebook' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <svg className="w-4 h-4 text-blue-500 fill-current" viewBox="0 0 24 24">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
            )}
            <span>{oauthLoading === 'facebook' ? 'Redirecting...' : 'Meta'}</span>
          </button>

          {/* Microsoft OAuth */}
          <button
            type="button"
            id="login-microsoft-btn"
            onClick={() => handleOAuthLogin('microsoft')}
            disabled={!!oauthLoading || loading}
            className="flex items-center justify-center gap-2.5 py-2.5 px-3 bg-[#1C2825] hover:bg-[#23322E] border border-emerald-900/80 rounded-xl text-xs text-emerald-100 font-semibold transition shadow-sm hover:border-emerald-700 disabled:opacity-50"
          >
            {oauthLoading === 'microsoft' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <svg className="w-4 h-4" viewBox="0 0 23 23">
                <path fill="#f35325" d="M1 1h10v10H1z" />
                <path fill="#81bc06" d="M12 1h10v10H12z" />
                <path fill="#05a6f0" d="M1 12h10v10H1z" />
                <path fill="#ffba08" d="M12 12h10v10H12z" />
              </svg>
            )}
            <span>{oauthLoading === 'microsoft' ? 'Redirecting...' : 'Microsoft'}</span>
          </button>
        </div>

        <div className="relative flex py-1 items-center">
          <div className="flex-grow border-t border-emerald-950"></div>
          <span className="flex-shrink mx-3 text-[10px] text-emerald-600 font-semibold uppercase">
            Or sign in with email
          </span>
          <div className="flex-grow border-t border-emerald-950"></div>
        </div>
      </div>

      <form onSubmit={handleLogin} className="space-y-3.5">
        {/* Email Input */}
        <div>
          <label className="block text-xs font-semibold text-emerald-300 mb-1">
            Work Email Address
          </label>
          <div className="relative">
            <Mail className="w-4 h-4 text-emerald-500 absolute left-3.5 top-3.5" />
            <input
              id="login-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@yourcompany.com"
              required
              autoComplete="email"
              className="w-full pl-10 pr-4 py-2.5 bg-[#1C2825] border border-emerald-900/80 rounded-2xl text-xs text-emerald-100 placeholder-emerald-600 focus:border-[#F0C05A] focus:outline-none transition"
            />
          </div>
        </div>

        {/* Password Input */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-semibold text-emerald-300">Password</label>
            <Link
              href="/forgot-password"
              className="text-[11px] text-[#F0C05A] hover:underline"
            >
              Forgot password?
            </Link>
          </div>
          <div className="relative">
            <Lock className="w-4 h-4 text-emerald-500 absolute left-3.5 top-3.5" />
            <input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              required
              autoComplete="current-password"
              className="w-full pl-10 pr-10 py-2.5 bg-[#1C2825] border border-emerald-900/80 rounded-2xl text-xs text-emerald-100 placeholder-emerald-600 focus:border-[#F0C05A] focus:outline-none transition"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-3 text-emerald-500 hover:text-emerald-300 transition"
              title={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Remember Me */}
        <div className="flex items-center pt-0.5">
          <label className="flex items-center gap-2 cursor-pointer text-xs text-emerald-300/80">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(e) => setRememberMe(e.target.checked)}
              className="rounded bg-[#1C2825] border-emerald-800 text-[#F0C05A] focus:ring-0"
            />
            <span>Remember this device</span>
          </label>
        </div>

        {/* Submit Button */}
        <button
          id="login-submit-btn"
          type="submit"
          disabled={loading || !!oauthLoading}
          className="w-full py-3.5 px-6 bg-[#F0C05A] hover:bg-[#e0b04a] text-[#121917] font-bold text-xs rounded-2xl flex items-center justify-center space-x-2 transition-all shadow-lg shadow-[#F0C05A]/10 hover:shadow-xl disabled:opacity-50"
        >
          {loading ? (
            <span className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Signing in...
            </span>
          ) : (
            <>
              <span>Sign In to Workspace</span>
              <ArrowRight className="w-4 h-4" />
            </>
          )}
        </button>
      </form>

      {/* Footer Navigation */}
      <div className="text-center pt-2 border-t border-emerald-950/80 text-xs text-emerald-400/70">
        Don&apos;t have an organization account yet?{' '}
        <Link href="/register" className="text-[#F0C05A] font-bold hover:underline">
          Create new account
        </Link>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-[#F0C05A]" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
