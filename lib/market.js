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

function computeMarket(cfg, seed, now) {
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

  const r = E.simulate(genesis, events, now);
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

module.exports = { computeMarket, MarketError };
