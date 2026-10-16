import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';
import { assertPublicUrl, checkPublicUrl, isBlockedAddress, safeGet, UnsafeUrlError } from './safe-url.js';

test('blocks private, reserved and mapped addresses', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', '2002:7f00:1::',
  ]) assert.equal(isBlockedAddress(address), true, address);
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test('rejects non-canonical IP literals, internal names and credentials', () => {
  for (const url of [
    'http://0x7f.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://127.0.0.%31/',
    'http://[::ffff:127.0.0.1]/', 'http://[0:0::1]/', 'http://169.254.169.254/latest/meta-data/',
    'http://localhost:3000/', 'http://api.localhost/', 'http://postgres:5432/', 'http://metadata.google.internal/',
    'http://printer.local/', 'http://user:pw@example.com/', 'file:///etc/passwd', 'gopher://example.com/',
  ]) assert.throws(() => checkPublicUrl(url), UnsafeUrlError, url);
  assert.equal(checkPublicUrl('https://example.com/a?b=1').hostname, 'example.com');
  assert.equal(checkPublicUrl('http://93.184.216.34/').hostname, '93.184.216.34');
});

test('rejects a public-looking name that resolves to a private address', async () => {
  const rebinding = async () => [{ address: '203.0.113.9', family: 4 }, { address: '10.0.0.5', family: 4 }];
  await assert.rejects(assertPublicUrl('https://evil.example.com/', rebinding), UnsafeUrlError);
  const publicOnly = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.equal((await assertPublicUrl('https://example.com/', publicOnly)).hostname, 'example.com');
});

// A local server stands in for "the public internet". Only 127.0.0.1 behind
// the name public.example.test is allowed through the address check.
let server: http.Server;
let port = 0;
const lookupAll = async (hostname: string) => {
  if (hostname === 'public.example.test') return [{ address: '127.0.0.1', family: 4 }];
  if (hostname === 'private.example.test') return [{ address: '10.0.0.7', family: 4 }];
  throw new Error('ENOTFOUND');
};
const isBlocked = (address: string) => address !== '127.0.0.1' && isBlockedAddress(address);
const base = () => `http://public.example.test:${port}`;

before(async () => {
  server = http.createServer((req, res) => {
    const target: Record<string, string> = {
      '/to-literal': `http://127.0.0.1:${port}/ok`,
      '/to-metadata': 'http://169.254.169.254/latest/meta-data/',
      '/to-private-name': `http://private.example.test:${port}/ok`,
      '/to-public': '/ok',
      '/loop': '/loop',
    };
    if (target[req.url || '']) {
      res.writeHead(302, { Location: target[req.url || ''] });
      res.end();
    } else if (req.url === '/big') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('x'.repeat(4096));
    } else if (req.url === '/gzip') {
      res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
      res.end(zlib.gzipSync('<p>hello</p>'));
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<p>ok</p>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  server.close();
});

test('follows a redirect that stays public', async () => {
  const res = await safeGet(`${base()}/to-public`, { lookupAll, isBlocked });
  assert.equal(res.ok, true);
  assert.equal(res.body, '<p>ok</p>');
  assert.equal(res.url, `${base()}/ok`);
});

test('re-checks every redirect hop', async () => {
  for (const path of ['/to-literal', '/to-metadata', '/to-private-name']) {
    await assert.rejects(safeGet(`${base()}${path}`, { lookupAll, isBlocked }), UnsafeUrlError, path);
  }
  await assert.rejects(safeGet(`${base()}/loop`, { lookupAll, isBlocked, maxRedirects: 3 }), /Too many redirects/);
});

test('checks the resolved address at connect time, not just before', async () => {
  await assert.rejects(safeGet(`http://private.example.test:${port}/ok`, { lookupAll, isBlocked }), UnsafeUrlError);
});

test('caps the decoded body and decodes gzip', async () => {
  const big = await safeGet(`${base()}/big`, { lookupAll, isBlocked, maxBytes: 100 });
  assert.equal(big.body.length, 100);
  assert.equal(big.truncated, true);
  const gz = await safeGet(`${base()}/gzip`, { lookupAll, isBlocked });
  assert.equal(gz.body, '<p>hello</p>');
});
