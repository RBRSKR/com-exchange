// Builds _site/ (index.html + admin.html + data.json) from market.json and the secret MARKET_SEED.
// data.json is the backup copy; the live site reads prices from the Cloudflare Worker (worker/index.js).
const fs = require('fs'), path = require('path');
const { computeMarket } = require('../lib/market.js');
const root = path.join(__dirname, '..');
const fail = (m) => { console.error('::error::' + m); process.exit(1); };

if (!process.env.MARKET_SEED || process.env.MARKET_SEED.length < 16) fail('MARKET_SEED 시크릿이 없습니다. 저장소 Settings → Secrets and variables → Actions 에 추가하세요.');
let cfg;
try { cfg = JSON.parse(fs.readFileSync(path.join(root, 'market.json'), 'utf8')); } catch (e) { fail('market.json 형식이 잘못됐습니다: ' + e.message); }
let res;
try { res = computeMarket(cfg, process.env.MARKET_SEED, Date.now()); } catch (e) { fail(e.message); }
res.warnings.forEach((w) => console.log('::warning::' + w));
const { out } = res, sim = out.sim;
const site = path.join(root, '_site');
fs.mkdirSync(site, { recursive: true });
fs.copyFileSync(path.join(root, 'index.html'), path.join(site, 'index.html'));
fs.copyFileSync(path.join(root, 'admin.html'), path.join(site, 'admin.html'));
fs.writeFileSync(path.join(site, 'data.json'), JSON.stringify(out));
console.log('시세 ' + new Date(out.generatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) + ' 기준 · ' + (sim.halted ? '시장 중지' : '운영 중') + ' · ' +
  sim.stocks.map((s) => s.code + ' ' + s.price).join(', ') + ' · 뉴스 ' + sim.news.length + '건');
