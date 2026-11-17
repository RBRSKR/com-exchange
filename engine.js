/* COM EXCHANGE price engine v0.2
 * Deterministic: price history = f(genesis, admin events, now).
 * Every viewer computing with the same inputs gets identical prices,
 * each 30-minute slot is applied exactly once by construction,
 * and missed slots after any outage are recomputed exactly (catch-up).
 */
(function (root) {
  'use strict';
  const MIN = 60 * 1000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const KST_OFFSET = 9 * HOUR;
  const MAX_VOL = 20;          // % per update, sanity cap
  const MAX_PRICE = 1e12;

  // ---- news templates: {n} = company name. go = 예고, ok = 성공, ng = 실패 ----
  const NEWS = {
    CCI: {
      stories: [
        { go: '{n}, 세계에서 가장 빠른 슈퍼컴퓨터 개발 착수', ok: '{n} 슈퍼컴퓨터 완성! 세계 기록 갈아치워', ng: '{n} 슈퍼컴퓨터 시연 중 화재… 개발 무기한 연기' },
        { go: '{n}, 신형 게이밍 노트북 공개 예정', ok: '{n} 신형 노트북, 예약 하루 만에 완판', ng: '{n} 신형 노트북 발열 논란… 대규모 리콜' },
      ],
      up: ['{n}, 대형 서버 납품 계약 체결', '전국 학교 컴퓨터실, {n} 제품으로 교체 결정'],
      down: ['{n} 공장 정전으로 생산 중단', '부품값 폭등… {n} 이익 감소 전망'],
    },
    MUG: {
      stories: [
        { go: '{n}, 신작 세계관 애니메이션 제작 발표', ok: '{n} 신작 애니 첫 화 조회수 1억 돌파', ng: '{n} 신작 애니 혹평 쏟아져… 시청자 "실망"' },
        { go: '{n}, 대형 게임사와 세계관 게임 협업 협상 중', ok: '{n} 게임 협업 최종 계약! 내년 출시 확정', ng: '{n} 게임 협업 협상 결렬' },
      ],
      up: ['{n} 굿즈 품절 대란', '인기 스트리머가 {n} 작품 강력 추천'],
      down: ['{n} 핵심 작가 퇴사 소식', '{n} 세계관 표절 의혹 제기'],
    },
    SAI: {
      stories: [
        { go: '{n}, 사람 직업을 대신할 AI 개발 착수', ok: '{n} 직업 대체 AI 개발 성공! 전 세계 주문 폭주', ng: '{n} 직업 대체 AI 시연 대실패… 커피 대신 간장 내려' },
        { go: '{n}, 숙제 도와주는 AI 비서 출시 예고', ok: '{n} 숙제 비서, 출시 첫날 가입자 1000만 명', ng: '{n} 숙제 비서 오답 투성이… "쓸모없다" 혹평' },
      ],
      up: ['{n}, 대기업과 AI 공급 계약 체결', '{n} 연구팀, 국제 AI 대회 우승'],
      down: ['{n} 서버 해킹 피해 발생', 'AI 규제 법안 발표… {n} 긴장'],
    },
    DER: {
      stories: [
        { go: '{n}, 신형 원자로 첫 가동 시험 예정', ok: '{n} 신형 원자로 가동 성공! 도시 전체에 전기 공급', ng: '{n} 신형 원자로 시험 중 비상 정지… 안전 점검 돌입' },
        { go: '{n}, 우주 정거장 전력 공급 입찰 참가', ok: '{n}, 우주 정거장 전력 계약 따냈다', ng: '{n}, 우주 정거장 입찰 탈락' },
      ],
      up: ['전기 요금 인상… {n} 수혜 기대', '정부, 차세대 에너지 지원금 발표… {n} 대상'],
      down: ['{n} 원자로 근처 주민 반대 시위', '{n} 냉각 장치 고장'],
    },
    RIM: {
      stories: [
        { go: '{n}, 새 얼음 광맥 탐사 시작', ok: '{n}, 초대형 얼음 광맥 발견! 매장량 10배', ng: '{n} 탐사 결과 "빈 광맥"… 탐사비만 날려' },
        { go: '{n}, 고대 얼음 속 화석 발굴 중', ok: '{n}, 얼음 속에서 공룡 화석 발견! 박물관 계약', ng: '{n}이 발굴한 화석, 알고 보니 닭뼈' },
      ],
      up: ['폭염 예보… 얼음 수요 급증에 {n} 웃는다', '{n}, 빙수 프랜차이즈와 공급 계약'],
      down: ['이상 기온으로 {n} 광산 일부 녹아내려', '{n} 채굴 장비 고장으로 작업 중단'],
    },
    _: {
      stories: [
        { go: '{n}, 대형 신사업 발표 예정', ok: '{n} 신사업 대성공! 매출 급증', ng: '{n} 신사업 실패… 손실 발생' },
        { go: '{n}, 신제품 공개 행사 예고', ok: '{n} 신제품 호평 일색', ng: '{n} 신제품 반응 싸늘' },
      ],
      up: ['{n}, 대형 계약 체결', '{n} 실적 예상 뛰어넘어'],
      down: ['{n} 사고로 생산 차질', '{n} 실적 부진 우려'],
    },
  };
  // probabilities per stock per scheduled update, and effect ranges (% added to the random move)
  const NEWS_P = { story: 0.10, single: 0.08 };
  const EFF = { go: [1, 3], big: [6, 12], single: [3, 6] };

  function kstDay(ms) { return Math.floor((ms + KST_OFFSET) / DAY); }

  // cyrb53 — deterministic 53-bit string hash (Math.imul is exact everywhere)
  function cyrb53(str, seed) {
    let h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
  }
  function unitRand(seed, key) { return cyrb53(String(seed) + '|' + key) / 9007199254740992; } // [0,1)

  // rate in percent, uniform in [-vol, +vol), rounded to 0.0001% for portability
  function randomRate(seed, key, vol) {
    const r = (unitRand(seed, key) * 2 - 1) * vol;
    return Math.round(r * 10000) / 10000;
  }

  function limits(ref, limitPct) {
    const hi = Math.floor(ref * (100 + limitPct) / 100 + 1e-9);
    const lo = Math.max(1, Math.ceil(ref * (100 - limitPct) / 100 - 1e-9));
    return { lo: Math.min(lo, Math.max(hi, 1)), hi: Math.max(hi, 1) };
  }

  /** Core formula + daily clamp. Returns the new integer price. */
  function nextPrice(price, ratePct, ref, limitPct) {
    let p = Math.max(1, Math.round(price * (1 + ratePct / 100)));
    const L = limits(ref, limitPct);
    if (p > L.hi) p = L.hi;
    if (p < L.lo) p = L.lo;
    return Math.max(1, p);
  }

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const isStr = (x, max) => typeof x === 'string' && x.length <= (max || 2000);
  const CODE_RE = /^[A-Z0-9]{2,6}$/;

  function validStock(s) {
    return s && CODE_RE.test(s.code) && isStr(s.name, 60) && s.name.trim() &&
      isNum(s.initial) && s.initial >= 1 && s.initial <= MAX_PRICE && Math.round(s.initial) === s.initial &&
      isNum(s.vol) && s.vol >= 0 && s.vol <= MAX_VOL;
  }

  function validateGenesis(g) {
    const errs = [];
    if (!g || typeof g !== 'object') return ['genesis 없음'];
    if (!isStr(g.seed, 200) || !g.seed) errs.push('seed');
    if (!isNum(g.start)) errs.push('start');
    if (g.schedule !== undefined) {
      if (!Array.isArray(g.schedule) || !g.schedule.length || g.schedule.length > 48 ||
          !g.schedule.every((m) => Number.isInteger(m) && m >= 0 && m < 1440) ||
          new Set(g.schedule).size !== g.schedule.length) errs.push('schedule');
    } else if (!isNum(g.periodMin) || g.periodMin < 1) errs.push('periodMin');
    if (!isNum(g.dailyLimitPct) || g.dailyLimitPct <= 0 || g.dailyLimitPct > 100) errs.push('dailyLimitPct');
    if (!Array.isArray(g.stocks) || !g.stocks.length) errs.push('stocks');
    else g.stocks.forEach((s, i) => { if (!validStock(s)) errs.push('stocks[' + i + ']'); });
    return errs;
  }

  function sortEvents(events) {
    return events.slice().sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /**
   * simulate(genesis, events, now) → market state at `now`.
   * events: [{id, at, type, payload, reason, actor}] (untrusted; invalid ones are skipped and reported)
   */
  function simulate(genesis, events, now, opts) {
    opts = opts || {};
    const gErr = validateGenesis(genesis);
    if (gErr.length) throw new Error('잘못된 genesis: ' + gErr.join(', '));
    const L = genesis.dailyLimitPct;
    const seed = genesis.seed;
    const keepHistory = opts.history !== false;

    const stocks = new Map();
    const order = [];
    function addStock(def, t) {
      const s = {
        code: def.code, name: def.name.trim(), sector: isStr(def.sector, 30) ? def.sector : '',
        description: isStr(def.description, 1000) ? def.description : '',
        initial: def.initial, vol: def.vol, price: def.initial, prev: def.initial,
        ref: def.initial, refDay: kstDay(t), listedAt: t, updates: 0,
        history: keepHistory ? [{ t, p: def.initial, k: 'list' }] : null,
      };
      stocks.set(def.code, s); order.push(def.code);
    }
    genesis.stocks.forEach((d) => addStock(d, genesis.start));

    let halted = false;
    const applied = [], skipped = [];
    const manualSlots = new Set();
    // update boundaries: fixed KST times of day (schedule) or every periodMin from start
    const bounds = [];
    let nextB = null;
    (function gen() {
      const until = now;
      if (genesis.schedule) {
        const mins = genesis.schedule.slice().sort((a, b) => a - b);
        for (let d = kstDay(genesis.start); ; d++) {
          const base = d * DAY - KST_OFFSET;
          for (const m of mins) {
            const b = base + m * MIN;
            if (b <= genesis.start) continue;
            if (b > until) { nextB = b; return; }
            bounds.push(b);
          }
        }
      } else {
        const P = genesis.periodMin * MIN;
        for (let k = 1; ; k++) { const b = genesis.start + k * P; if (b > until) { nextB = b; return; } bounds.push(b); }
      }
    })();
    const slotOf = (t) => { let lo = 0, hi = bounds.length; while (lo < hi) { const m = (lo + hi) >> 1; if (bounds[m] <= t) lo = m + 1; else hi = m; } return lo; };

    const news = [];
    const r4 = (x) => Math.round(x * 10000) / 10000;
    const fill = (tpl, s) => tpl.split('{n}').join(s.name);
    const span = (key, [a, b]) => a + unitRand(seed, key) * (b - a);
    function move(s, rate, t, kind, headline) {
      const day = kstDay(t);
      if (s.refDay !== day) { s.ref = s.price; s.refDay = day; }
      s.prev = s.price;
      s.price = nextPrice(s.price, rate, s.ref, L);
      s.updates++;
      if (s.history) s.history.push(headline ? { t, p: s.price, k: kind, r: rate, n: headline } : { t, p: s.price, k: kind, r: rate });
    }
    // deterministic news roll for stock s at scheduled update number k
    function rollNews(s, c, k) {
      const T = NEWS[c] || NEWS._;
      const st = s.story;
      if (st) {
        if (k < st.resolveK) return null;
        s.story = null;
        const ok = unitRand(seed, c + ':res:' + k) < 0.5;
        const eff = r4((ok ? 1 : -1) * span(c + ':rese:' + k, EFF.big));
        return { kind: ok ? 'success' : 'fail', eff, headline: fill(ok ? st.t.ok : st.t.ng, s) };
      }
      const r = unitRand(seed, c + ':nw:' + k);
      if (r < NEWS_P.story) {
        let ti = Math.floor(unitRand(seed, c + ':st:' + k) * T.stories.length);
        if (T.stories.length > 1 && ti === s.lastStory) ti = (ti + 1) % T.stories.length; // no back-to-back repeat
        const t = T.stories[ti]; s.lastStory = ti;
        s.story = { t, resolveK: k + 1 + Math.floor(unitRand(seed, c + ':rk:' + k) * 2) };
        return { kind: 'setup', eff: r4(span(c + ':ge:' + k, EFF.go)), headline: fill(t.go, s) };
      }
      if (r < NEWS_P.story + NEWS_P.single) {
        const up = unitRand(seed, c + ':sd:' + k) < 0.5, list = up ? T.up : T.down;
        const h = list[Math.floor(unitRand(seed, c + ':sp:' + k) * list.length)];
        return { kind: 'single', eff: r4((up ? 1 : -1) * span(c + ':se:' + k, EFF.single)), headline: fill(h, s) };
      }
      return null;
    }
    function publish(s, t, item) {
      news.push({ t, code: s.code, name: s.name, kind: item.kind, effect: item.eff, headline: item.headline, price: s.price, prev: s.prev });
    }

    function applyEvent(e) {
      const p = e.payload || {};
      const s = p.code ? stocks.get(p.code) : null;
      switch (e.type) {
        case 'halt': if (halted) return 'already halted'; halted = true; return null;
        case 'resume': if (!halted) return 'not halted'; halted = false; return null;
        case 'tick': {
          if (halted) return 'market halted';
          const slot = slotOf(e.at);
          if (manualSlots.has(slot)) return 'duplicate manual update in same slot';
          manualSlots.add(slot);
          order.forEach((c) => { const st = stocks.get(c); move(st, randomRate(seed, c + ':m:' + slot, st.vol), e.at, 'manual'); });
          return null;
        }
        case 'set_price': {
          if (!s) return 'unknown code';
          if (!isNum(p.price) || p.price < 1 || p.price > MAX_PRICE || Math.round(p.price) !== p.price) return 'bad price';
          s.prev = s.price; s.price = p.price; s.ref = p.price; s.refDay = kstDay(e.at);
          if (s.history) s.history.push({ t: e.at, p: s.price, k: 'admin' });
          return null;
        }
        case 'set_vol': {
          if (!s) return 'unknown code';
          if (!isNum(p.vol) || p.vol < 0 || p.vol > MAX_VOL) return 'bad vol';
          s.vol = p.vol; return null;
        }
        case 'update_info': {
          if (!s) return 'unknown code';
          if (p.name !== undefined) { if (!isStr(p.name, 60) || !p.name.trim()) return 'bad name'; s.name = p.name.trim(); }
          if (p.sector !== undefined) { if (!isStr(p.sector, 30)) return 'bad sector'; s.sector = p.sector; }
          if (p.description !== undefined) { if (!isStr(p.description, 1000)) return 'bad description'; s.description = p.description; }
          return null;
        }
        case 'news': {
          if (halted) return 'market halted';
          if (!s) return 'unknown code';
          if (!isStr(p.headline, 100) || !p.headline.trim()) return 'bad headline';
          if (!isNum(p.effect) || p.effect < -20 || p.effect > 20) return 'bad effect';
          const h = p.headline.trim();
          move(s, r4(p.effect), e.at, 'news', h);
          publish(s, e.at, { kind: 'admin', eff: r4(p.effect), headline: h });
          return null;
        }
        case 'list': {
          if (!validStock(p)) return 'bad stock';
          if (stocks.has(p.code)) return 'code exists';
          addStock(p, e.at); return null;
        }
        default: return 'unknown type';
      }
    }

    const evs = sortEvents((events || []).filter((e) => e && isNum(e.at) && typeof e.type === 'string' && e.at >= genesis.start));
    let ei = 0;
    const drain = (until) => { while (ei < evs.length && evs[ei].at < until) { const e = evs[ei++]; const why = applyEvent(e); (why ? skipped : applied).push(why ? { e, why } : e); } };
    bounds.forEach((B, i) => {
      drain(B); // events strictly before boundary
      if (!halted) order.forEach((c) => {
        const s = stocks.get(c); if (s.listedAt >= B) return;
        const k = i + 1, item = rollNews(s, c, k);
        const rate = r4(randomRate(seed, c + ':' + k, s.vol) + (item ? item.eff : 0));
        move(s, rate, B, item ? 'news' : 'auto', item && item.headline);
        if (item) publish(s, B, item);
      });
    });
    drain(now + 1); // events up to now; future ones wait
    const lastSlot = bounds.length;
    // events exactly in the future are ignored until their time

    const today = kstDay(now);
    const list = order.map((c) => {
      const s = stocks.get(c);
      const prevClose = s.refDay === today ? s.ref : s.price;
      const lim = limits(prevClose, L);
      return Object.assign(s, { prevClose, change: s.price - prevClose, changePct: prevClose ? (s.price / prevClose - 1) * 100 : 0, limitLo: lim.lo, limitHi: lim.hi });
    });
    return {
      stocks: list, halted, applied, skipped, news: news.reverse(),
      slot: lastSlot, slotStart: lastSlot ? bounds[lastSlot - 1] : genesis.start,
      nextUpdate: nextB, periodMs: nextB - (lastSlot ? bounds[lastSlot - 1] : genesis.start), dailyLimitPct: L,
    };
  }

  const api = { NEWS, simulate, nextPrice, limits, randomRate, kstDay, validateGenesis, cyrb53, MAX_VOL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ComEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
