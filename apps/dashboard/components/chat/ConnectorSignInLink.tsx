'use client';

import React, { useState } from 'react';
import {
  canStartOAuthInline,
  connectorSignInPath,
  providerIdForTool,
  providerIdFromConnectHref,
} from '@/lib/integrations-catalog';
import { startRealNangoOAuth } from '@/lib/nango-client';

/**
 * Opens the Nango sign-in for one connector account.
 * API-key and extra-field accounts follow the link so the connectors page
 * can show their form. A plain click on an OAuth account starts the popup here.
 */
export function ConnectorSignInControl({
  tool,
  href,
  className,
  idleLabel = 'Sign in to use this tool',
}: {
  tool?: string;
  href?: string;
  className?: string;
  idleLabel?: string;
}) {
  const provider = (tool && providerIdForTool(tool)) || (href ? providerIdFromConnectHref(href) : null);
  const [phase, setPhase] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [note, setNote] = useState('');

  if (!provider && !href) return null;

  const target = provider ? connectorSignInPath(provider) : href || '/connectors';
  const inline = Boolean(provider && canStartOAuthInline(provider));

  const onClick = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (!inline || !provider) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    if (phase === 'working' || phase === 'done') {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    setPhase('working');
    setNote('');
    const result = await startRealNangoOAuth(provider);
    if (result.success) {
      setPhase('done');
      setNote('Signed in. Send the question again to use this account.');
      return;
    }
    setPhase('error');
    setNote(result.error || 'Sign-in did not finish.');
  };

  const label = phase === 'working' ? 'Opening sign-in…' : phase === 'done' ? 'Signed in' : idleLabel;

  return (
    <>
      <a href={target} onClick={(event) => void onClick(event)} className={className}>
        {label}
      </a>
      {note ? <span className="mt-1 block text-[11px] text-slate-600">{note}</span> : null}
    </>
  );
}
