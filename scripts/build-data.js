// Builds _site/ (index.html + data.json) from market.json and the secret MARKET_SEED.
// Only prices up to "now" are published, so nobody can see future prices.
const fs = require('fs'), path = require('path');
const E = require('../engine.js');
const root = path.join(__dirname, '..');
const fail = (m) => { console.error('::error::' + m); process.exit(1); };

const seed = process.env.MARKET_SEED;
if (!seed || seed.length < 16) fail('MARKET_SEED 시크릿이 없습니다. 저장소 Settings → Secrets and variables → Actions 에 추가하세요.');

let cfg;
try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'market.json'), 'utf8')); }
catch (e) { fail('market.json 형식이 잘못됐습니다: ' + e.message); }

// "2026-11-17 19:58" → KST time
const kst = (v, what) => {
  if (typeof v === 'number') return v;
  const t = Date.parse(String(v).trim().replace(' ', 'T') + ':00+09:00');
  if (!Number.isFinite(t)) fail(what + ' 시각 형식이 잘못됐습니다: "' + v + '" (예: "2026-11-17 19:58")');
  return t;
};
const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s); if (!m || +m[1] > 23 || +m[2] > 59) fail('schedule 시각이 잘못됐습니다: ' + s); return +m[1] * 60 + +m[2]; };

const now = Date.now();
const genesis = {
  seed, start: kst(cfg.start, 'start'), dailyLimitPct: cfg.dailyLimitPct, stocks: cfg.stocks,
  ...(cfg.schedule ? { schedule: cfg.schedule.map(hm) } : { periodMin: cfg.periodMin }),
};
const events = (cfg.events || []).map((e, i) => {
  const { at, type, reason, ...payload } = e;
  return { id: String(i).padStart(5, '0'), at: kst(at, 'events[' + i + ']'), type, reason, payload };
});
const errs = E.validateGenesis(genesis);
if (errs.length) fail('market.json 설정 오류: ' + errs.join(', '));

const r = E.simulate(genesis, events, now);
r.skipped.forEach((x) => console.log('::warning::적용 안 된 이벤트 #' + (+x.e.id) + ' (' + x.e.type + '): ' + x.why));

const keep = ['code', 'name', 'sector', 'description', 'initial', 'vol', 'price', 'prev', 'prevClose', 'change', 'changePct', 'limitLo', 'limitHi', 'listedAt', 'updates', 'history'];
const sim = {
  stocks: r.stocks.map((s) => Object.fromEntries(keep.map((k) => [k, s[k]]))),
  halted: r.halted, news: r.news, slot: r.slot, slotStart: r.slotStart, nextUpdate: r.nextUpdate, periodMs: r.periodMs, dailyLimitPct: r.dailyLimitPct,
};
const out = {
  generatedAt: now,
  genesis: { start: genesis.start, schedule: genesis.schedule, periodMin: genesis.periodMin, dailyLimitPct: genesis.dailyLimitPct },
  notices: (cfg.notices || []).map((n, i) => ({ id: 'n' + i, title: String(n.title || ''), body: String(n.body || ''), pinned: !!n.pinned, at: kst(n.at || cfg.start, 'notices[' + i + ']') })).sort((a, b) => b.at - a.at),
  sim,
};
const site = path.join(root, '_site');
fs.mkdirSync(site, { recursive: true });
fs.copyFileSync(path.join(root, 'index.html'), path.join(site, 'index.html'));
fs.writeFileSync(path.join(site, 'data.json'), JSON.stringify(out));
console.log('시세 ' + new Date(now).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' 기준 · ' + (r.halted ? '시장 중지' : '운영 중') + ' · ' +
  sim.stocks.map((s) => s.code + ' ' + s.price).join(', ') + ' · 뉴스 ' + r.news.length + '건');
