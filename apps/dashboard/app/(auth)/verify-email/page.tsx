'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';

function VerifyStatus() {
  const searchParams = useSearchParams();
  const token = searchParams?.get('token') || '';
  const [state, setState] = useState<'loading' | 'ok' | 'error'>(token ? 'loading' : 'error');
  const [message, setMessage] = useState(token ? '' : 'Missing verification token.');

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetch('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok) setState('ok');
        else {
          setState('error');
          setMessage(data.message || 'Could not verify email.');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setState('error');
        setMessage('Could not verify email.');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state === 'loading') return <Loader2 className="w-6 h-6 animate-spin mx-auto text-[#F0C05A]" />;
  if (state === 'ok') {
    return (
      <p className="text-sm text-emerald-100 text-center">
        Email verified. <Link href="/login" className="text-[#F0C05A]">Sign in</Link>.
      </p>
    );
  }
  return (
    <p className="text-sm text-red-300 text-center">
      {message} <Link href="/login" className="text-[#F0C05A]">Back to sign in</Link>.
    </p>
  );
}

export default function VerifyEmailPage() {
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-bold text-emerald-50 text-center">Verify your email</h1>
      <Suspense fallback={<Loader2 className="w-6 h-6 animate-spin mx-auto text-[#F0C05A]" />}>
        <VerifyStatus />
      </Suspense>
    </div>
  );
}
