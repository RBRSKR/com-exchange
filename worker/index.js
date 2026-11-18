// COM EXCHANGE price API (Cloudflare Worker).
// GET /api/data → market data computed at request time from market.json (public, on GitHub) + MARKET_SEED (Worker secret).
// Prices change exactly at each scheduled minute; nothing in the response reveals the seed or future prices.
import market from '../lib/market.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' };
const CONFIG_TTL = 20; // seconds: admin panel changes show up within about this long

async function loadConfig(env, ctx) {
  const url = env.CONFIG_URL;
  const cache = caches.default, key = new Request('https://config.cache/market.json');
  const hit = await cache.match(key);
  if (hit) return hit.json();
  // the query string skips GitHub's own CDN cache so a fresh commit is seen right away
  const r = await fetch(url + '?t=' + Math.floor(Date.now() / (CONFIG_TTL * 1000)), { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error('설정 파일을 불러오지 못했습니다 (' + r.status + ')');
  const text = await r.text();
  const cfg = JSON.parse(text);
  ctx.waitUntil(cache.put(key, new Response(text, { headers: { 'Cache-Control': 'max-age=' + CONFIG_TTL } })));
  return cfg;
}

const json = (body, status, extra) => new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...(extra || {}) } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return json({ error: 'GET만 됩니다.' }, 405);
    if (url.pathname === '/api/data') {
      try {
        const cfg = await loadConfig(env, ctx);
        const { out } = market.computeMarket(cfg, env.MARKET_SEED, Date.now());
        return json(out, 200, { 'Cache-Control': 'no-store' });
      } catch (e) {
        return json({ error: e && e.message ? e.message : String(e) }, e instanceof market.MarketError ? 500 : 502);
      }
    }
    if (url.pathname === '/' || url.pathname === '') return Response.redirect(env.SITE_URL, 302);
    return json({ error: 'not found' }, 404);
  },
};
