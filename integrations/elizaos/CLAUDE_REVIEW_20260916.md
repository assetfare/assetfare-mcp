# AssetFare × elizaOS quote-only 플러그인 독립 검토 (Claude)

- 일시: 2026-09-16T14:58:40Z · 검토자: Claude (독립 검토자)
- 요청서: `CLAUDE_REVIEW_REQUEST_20260916.md`
- 방식: **읽기 전용**. 시크릿·env·wallet·npm token 미접근. 라이브 quote·인증·세션·prepare·서명·
  전송·실거래·외부 issue/PR/publish 없음. 격리 실행 + mock fetch/mock runtime만. 원본 미수정.
- 대상: `@assetfare/elizaos-route-plugin@0.1.0` (`src/index.ts`, `src/index.test.ts`, `README.md`, `package.json`, dist)

---

## 판정: **GO**

- 읽기 전용 2-action 구조로 elizaOS 런타임 지갑·설정·서명자에 접근하지 않고, `@elizaos/core@1.7.2`·
  zod 4.3.5와 tsc 호환되며, 응답 스키마 검증·크기/오류 가드가 fail-closed입니다.
- **공개 reference 및 elizaOS maintainer 제안 진행 가능.**

### 심각도별 건수
| Critical | High | Medium | Low | Informational |
|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 1 (비차단) |

---

## 점검 결과 (요청 1~9)

1. **타입 호환 — PASS.** `Plugin`{name,description,actions}·`Action`{name,similes,description,
   validate,handler,examples}·`ActionResult`{success,text?,data?,error?}·`ModelType.OBJECT_SMALL`
   사용. `npm run check`(tsc --noEmit) exit 0, `npm run build` exit 0 → core 1.7.2 + zod 4.3.5 호환.
2. **2 action·런타임 지갑/설정/서명자 미접근 — PASS.** action은 `ASSETFARE_GET_CAPABILITIES`·
   `ASSETFARE_QUOTE_ROUTE`뿐. quote 핸들러는 `runtime.composeState`·`runtime.useModel`(intent 추출)만
   사용하고 **`getSetting`·wallet·private key·signer·swap/bridge 실행 없음**. 소스·dist 모두 실제 접근
   호출 0건(‘wallet’ 등장은 설명 문자열·`walletAccessed:false` 플래그뿐). 테스트 "sends five fields
   and never reads wallet settings"가 Proxy 런타임으로 설정 접근 부재를 검증.
3. **OBJECT_SMALL 산출물 zod 재검증·9 endpoint·identity·$1–$1,000 — PASS.** useModel 결과를
   `AssetFareQuoteIntentSchema.parse()`로 재검증(strict). `TOKENS_BY_CHAIN`로 9 endpoint 멤버십 강제,
   identity 경로 거부, `amountUsd finite().min(1).max(1000)`. parse 실패 시 `success:false`로 fail-closed.
4. **POST 5필드·literal schema — PASS.** body = from_chain/from_token/to_chain/to_token/amount_usd
   (정확히 5). `QuoteSchema`: `status` literal, `execution.supported` literal true, `risk.server_signing`/
   `server_submission` literal false(zod v4 `.loose()`). 미충족 시 parse throw → fail-closed.
5. **45s timeout·1MiB 이중 가드·오류 래핑 — PASS.** `AbortSignal.timeout(45_000)`, content-length
   가드 + `TextEncoder` 실측 바이트 가드(1,048,576), fetch try/catch(네트워크), JSON.parse try/catch
   + 배열·비객체 거부(비JSON).
6. **quote 후 중단·자동선택/prepare/sign/submit 미유도 — PASS.** 핸들러는 quote 뒤
   `guidance{compareWithOtherRoutes:true, walletAccessed:false, actionPrepared:false,
   transactionSigned:false, transactionSubmitted:false}`와 함께 반환·callback 후 종료. prepare/session/
   sign/submit 호출 없음.
7. **squid-router 공백 서술 정확 — PASS.** README가 `@elizaos/plugin-squid-router`의 Solana↔EVM
   공백(플러그인 README상 Solana "계획 중", 실행부는 EVM signer 획득)을 정확히 기술하고, AssetFare가
   Solana SOL/USDC/USDG → Base/Arbitrum을 signer 없이 견적함을 명시. 공개 검색으로 squid-router가
   현재 EVM 전용·Solana 예정임을 교차 확인.
8. **peer/pack/audit — PASS.** peerDeps `@elizaos/core >=1.7.2<2`·`zod >=4.3.5<5`. `files:["dist",
   "README.md"]` → `npm pack --dry-run` **4파일**(README, dist/index.d.ts, dist/index.js, package.json),
   src·test·시크릿 미포함. `npm audit --omit=dev` → **0 vulnerabilities**. MIT.
9. **재현 — 전부 통과.** check exit 0 / build exit 0 / **test 5/5 pass**(intent schema, 2-action,
   5필드·지갑 미접근, submission 시 fail-closed, invalid+oversized fail-closed — 전부 mock fetch·
   mock runtime, 라이브 미호출) / audit 0 / pack 4파일.

## 발견 항목

### I-1 (Informational, 비차단) — content-length 없는 응답의 선(先)버퍼링
1MiB 실측 가드는 `response.text()`로 본문을 모두 읽은 뒤 측정하므로, content-length를 생략한 서버가
초대형 본문을 보내면 거부 전에 버퍼링될 수 있음. content-length 가드가 정직한 서버를 먼저 걸러주고
45s timeout·신뢰 기본 호스트(api.assetfare.dev)·quote-only 특성상 위험은 낮음. 스트리밍 누적 컷오프로
강화 가능(선택). (SendAI 어댑터와 동일 성격의 잔여 항목.)

## 결론
elizaOS 런타임과 타입 호환되고, 지갑·설정·서명자에 접근하지 않으며, 응답 스키마·크기·오류 가드가
fail-closed입니다. 5개 테스트·audit(0)·pack(4파일) 모두 통과. **GO** — 공개 reference와 elizaOS
maintainer 접촉 진행 가능. I-1은 선택적 방어 강화일 뿐 차단 요인이 아닙니다.

## 서명·전송·비밀 취급 확인
시크릿·env·wallet·npm token을 열지 않았고, 라이브 quote·인증·세션·prepare·서명·전송·실거래·외부
issue/PR/publish를 수행하지 않았으며, 원본을 수정하지 않았습니다. 격리 실행 + mock만 사용했습니다.
