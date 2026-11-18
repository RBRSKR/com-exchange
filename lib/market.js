// Shared by the GitHub build script (Node) and the Cloudflare Worker.
// computeMarket(cfg, seed, now) → public market data up to `now` (never the seed, never future prices).
'use strict';
const E = require('../engine.js');

class MarketError extends Error {}
const fail = (m) => { throw new MarketError(m); };

// "2026-11-17 19:58[:30]" → KST epoch ms
function kst(v, what) {
  if (typeof v === 'number') return v;
  const str = String(v).trim().replace(' ', 'T');
  const t = Date.parse(str + (/T\d{1,2}:\d{2}:\d{2}$/.test(str) ? '' : ':00') + '+09:00');
  if (!Number.isFinite(t)) fail(what + ' 시각 형식이 잘못됐습니다: "' + v + '" (예: "2026-11-17 19:58")');
  return t;
}
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); if (!m || +m[1] > 23 || +m[2] > 59) fail('schedule 시각이 잘못됐습니다: ' + s); return +m[1] * 60 + +m[2]; };
function sessionToSchedule(ss, what) {
  const o = hm(ss.open), c = hm(ss.close), st = ss.everyMin;
  if (!Number.isInteger(st) || st < 5 || o >= c) fail(what + ' session 설정이 잘못됐습니다 (open < close, everyMin 5 이상)');
  const out = []; for (let m = o; m <= c; m += st) out.push(m); return out;
}

const DAY = 86400000, KST = 9 * 3600000;
const dayStart = (ms) => Math.floor((ms + KST) / DAY) * DAY - KST; // KST midnight at or before ms

// Old days are sent as their open/high/low/close plus news and admin points; the last two days keep every point.
// Applying it twice gives the same result, so checkpoints and the final output agree.
const KEEP_KINDS = { admin: 1, list: 1, manual: 1 };
function compressHistory(h, cutoff) {
  if (!h.length || h[0].t >= cutoff) return h;
  const out = [];
  let i = 0;
  while (i < h.length && h[i].t < cutoff) {
    const d = dayStart(h[i].t); let j = i; while (j < h.length && h[j].t < cutoff && dayStart(h[j].t) === d) j++;
    let hi = i, lo = i;
    for (let x = i; x < j; x++) { if (h[x].p > h[hi].p) hi = x; if (h[x].p < h[lo].p) lo = x; }
    for (let x = i; x < j; x++) if (x === i || x === j - 1 || x === hi || x === lo || h[x].n || KEEP_KINDS[h[x].k]) out.push(h[x]);
    i = j;
  }
  for (; i < h.length; i++) out.push(h[i]);
  return out;
}

function prepare(cfg, seed, now) {
  if (!seed || String(seed).length < 16) fail('MARKET_SEED가 없습니다.');
  if (!cfg || typeof cfg !== 'object') fail('market.json 형식이 잘못됐습니다.');
  let schedule = cfg.schedule ? cfg.schedule.map(hm) : null;
  if (cfg.session) schedule = sessionToSchedule(cfg.session, '');
  const genesis = {
    seed, start: kst(cfg.start, 'start'), dailyLimitPct: cfg.dailyLimitPct, stocks: cfg.stocks,
    ...(schedule ? { schedule } : { periodMin: cfg.periodMin }),
    ...(cfg.newsPerStockDay !== undefined ? { newsPerStockDay: cfg.newsPerStockDay } : {}),
  };
  const events = (cfg.events || []).map((e, i) => {
    let { at, type, reason, ...payload } = e;
    if (type === 'schedule' && payload.session) payload = { schedule: sessionToSchedule(payload.session, 'events[' + i + ']') };
    return { id: String(i).padStart(5, '0'), at: kst(at, 'events[' + i + ']'), type, reason, payload };
  });
  // events must be appended in time order: a back-dated line would rewrite prices people already saw
  for (let i = 1; i < events.length; i++) if (events[i].at < events[i - 1].at) fail('events #' + i + ' 의 시각이 앞줄보다 이릅니다. 과거 시각으로 끼워 넣으면 이미 공개된 가격이 바뀝니다.');
  // market.json is public: an event written ahead of time would leak (e.g. tomorrow's news)
  const future = events.filter((e) => e.at > now + 10 * 60000);
  if (future.length) fail('미래 시각 이벤트가 있습니다 (#' + future.map((e) => +e.id).join(', #') + '). market.json은 공개 파일이라 미리 적으면 다른 사람이 볼 수 있어요. 지금 시각으로 적어 주세요.');
  const errs = E.validateGenesis(genesis);
  if (errs.length) fail('market.json 설정 오류: ' + errs.join(', '));
  return { cfg, genesis, events };
}

// checkpoint = engine state right after KST midnight T; its key changes if anything before T changes
function checkpointKey(prep, T) {
  const src = JSON.stringify([prep.genesis, prep.events.filter((e) => e.at < T)]);
  return 'ck1:' + T + ':' + E.cyrb53(src, 1).toString(36) + E.cyrb53(src, 2).toString(36);
}
function makeCheckpoint(prep, T, from) {
  const st = E.simulate(prep.genesis, prep.events, T, { from, snapshot: true }).state;
  st.stocks.forEach((s) => { s.history = compressHistory(s.history, T - DAY); });
  return st;
}

function computeMarket(cfg, seed, now, opts) {
  const prep = opts && opts.prep ? opts.prep : prepare(cfg, seed, now);
  const { genesis, events } = prep;
  const r = E.simulate(genesis, events, now, opts && opts.from ? { from: opts.from } : undefined);
  const cut = dayStart(now) - DAY;
  r.stocks.forEach((s) => { s.history = compressHistory(s.history, cut); });
  const keep = ['code', 'name', 'sector', 'description', 'initial', 'vol', 'shares', 'price', 'prev', 'prevClose', 'change', 'changePct', 'limitLo', 'limitHi', 'listedAt', 'updates', 'history'];
  const sim = {
    stocks: r.stocks.map((s) => Object.fromEntries(keep.map((k) => [k, s[k]]))),
    halted: r.halted, news: r.news, slot: r.slot, slotStart: r.slotStart, nextUpdate: r.nextUpdate, periodMs: r.periodMs, dailyLimitPct: r.dailyLimitPct,
  };
  const out = {
    generatedAt: now,
    genesis: { start: genesis.start, schedule: r.schedule || genesis.schedule, periodMin: genesis.periodMin, dailyLimitPct: genesis.dailyLimitPct },
    notices: (cfg.notices || []).map((n, i) => ({ id: 'n' + i, title: String(n.title || ''), body: String(n.body || ''), pinned: !!n.pinned, at: kst(n.at || cfg.start, 'notices[' + i + ']') })).sort((a, b) => b.at - a.at),
    sim,
  };
  return { out, warnings: r.skipped.map((x) => '적용 안 된 이벤트 #' + (+x.e.id) + ' (' + x.e.type + '): ' + x.why) };
}

module.exports = { computeMarket, prepare, checkpointKey, makeCheckpoint, compressHistory, dayStart, DAY, MarketError };
