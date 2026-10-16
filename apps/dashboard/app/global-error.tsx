'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'Georgia, serif', background: '#faf7f2', color: '#1c1917', margin: 0 }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontSize: 28, marginBottom: 8 }}>Something went wrong</h1>
            <p style={{ fontFamily: 'system-ui, sans-serif', fontSize: 14, color: '#57534e' }}>
              The app hit an unexpected error.
              {error.digest ? ` Reference ${error.digest}.` : ''}
            </p>
            <button
              type="button"
              onClick={() => reset()}
              style={{ marginTop: 20, padding: '8px 16px', fontWeight: 700, borderRadius: 8, border: 0, background: '#f59e0b', cursor: 'pointer' }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
