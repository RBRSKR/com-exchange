const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('./engine.js');

const START = Date.UTC(2026, 10, 15, 15, 0, 0); // 2026-11-16 00:00 KST
const MIN = 60000, P = 30 * MIN, DAY = 86400000;
const G = () => ({
  seed: 'test-seed-1', start: START, periodMin: 30, dailyLimitPct: 15,
  stocks: [
    { code: 'NOVA', name: 'NOVA Technologies', sector: '기술', initial: 500, vol: 2 },
    { code: 'CORE', name: 'CORE Industries', sector: '산업재', initial: 800, vol: 1.5 },
    { code: 'ASTR', name: 'ASTRA Energy', sector: '에너지', initial: 1200, vol: 3 },
    { code: 'PIXL', name: 'Pixel Media', sector: '미디어', initial: 350, vol: 2.5 },
    { code: 'FINX', name: 'Finex Holdings', sector: '금융', initial: 1000, vol: 1.8 },
  ],
});
const prices = (r) => r.stocks.map((s) => s.code + '=' + s.price).join(',');

test('모든 이용자가 같은 가격: 같은 입력이면 결과가 같다 (이벤트 입력 순서 무관)', () => {
  const ev = [
    { id: 'b', at: START + 3 * P + 5, type: 'set_vol', payload: { code: 'NOVA', vol: 5 } },
    { id: 'a', at: START + 2 * P + 5, type: 'tick' },
  ];
  const now = START + 10 * DAY;
  const a = E.simulate(G(), ev, now), b = E.simulate(G(), ev.slice().reverse(), now);
  assert.equal(prices(a), prices(b));
  assert.deepEqual(a.stocks[0].history, b.stocks[0].history);
});

test('같은 30분 구간 안에서는 몇 번을 계산해도 가격이 바뀌지 않는다', () => {
  const t0 = START + 7 * P;
  const base = prices(E.simulate(G(), [], t0));
  for (const dt of [1, 60000, 10 * MIN, P - 1]) assert.equal(prices(E.simulate(G(), [], t0 + dt)), base);
  assert.notEqual(prices(E.simulate(G(), [], t0 + P)), base, '다음 구간에서는 갱신');
  const r = E.simulate(G(), [], t0 + 5 * MIN);
  r.stocks.forEach((s) => assert.equal(s.updates, 7, '구간당 정확히 1회'));
});

test('수동 갱신도 같은 구간에서 중복 실행되지 않는다', () => {
  const t = START + 2 * P + 60000;
  const ev = [{ id: 'x1', at: t, type: 'tick' }, { id: 'x2', at: t + 1000, type: 'tick' }];
  const r = E.simulate(G(), ev, t + 5000);
  assert.equal(r.applied.length, 1);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /duplicate/);
});

test('서버 재시작/장기 중단 후에도 이어서 계산한 결과가 같다', () => {
  const now = START + 40 * DAY + 123;
  const full = E.simulate(G(), [], now);
  const mid = E.simulate(G(), [], START + 5 * DAY);
  assert.ok(mid.stocks[0].history.length < full.stocks[0].history.length);
  assert.deepEqual(full.stocks[0].history.slice(0, mid.stocks[0].history.length), mid.stocks[0].history, '과거 기록 불변');
});

test('주가는 1 COM 미만으로 내려가지 않는다', () => {
  for (const p of [1, 2, 3, 7]) assert.ok(E.nextPrice(p, -20, p, 15) >= 1);
  const g = G(); g.stocks = [{ code: 'TINY', name: 'Tiny', initial: 3, vol: 20 }]; g.dailyLimitPct = 100;
  const r = E.simulate(g, [], START + 60 * DAY);
  assert.ok(r.stocks[0].history.every((h) => h.p >= 1 && Number.isInteger(h.p)));
});

test('일일 ±15% 제한: 하루 중 어떤 시점도 전일 종가 대비 범위를 넘지 않는다', () => {
  const g = G(); g.stocks.forEach((s) => (s.vol = 20)); // 극단 변동으로 제한 유도
  const r = E.simulate(g, [], START + 90 * DAY);
  let hitLimit = 0;
  for (const s of r.stocks) {
    let ref = s.initial, day = E.kstDay(START);
    for (const h of s.history.slice(1)) {
      const d = E.kstDay(h.t);
      if (d !== day) { day = d; ref = s.history[s.history.indexOf(h) - 1].p; }
      assert.ok(h.p <= ref * 1.15 + 1e-9 && h.p >= ref * 0.85 - 1e-9, `${s.code} ${h.p} vs ref ${ref}`);
      if (h.p === Math.floor(ref * 1.15 + 1e-9) || h.p === Math.ceil(ref * 0.85 - 1e-9)) hitLimit++;
    }
  }
  assert.ok(hitLimit > 0, '제한에 실제로 걸리는 사례가 있어야 테스트가 의미 있음');
});

test('제한 경계 계산은 부동소수점 오차 없이 정확하다', () => {
  assert.deepEqual(E.limits(100, 15), { lo: 85, hi: 115 });
  assert.deepEqual(E.limits(1000, 15), { lo: 850, hi: 1150 });
  assert.deepEqual(E.limits(7, 15), { lo: 6, hi: 8 });
  assert.deepEqual(E.limits(1, 15), { lo: 1, hi: 1 });
});

test('KST 자정 기준으로 일일 기준가가 바뀐다', () => {
  assert.equal(E.kstDay(START), E.kstDay(START + DAY - 1));
  assert.equal(E.kstDay(START) + 1, E.kstDay(START + DAY));
});

test('시장 중지 중에는 가격이 움직이지 않고, 재개 후 다시 움직인다', () => {
  const ev = [{ id: 'h', at: START + P + 10, type: 'halt' }, { id: 'r', at: START + 20 * P + 10, type: 'resume' }];
  const a = E.simulate(G(), ev, START + 2 * P), b = E.simulate(G(), ev, START + 19 * P);
  assert.equal(prices(a), prices(b));
  assert.equal(E.simulate(G(), [...ev, { id: 't', at: START + 5 * P, type: 'tick' }], START + 6 * P).skipped.length, 1, '중지 중 수동 갱신 거부');
  assert.notEqual(prices(E.simulate(G(), ev, START + 22 * P)), prices(b));
});

test('관리자 가격 변경은 기록되고 그날 기준가를 재설정한다', () => {
  const t = START + 3 * P + 100;
  const r = E.simulate(G(), [{ id: 'p', at: t, type: 'set_price', payload: { code: 'NOVA', price: 900 }, reason: '테스트' }], t + 1);
  const n = r.stocks.find((s) => s.code === 'NOVA');
  assert.equal(n.price, 900);
  assert.equal(n.history.at(-1).k, 'admin');
  const later = E.simulate(G(), [{ id: 'p', at: t, type: 'set_price', payload: { code: 'NOVA', price: 900 } }], t + 10 * P).stocks[0];
  later.history.filter((h) => h.t > t && E.kstDay(h.t) === E.kstDay(t)).forEach((h) => assert.ok(h.p >= 765 && h.p <= 1035));
});

test('미래 시각 이벤트는 그 시각 전까지 적용되지 않는다', () => {
  const ev = [{ id: 'f', at: START + 100 * P, type: 'set_price', payload: { code: 'NOVA', price: 9999 } }];
  assert.notEqual(E.simulate(G(), ev, START + 50 * P).stocks[0].price, 9999);
});

test('잘못된(신뢰할 수 없는) 이벤트는 건너뛰고 보고된다', () => {
  const ev = [
    { id: '1', at: START + 10, type: 'set_price', payload: { code: 'NOVA', price: -5 } },
    { id: '2', at: START + 20, type: 'set_price', payload: { code: 'NOPE', price: 10 } },
    { id: '3', at: START + 30, type: 'set_vol', payload: { code: 'NOVA', vol: 999 } },
    { id: '4', at: START + 40, type: 'list', payload: { code: 'NOVA', name: 'dup', initial: 1, vol: 1 } },
    { id: '5', at: START + 50, type: 'wat' },
  ];
  const r = E.simulate(G(), ev, START + P - 1);
  assert.equal(r.skipped.length, 5);
  assert.equal(r.stocks[0].price, 500);
});

test('신규 상장 종목은 상장 이후 구간부터 움직인다', () => {
  const t = START + 4 * P + 10;
  const r = E.simulate(G(), [{ id: 'l', at: t, type: 'list', payload: { code: 'LUNA', name: 'Luna Bio', initial: 700, vol: 2 } }], START + 8 * P + 1);
  const s = r.stocks.find((x) => x.code === 'LUNA');
  assert.equal(s.updates, 4);
});

test('변동률은 설정 범위 안에서 고르게 분포한다', () => {
  let min = 9, max = -9, sum = 0; const n = 20000;
  for (let i = 0; i < n; i++) { const r = E.randomRate('s', 'k' + i, 2); min = Math.min(min, r); max = Math.max(max, r); sum += r; }
  assert.ok(min >= -2 && max <= 2 && min < -1.99 && max > 1.99);
  assert.ok(Math.abs(sum / n) < 0.05);
});

test('고정 시각 일정(08:00·17:00·22:00 KST)에만 갱신된다', () => {
  const g = G(); delete g.periodMin; g.schedule = [480, 1020, 1320]; g.start = START + 8 * 3600000; // 11-16 08:00 KST
  const at = (h, m) => START + (h * 60 + (m || 0)) * MIN;
  assert.equal(E.simulate(g, [], at(16, 59)).stocks[0].updates, 0, '시작 시각(08:00)은 갱신이 아님');
  const r17 = E.simulate(g, [], at(17)); assert.equal(r17.stocks[0].updates, 1);
  assert.equal(r17.nextUpdate, at(22));
  assert.equal(prices(r17), prices(E.simulate(g, [], at(21, 59))));
  assert.equal(E.simulate(g, [], at(22)).stocks[0].updates, 2);
  const next = E.simulate(g, [], at(24 + 7, 59)); assert.equal(next.stocks[0].updates, 2); assert.equal(next.nextUpdate, at(24 + 8));
  assert.equal(E.simulate(g, [], at(24 + 8)).stocks[0].updates, 3);
  const r = E.simulate(g, [], START + 30 * DAY); r.stocks.forEach((s) => s.history.slice(1).forEach((h) => assert.ok([8, 17, 22].includes(new Date(h.t + 9 * 3600000).getUTCHours()))));
  // manual tick: once per interval between scheduled updates
  const ev = [{ id: 'a', at: at(18), type: 'tick' }, { id: 'b', at: at(21), type: 'tick' }, { id: 'c', at: at(23), type: 'tick' }];
  const m = E.simulate(g, ev, at(23, 30)); assert.equal(m.applied.length, 2); assert.equal(m.skipped.length, 1);
});

test('뉴스: 모두에게 같은 뉴스, 예고 뒤에는 성공/실패 결과가 나온다', () => {
  const g = G(); delete g.periodMin; g.schedule = [480, 1020, 1320];
  const now = START + 120 * DAY;
  const a = E.simulate(g, [], now), b = E.simulate(g, [], now);
  assert.deepEqual(a.news, b.news);
  assert.ok(a.news.length > 50, 'news count ' + a.news.length);
  const byCode = {};
  a.news.slice().reverse().forEach((n) => (byCode[n.code] = byCode[n.code] || []).push(n));
  let pairs = 0, ok = 0, ng = 0;
  for (const list of Object.values(byCode)) list.forEach((n, i) => {
    if (n.kind === 'setup') { const nx = list[i + 1]; if (nx) { assert.ok(nx.kind === 'success' || nx.kind === 'fail', 'setup followed by ' + nx.kind); pairs++; } }
    if (n.kind === 'success') { ok++; assert.ok(n.effect >= 6); }
    if (n.kind === 'fail') { ng++; assert.ok(n.effect <= -6); }
    assert.ok(!n.headline.includes('{n}'));
  });
  assert.ok(pairs > 5 && ok > 0 && ng > 0);
  // news-driven moves still respect daily limit (checked via history)
  for (const s of a.stocks) { let ref = s.initial, day = E.kstDay(s.history[0].t);
    s.history.forEach((h, i) => { if (!i) return; const d = E.kstDay(h.t); if (d !== day) { day = d; ref = s.history[i - 1].p; } assert.ok(h.p <= Math.floor(ref * 1.15 + 1e-9) && h.p >= Math.ceil(ref * 0.85 - 1e-9)); }); }
});

test('뉴스: 시장 중지 중에는 뉴스도 나오지 않는다', () => {
  const g = G(); delete g.periodMin; g.schedule = [480, 1020, 1320];
  const ev = [{ id: 'h', at: START + 1, type: 'halt' }];
  assert.equal(E.simulate(g, ev, START + 30 * DAY).news.length, 0);
});

test('관리자 뉴스는 즉시 반영되고 기록된다', () => {
  const t = START + 3 * P + 100;
  const ev = [{ id: 'n', at: t, type: 'news', payload: { code: 'ASTR', headline: '테스트 호재', effect: 10 } }];
  const r = E.simulate(G(), ev, t + 1);
  const s = r.stocks.find((x) => x.code === 'ASTR');
  assert.equal(r.news[0].kind, 'admin'); assert.equal(r.news[0].headline, '테스트 호재');
  assert.equal(s.history.at(-1).k, 'news'); assert.ok(s.price > s.history.at(-2).p);
  assert.equal(E.simulate(G(), [{ id: 'x', at: t, type: 'news', payload: { code: 'ASTR', headline: 'x', effect: 99 } }], t + 1).skipped.length, 1);
});

test('장중 30분 갱신 + 뉴스 빈도 조절: 하루 뉴스 수가 목표 근처, 예고 결과는 몇 시간 뒤', () => {
  const g = G(); delete g.periodMin;
  g.schedule = []; for (let m = 540; m <= 1320; m += 30) g.schedule.push(m); // 09:00~22:00
  g.newsPerStockDay = 0.6; g.stocks.forEach((s) => { s.vol = 0.8; s.shares = 10000; });
  const days = 200, r = E.simulate(g, [], START + days * DAY);
  const perStockDay = r.news.length / (days * g.stocks.length);
  assert.ok(perStockDay > 0.4 && perStockDay < 0.85, 'news/stock/day ' + perStockDay.toFixed(2));
  const byCode = {}; r.news.slice().reverse().forEach((n) => (byCode[n.code] = byCode[n.code] || []).push(n));
  let gaps = [];
  for (const list of Object.values(byCode)) list.forEach((n, i) => { if (n.kind === 'setup' && list[i + 1]) gaps.push((list[i + 1].t - n.t) / 3600000); });
  assert.ok(gaps.length > 10 && Math.min(...gaps) >= 4, 'story gap hours min ' + Math.min(...gaps));
  r.stocks.forEach((s) => { assert.equal(s.shares, 10000); s.history.slice(1).forEach((h) => { const m = (h.t + 9 * 3600000) % DAY / 60000; assert.ok(m >= 540 && m <= 1320 && m % 30 === 0); }); });
});

test('갱신 간격을 중간에 바꿔도 지난 가격은 그대로, 이후는 새 간격', () => {
  const g = G(); delete g.periodMin;
  g.schedule = []; for (let m = 540; m <= 1320; m += 30) g.schedule.push(m);
  g.newsPerStockDay = 0.6;
  const ten = []; for (let m = 540; m <= 1320; m += 10) ten.push(m);
  const change = START + 2 * DAY + (15 * 60 + 40) * MIN; // day 3, 15:40 KST
  const ev = [{ id: 'sc', at: change, type: 'schedule', payload: { schedule: ten } }];
  const before = E.simulate(g, [], change), after = E.simulate(g, ev, START + 12 * DAY);
  for (const s of before.stocks) {
    const a = after.stocks.find((x) => x.code === s.code);
    assert.deepEqual(a.history.slice(0, s.history.length), s.history, s.code + ' history before change must not move');
    const later = a.history.filter((h) => h.t > change);
    assert.ok(later.length > 70 * 9, 'many 10-min updates');
    later.forEach((h) => { const m = (h.t + 9 * 3600000) % DAY / 60000; assert.ok(m % 10 === 0 && m >= 540 && m <= 1320); });
  }
  assert.deepEqual(after.news.filter((n) => n.t <= change), before.news.filter((n) => n.t <= change));
  const perDay = after.news.filter((n) => n.t > change).length / (9.3 * g.stocks.length);
  assert.ok(perDay > 0.3 && perDay < 0.9, 'news per stock per day ' + perDay.toFixed(2));
  assert.deepEqual(after.schedule, ten);
  assert.equal(E.simulate(g, ev, change - 1).nextUpdate, START + 2 * DAY + (15 * 60 + 50) * MIN); // first 10-min slot after the change
});

test('체크포인트에서 이어 계산해도 처음부터 계산한 것과 완전히 같다', () => {
  const g = G(); delete g.periodMin;
  g.schedule = []; for (let m = 540; m <= 1320; m += 5) g.schedule.push(m);
  g.newsPerStockDay = 0.6; g.dailyLimitPct = 30;
  const at = (d, h, m) => START + d * DAY + (h * 60 + (m || 0)) * MIN;
  const ev = [
    { id: '1', at: at(1, 10, 3), type: 'news', payload: { code: 'NOVA', headline: '특보', effect: 9 } },
    { id: '2', at: at(2, 0, 0), type: 'halt' },                       // exactly at a checkpoint time
    { id: '3', at: at(2, 13, 7), type: 'resume' },
    { id: '4', at: at(2, 15, 1), type: 'tick' },
    { id: '5', at: at(3, 12, 0), type: 'list', payload: { code: 'LUNA', name: 'Luna', initial: 300, vol: 0.5, shares: 1000 } },
    { id: '6', at: at(4, 9, 30), type: 'schedule', payload: { schedule: [540, 600, 660] } },
  ];
  const now = at(6, 17, 2);
  const full = E.simulate(g, ev, now);
  // chain checkpoints at every KST midnight
  let st = null;
  for (let d = 1; d <= 6; d++) st = E.simulate(g, ev, START + d * DAY, { from: st, snapshot: true }).state;
  const res = E.simulate(g, ev, now, { from: st });
  const strip = (r) => r.stocks.map((s) => ({ c: s.code, p: s.price, h: s.history, ref: s.ref, story: s.story }));
  assert.deepEqual(strip(res), strip(full));
  assert.deepEqual(res.news, full.news);
  assert.equal(res.halted, full.halted); assert.equal(res.slot, full.slot);
  assert.equal(res.slotStart, full.slotStart); assert.equal(res.nextUpdate, full.nextUpdate);
  assert.deepEqual(res.schedule, full.schedule);
  // checkpoint survives JSON (as stored in KV)
  const res2 = E.simulate(g, ev, now, { from: JSON.parse(JSON.stringify(st)) });
  assert.deepEqual(strip(res2), strip(full));
});
