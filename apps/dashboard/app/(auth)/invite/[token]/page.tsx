'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params?.token || '';
  const [status, setStatus] = useState<'loading' | 'preview' | 'error' | 'accepting'>('loading');
  const [message, setMessage] = useState('');
  const [orgName, setOrgName] = useState('');
  const [email, setEmail] = useState('');
  const [authenticated, setAuthenticated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [inviteRes, sessionRes] = await Promise.all([
        fetch(`/api/auth/invite/${token}`),
        fetch('/api/auth/session'),
      ]);
      if (cancelled) return;
      const session = await sessionRes.json().catch(() => ({ authenticated: false }));
      setAuthenticated(!!session.authenticated);
      if (!inviteRes.ok) {
        const err = await inviteRes.json().catch(() => ({ error: 'Invite not found' }));
        setMessage(err.error || 'Invite not found');
        setStatus('error');
        return;
      }
      const invite = await inviteRes.json();
      setOrgName(invite.orgName);
      setEmail(invite.email);
      setStatus('preview');
    }
    if (token) load();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const accept = async () => {
    setStatus('accepting');
    const res = await fetch(`/api/auth/invite/${token}`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Could not accept invite' }));
      setMessage(err.error || 'Could not accept invite');
      setStatus('error');
      return;
    }
    router.push('/');
  };

  return (
    <div className="space-y-5 text-center">
      <h1 className="text-xl font-bold text-emerald-50">Organization invite</h1>
      {status === 'loading' && <Loader2 className="w-6 h-6 animate-spin mx-auto text-[#F0C05A]" />}
      {status === 'error' && (
        <p className="text-sm text-red-300">{message}</p>
      )}
      {(status === 'preview' || status === 'accepting') && (
        <>
          <p className="text-sm text-emerald-200/80">
            You were invited to join <span className="font-semibold text-emerald-50">{orgName}</span>
            {email ? ` as ${email}` : ''}.
          </p>
          {authenticated ? (
            <button
              type="button"
              onClick={accept}
              disabled={status === 'accepting'}
              className="w-full py-3 bg-[#F0C05A] text-[#121917] font-bold text-xs rounded-2xl disabled:opacity-50"
            >
              {status === 'accepting' ? 'Joining…' : 'Accept invite'}
            </button>
          ) : (
            <div className="space-y-2 text-xs text-emerald-300">
              <Link
                href={`/register?invite=${encodeURIComponent(token)}`}
                className="block py-3 bg-[#F0C05A] text-[#121917] font-bold rounded-2xl"
              >
                Create account to join
              </Link>
              <Link href={`/login?invite=${encodeURIComponent(token)}`} className="block text-[#F0C05A] font-bold">
                Already have an account? Sign in
              </Link>
            </div>
          )}
        </>
      )}
    </div>
  );
}
