// COM EXCHANGE price API (Cloudflare Worker).
// GET /api/data → market data computed at request time from market.json (public, on GitHub) + MARKET_SEED (Worker secret).
// To stay inside the free plan's CPU limit, the engine state at each KST midnight is saved (memory → Cache → KV)
// and a request only computes from today's midnight. Nothing in the response reveals the seed or future prices.
import market from '../lib/market.js';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Max-Age': '86400' };
const CONFIG_TTL = 20;          // seconds: admin panel changes show up within about this long
const MAX_CATCHUP_DAYS = 8;     // days of checkpoints one request may compute
const CK_TTL = 90 * 86400;      // keep checkpoints 90 days
const mem = new Map();          // per-isolate memo of checkpoints

class Busy extends Error {}

async function loadConfig(env, ctx) {
  const cache = caches.default, key = new Request('https://config.cache/market.json');
  const hit = await cache.match(key);
  if (hit) return hit.json();
  // the query string skips GitHub's own CDN cache so a fresh commit is seen right away
  const r = await fetch(env.CONFIG_URL + '?t=' + Math.floor(Date.now() / (CONFIG_TTL * 1000)), { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error('설정 파일을 불러오지 못했습니다 (' + r.status + ')');
  const text = await r.text();
  const cfg = JSON.parse(text);
  ctx.waitUntil(cache.put(key, new Response(text, { headers: { 'Cache-Control': 'max-age=' + CONFIG_TTL } })));
  return cfg;
}

async function getCk(env, key) {
  if (mem.has(key)) return mem.get(key);
  const ck = new Request('https://ck.cache/' + encodeURIComponent(key));
  const hit = await caches.default.match(ck);
  let v = hit ? await hit.json() : null;
  if (!v && env.CKPT) v = await env.CKPT.get(key, 'json');
  if (v) mem.set(key, v);
  return v;
}
function putCk(env, ctx, key, v) {
  mem.set(key, v);
  const body = JSON.stringify(v);
  ctx.waitUntil(caches.default.put(new Request('https://ck.cache/' + encodeURIComponent(key)), new Response(body, { headers: { 'Cache-Control': 'max-age=' + CK_TTL } })));
  if (env.CKPT) ctx.waitUntil(env.CKPT.put(key, body, { expirationTtl: CK_TTL }));
}

// newest checkpoint at or before today's KST midnight, computing missing days (a few per request)
async function todayState(env, ctx, prep, now) {
  const { DAY, dayStart, checkpointKey, makeCheckpoint } = market;
  const start = prep.genesis.start, T0 = dayStart(now);
  const first = dayStart(start) + DAY;                // first midnight after the market opened
  if (T0 < first) return null;                        // still the opening day: compute from genesis
  const hintKey = 'ckhint:' + checkpointKey(prep, first);
  let found = null;
  const hint = await getCk(env, hintKey);             // where the newest saved checkpoint is
  const tries = [T0, T0 - DAY];
  if (hint && hint.t && hint.t < T0 - DAY) tries.push(hint.t);
  for (const T of tries) { if (T < first) continue; const v = await getCk(env, checkpointKey(prep, T)); if (v) { found = v; break; } }
  let cur = found, t = found ? found.t + DAY : first, made = 0;
  while (t <= T0) {
    if (made >= MAX_CATCHUP_DAYS) { putCk(env, ctx, hintKey, { t: cur.t }); throw new Busy('지난 시세를 정리하는 중이에요. 잠시 후 다시 시도해 주세요.'); }
    cur = makeCheckpoint(prep, t, cur);
    putCk(env, ctx, checkpointKey(prep, t), cur);
    t += DAY; made++;
  }
  if (made) putCk(env, ctx, hintKey, { t: cur.t });
  return cur;
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
        const now = Date.now();
        const prep = market.prepare(cfg, env.MARKET_SEED, now);
        const from = await todayState(env, ctx, prep, now);
        const { out } = market.computeMarket(cfg, env.MARKET_SEED, now, { prep, from });
        return json(out, 200, { 'Cache-Control': 'no-store' });
      } catch (e) {
        const status = e instanceof Busy ? 503 : e instanceof market.MarketError ? 500 : 502;
        return json({ error: e && e.message ? e.message : String(e) }, status, status === 503 ? { 'Retry-After': '5' } : {});
      }
    }
    if (url.pathname === '/' || url.pathname === '') return Response.redirect(env.SITE_URL, 302);
    return json({ error: 'not found' }, 404);
  },
};
