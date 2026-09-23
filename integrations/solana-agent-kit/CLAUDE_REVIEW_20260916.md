# AssetFare × SendAI Solana Agent Kit 어댑터 독립 검토 (Claude)

> 보존된 과거 감사 기록: 이 문서는 `0.1.0`을 검토한 시점의 결과입니다.
> 현재 `0.1.1`은 유한한 USD 1 이상을 요구하되 어댑터 최대값은 두지 않습니다.
> 아래의 기존 최대값 관련 문구는 현재 계약이 아닙니다.

- 최초: 2026-09-16T13:51:16Z (GO) · **갱신: 2026-09-16T14:03:33Z (F-1~F-3 반영분 재검토, GO 유지)**
- 검토자: Claude (독립 검토자 역할)
- 요청서: `CLAUDE_REVIEW_REQUEST_20260916.md`
- 방식: **읽기 전용**. 개인키·seed·wallet bundle·npm token·운영 env·RPC credential 미접근.
  라이브 AssetFare quote·지갑 인증·세션·prepare·서명·전송·실거래·외부 issue/PR/publish 없음.
  격리 실행 + mock fetch만. 원본 미수정.
- 대상: `@assetfare/solana-agent-kit-plugin@0.1.0` (`src/index.ts`, `src/index.test.ts`, `README.md`, `package.json`, dist)

---

## 판정: **GO** (최종)

- 이전 GO 검토의 F-1~F-3 권고가 모두 반영됐고 회귀·신규 자금안전 이슈가 없습니다.
- 공개 reference implementation과 SendAI enhancement issue 제안을 **진행해도 됩니다.**

### 심각도별 건수 (갱신)
| 심각도 | 건수 |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 0 |
| Informational | 1 (I-1, 잔여·비차단) |

---

## F-1~F-3 반영 확인

- **F-1 응답 크기 제한 — 반영.** `MAX_RESPONSE_BYTES=1_048_576`(1MiB). 이중 가드:
  ① `content-length` 헤더가 유한하고 1MiB 초과면 즉시 throw, ② `response.text()` 후
  `TextEncoder().encode(text).byteLength`로 실측해 1MiB 초과면 throw(헤더 누락·허위 대비).
- **F-2 zod 응답 스키마 검증 — 반영.** `CapabilitiesResponseSchema`/`StatusResponseSchema`/
  `QuoteResponseSchema`가 `public_api_enabled`·`server_signing`·`server_submission`·`status`·
  `execution.supported`를 **zod literal**로 강제(`.passthrough()`). 핸들러가 원시 응답을
  parse하다 실패하면 안전경계 오류로 fail-closed. 이전의 수동 키 검사보다 강함.
- **F-3 네트워크·비JSON 오류 래핑 — 반영.** fetch 호출을 try/catch로 감싸
  "request failed before response"(+cause), `JSON.parse` 실패는 "returned invalid JSON for
  HTTP {status}"(+cause)로 래핑. 추가로 배열·비객체 JSON도 거부.

## 점검 결과 (요청서 1~10)

1. **타입 호환 — PASS.** `Plugin{name,methods,actions,initialize}`·`Action(=Action$1)` 일치.
   `npm run check`(tsc --noEmit) exit 0, `npm run build` exit 0 → 2.0.7 호환.
2. **공개 action 2개뿐 — PASS.** `ASSETFARE_GET_CAPABILITIES`·`ASSETFARE_QUOTE_ROUTE`만.
   order/prepare/signing/submission/funding/swap/bridge 없음. dist 빌드에도 동일.
3. **지갑/키/서명자 미접근 — PASS.** 핸들러 `_agent` 미사용. dist에 wallet/privateKey/signer/
   sendTransaction/signTransaction/Keypair 참조 0.
4. **quote 5필드·입력 경계·9 endpoint·identity 거부 — PASS (금액 상한 판정은 0.1.1에서 폐기).** 전송 필드 정확히 5개.
   현재 계약은 `amountUsd finite().min(1)`이며 어댑터 최대값이 없다. `TOKENS_BY_CHAIN`로 9 endpoint 강제, identity 거부,
   `.strict()`+핸들러 재파싱으로 fail-closed.
5. **서명/전송 false 아니면 실패 — PASS.** 응답 스키마 literal(false/true)로 강제, 미충족 시 throw.
6. **자동선택 유도 없음·동등 비교 — PASS.** description "Compare it with deBridge, Wormhole..."
   `agentGuidance.compareWithOtherRoutes=true`, README "installation never implies preference".
7. **입력 경계 — PASS.** 20s timeout, 네트워크 오류 래핑, 비JSON·비객체 거부, 1MiB 가드,
   `.strict()`로 스키마 우회·프로토타입 오염 벡터 차단.
8. **패키지/pack 범위 — PASS.** `files:["dist","README.md"]` → pack **4파일**(README,
   dist/index.d.ts, dist/index.js, package.json). src·test·dist-test·시크릿 미포함. MIT.
9. **재현 — 전부 통과.**
   - `npm run check` → exit 0
   - `npm run build` → exit 0
   - `npm test` → **6/6 pass**: schema 경계, action 2개, 5필드·지갑 미접근, fail-closed,
     **invalid JSON 래핑(신규)**, **oversized 거부(신규)** — 전부 mock fetch(라이브 미호출)
   - `npm audit --omit=dev` → **found 0 vulnerabilities**
   - `npm pack --dry-run` → 4 files
10. 공개 전 필수 결함: **없음**. I-1은 잔여 방어 개선(비차단).

## 발견 항목

### I-1 (Informational, 비차단) — content-length 없는 응답의 버퍼링
1MiB 실측 가드는 `response.text()`로 본문을 모두 읽은 뒤 측정하므로, content-length를 생략한
서버가 초대형 본문을 보내면 거부 전 메모리에 버퍼링될 수 있음. content-length 가드가 정직한
서버를 먼저 걸러주고 20s timeout·신뢰 기본 호스트(api.assetfare.dev)·quote-only 특성상 위험은
낮음. 완전 방어가 필요하면 스트리밍 누적 바이트 컷오프로 강화 가능(선택).

## 결론
F-1~F-3가 코드·테스트에 반영됐고, 6개 테스트·타입 호환·audit(0)·pack(4파일)이 모두 통과하며
읽기 전용·비수탁 경계에 회귀가 없습니다. **최종 GO** — 공개 reference와 SendAI enhancement
issue 진행 가능. I-1은 선택적 방어 강화일 뿐 차단 요인이 아닙니다.

## 서명·전송·비밀 취급 확인
개인키·seed·wallet bundle·npm token·운영 env·RPC credential을 열지 않았고, 라이브 quote·
지갑 인증·세션·prepare·서명·전송·실거래·외부 issue/PR/publish를 수행하지 않았으며, 원본을
수정하지 않았습니다. 격리 실행 + mock fetch만 사용했습니다.
