/**
 * @jest-environment node
 *
 * A caught exception's text is written for developers. Sent to a customer it can carry a database host and
 * port, a constraint or table name, a missing-setting name, or a stack frame: 34 routes did exactly that in
 * their 500 answers. publicErrorMessage keeps what a person can act on (a provider saying "Invalid OAuth
 * access token", our own "Billing is not configured") and replaces what only helps an attacker.
 */
import { DEFAULT_PUBLIC_ERROR, publicErrorMessage } from '@/lib/public-error';

function pgError(message: string, code = '23505') {
  return Object.assign(new Error(message), { code, severity: 'ERROR', routine: 'ExecConstraints' });
}
function sysError(message: string, code: string) {
  return Object.assign(new Error(message), { code, errno: -111, syscall: 'connect' });
}

describe('publicErrorMessage — keeps what a person can act on', () => {
  it.each([
    'Invalid OAuth access token',
    'Razorpay keyId and keySecret are required',
    'Billing is not configured for this workspace',
    'Phone number is not registered with this WhatsApp business account',
  ])('passes %p through', (msg) => {
    expect(publicErrorMessage(new Error(msg))).toBe(msg);
  });

  it('accepts a plain string', () => {
    expect(publicErrorMessage('Provider said no')).toBe('Provider said no');
  });

  it('uses the caller fallback only when there is nothing to show', () => {
    expect(publicErrorMessage(new Error(''), 'Failed to create organization')).toBe('Failed to create organization');
    expect(publicErrorMessage(undefined, 'Nango error')).toBe('Nango error');
    expect(publicErrorMessage(null)).toBe(DEFAULT_PUBLIC_ERROR);
  });

  it('caps a very long message', () => {
    expect(publicErrorMessage(new Error('x'.repeat(5000))).length).toBeLessThanOrEqual(300);
  });
});

describe('publicErrorMessage — replaces what only helps an attacker', () => {
  it.each([
    ['a Postgres error object', pgError('duplicate key value violates unique constraint "uq_employee_autonomy_rules_action"')],
    ['a Postgres missing relation', new Error('relation "org_backfill_jobs" does not exist')],
    ['a Postgres column error', new Error('column "secret_hash" of relation "users" does not exist')],
    ['a Postgres constraint', new Error('new row for relation "orgs" violates check constraint "orgs_status_check"')],
    ['a refused connection', sysError('connect ECONNREFUSED 10.0.4.7:5432', 'ECONNREFUSED')],
    ['a DNS failure', new Error('getaddrinfo ENOTFOUND langfuse-server')],
    ['a timeout', new Error('connect ETIMEDOUT 172.18.0.5:7233')],
    ['a connection string', new Error('could not connect to postgres://darex:hunter2@db:5432/darex')],
    ['a password failure', new Error('password authentication failed for user "darex_app"')],
    ['a missing setting', new Error('LANGFUSE_HOST, LANGFUSE_PUBLIC_KEY, and LANGFUSE_SECRET_KEY must be set in production')],
    ['a missing token setting', new Error('NANGO_SECRET_KEY is not set')],
    ['a stack frame', new Error('boom\n    at Object.<anonymous> (/app/apps/dashboard/lib/db.ts:42:11)')],
    ['a file path', new Error('ENOENT: no such file or directory, open /app/node_modules/x/y.json')],
    ['SQLSTATE text', new Error('SQLSTATE 42P01 while running statement')],
  ])('hides %s', (_name, err) => {
    expect(publicErrorMessage(err)).toBe(DEFAULT_PUBLIC_ERROR);
  });

  it('uses the caller fallback instead of the default when one is given', () => {
    expect(publicErrorMessage(new Error('relation "x" does not exist'), 'Failed to create organization')).toBe(
      'Failed to create organization'
    );
  });

  it('never returns the internal text in any form', () => {
    const out = publicErrorMessage(pgError('relation "orgs" does not exist'));
    expect(out).not.toMatch(/orgs|relation|23505/);
  });
});
