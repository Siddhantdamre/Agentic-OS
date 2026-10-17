// Probe: can a model-written host receive a workspace's OAuth token? Uses a FAKE token and a fake local Nango only.
import http from 'node:http';
const FAKE = 'FAKE_TOKEN_DO_NOT_USE_1234';
let storeHost = 'acme';            // what the workspace's own recorded connection says
const nango = http.createServer((req, res) => {
  const conn = decodeURIComponent(req.url.split('/connection/')[1].split('?')[0]);
  res.setHeader('content-type', 'application/json');
  const base = { credentials: { access_token: FAKE }, connection_config: {}, metadata: {} };
  if (conn.endsWith('_shopify')) base.connection_config.shop = `${storeHost}.myshopify.com`;
  if (conn.endsWith('_zendesk')) base.connection_config.subdomain = storeHost;
  res.end(JSON.stringify(base));
}).listen(0, '127.0.0.1', async () => {
  const port = nango.address().port;
  process.env.NANGO_HOST = `http://127.0.0.1:${port}`; process.env.NANGO_SECRET_KEY = 'fake-nango-secret';
  delete process.env.SHOPIFY_SHOP_DOMAIN; delete process.env.ZENDESK_SUBDOMAIN;
  const realFetch = globalThis.fetch; const seen = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(process.env.NANGO_HOST)) return realFetch(url, init);
    const headers = JSON.stringify(init.headers || {});
    seen.push({ url: u, carriesToken: headers.includes(FAKE), redirect: init.redirect });
    return new Response(JSON.stringify({ products: [], orders: [], tickets: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const { shopify } = await import('/home/user/release-check/services/workflows/dist/tools/shopify.js');
  const { zendesk } = await import('/home/user/release-check/services/workflows/dist/tools/zendesk.js');
  const ORG = '00000000-0000-4000-8000-0000000000c6', TS = new Date().toISOString();
  const hostile = ['attacker.example', 'attacker.example/x?', 'acme.myshopify.com@attacker.example', 'acme.myshopify.com.attacker.example',
    '127.0.0.1', 'localhost:8080', '169.254.169.254', 'acme.myshopify.com:8443', 'ａｔｔａｃｋｅｒ.example', '', 'evil\n.example', 'otherstore'];
  let leaked = 0, rows = [];
  for (const h of hostile) {
    for (const [name, tool, act, key] of [['shopify', shopify, 'fetch_products', 'shopDomain'], ['zendesk', zendesk, 'fetch_tickets', 'subdomain']]) {
      seen.length = 0;
      let r; try { r = await tool.execute({ tool: name, action: act, actionName: act, payload: { [key]: h }, orgId: ORG, timestamp: TS }); } catch (e) { r = { status: 'threw', message: String(e.message).slice(0, 60) }; }
      const bad = seen.filter(s => !new RegExp(`^https://acme\\.(myshopify|zendesk)\\.com/`).test(s.url));
      const exfil = bad.filter(s => s.carriesToken);
      leaked += exfil.length;
      rows.push(`${name.padEnd(8)} payload=${JSON.stringify(h).padEnd(42)} -> ${String(r.status).padEnd(8)} requests=${seen.length} to_other_host=${bad.length} token_to_other_host=${exfil.length}`);
    }
  }
  // No recorded store: the payload must not be trusted at all.
  storeHost = ''; const { clearNangoCache } = await import('/home/user/release-check/services/workflows/dist/tools/shared.js').catch(() => ({}));
  console.log(rows.join('\n')); console.log(`\nTOKEN SENT TO A NON-WORKSPACE HOST: ${leaked} time(s)`);
  nango.close(); process.exit(leaked === 0 ? 0 : 1);
});
