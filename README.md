# COM EXCHANGE

디스코드 서버 가상화폐 COM으로 운영하는 가상 증권거래소 시세 사이트입니다. 모든 종목은 실제 기업이 아닌 가상 종목입니다.

- 가격은 매일 **08:00 · 17:00 · 22:00 (KST)** 에 GitHub가 자동으로 계산해서 사이트에 올립니다.
- 앞으로의 가격을 정하는 시드는 `MARKET_SEED` 시크릿에 숨겨져 있어서, 사이트에는 **이미 지난 가격만** 공개됩니다.
- 이 사이트는 COM 봇과 연결되어 있지 않습니다. 매매와 COM 지급은 디스코드에서 사되가 직접 처리합니다.

## 처음 한 번만 설정

1. **Settings → Pages → Source** 를 `GitHub Actions` 로 바꾸기
2. **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `MARKET_SEED`
   - Secret: 받은 시드 문자열 붙여넣기 (아무에게도 보여 주지 말 것)
3. **Actions** 탭 → `시세 갱신` → `Run workflow` 로 한 번 실행

## 시장 관리 (휴대폰으로도 가능)

GitHub에서 `market.json` 을 열고 연필 아이콘으로 수정한 뒤 **Commit changes** 를 누르면 1~2분 뒤 사이트에 반영됩니다.
`events` 목록 맨 끝에 한 줄을 추가하면 됩니다. 앞줄 끝에 쉼표(`,`)를 꼭 붙이세요. 시각은 한국 시간이고, **지금보다 미래 시각**으로 적으면 그 시각에 적용됩니다.

| 하고 싶은 일 | 추가할 줄 |
|---|---|
| 시장 멈추기 | `{ "at": "2026-11-18 12:00", "type": "halt" }` |
| 시장 다시 열기 | `{ "at": "2026-11-18 12:00", "type": "resume" }` |
| 뉴스(특보) 내기 | `{ "at": "2026-11-18 12:00", "type": "news", "code": "SAI", "headline": "사되 AI, 직업 대체 AI 개발 성공!", "effect": 10 }` |
| 가격 직접 바꾸기 | `{ "at": "2026-11-18 12:00", "type": "set_price", "code": "CCI", "price": 600, "reason": "이유" }` |
| 변동폭 바꾸기 | `{ "at": "2026-11-18 12:00", "type": "set_vol", "code": "RIM", "vol": 2.5 }` |

- `effect` 는 -20 ~ +20 (%), 하루 ±15% 제한 안에서 움직입니다.
- 이미 지난 시각으로 적거나 지난 줄을 지우면 **과거 가격이 바뀝니다.** 하지 마세요.
- 공지는 `notices` 에 `{ "title": "제목", "body": "내용", "pinned": true, "at": "2026-11-18 12:00" }` 처럼 추가합니다.
- 실수하면 Actions 탭에 빨간 X가 뜨고 사이트는 이전 상태로 유지됩니다.

## 파일

- `index.html` — 사이트 화면
- `engine.js` — 가격·뉴스 계산 엔진 (`engine.test.js` 로 자동 테스트)
- `market.json` — 종목, 일정, 관리 기록, 공지
- `scripts/build-data.js` — 시세 계산 후 `_site/data.json` 생성
- `.github/workflows/pages.yml` — 자동 갱신 일정
