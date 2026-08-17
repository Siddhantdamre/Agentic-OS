'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

type InviteStatus = 'loading' | 'preview' | 'error' | 'accepting' | 'expired' | 'accepted';

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params?.token || '';
  const [status, setStatus] = useState<InviteStatus>('loading');
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
        if (inviteRes.status === 410 || err.expired) {
          setStatus('expired');
        } else if (inviteRes.status === 409) {
          setStatus('accepted');
        } else {
          setStatus('error');
        }
        return;
      }
      const invite = await inviteRes.json();
      setOrgName(invite.orgName);
      setEmail(invite.email);
      setStatus('preview');
    }
    if (token) void load();
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
      if (res.status === 410 || err.expired) {
        setStatus('expired');
        return;
      }
      setStatus('error');
      return;
    }
    router.push('/');
  };

  return (
    <div className="space-y-5 text-center">
      <h1 className="text-xl font-bold text-emerald-50">Organization invite</h1>
      {status === 'loading' && <Loader2 className="w-6 h-6 animate-spin mx-auto text-[#F0C05A]" />}
      {status === 'error' && <p className="text-sm text-red-300">{message}</p>}
      {status === 'expired' && (
        <div className="space-y-2">
          <p className="text-sm text-red-300">{message || 'This invite has expired.'}</p>
          <p className="text-xs text-emerald-300/80">
            Ask an admin to send a new invite. An expired link cannot add you to an organization.
          </p>
        </div>
      )}
      {status === 'accepted' && (
        <p className="text-sm text-emerald-200/80">{message || 'This invite was already accepted.'}</p>
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
              onClick={() => void accept()}
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
