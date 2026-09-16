# AssetFare × Agenti quote-only tools 독립 검토 (Claude)

- 일시: 2026-09-16T15:10:30Z · 검토자: Claude (독립 검토자)
- 요청서: `CLAUDE_REVIEW_REQUEST_20260916.md`
- 방식: **읽기 전용**. 시크릿·env·wallet·npm token 미접근. 라이브 quote·인증·세션·prepare·서명·
  전송·실거래·외부 issue/PR/publish 없음. 격리 실행 + mock fetch만. 원본 미수정.
- 대상: `@assetfare/agenti-route-tools@0.1.0` (`src/index.ts`, `src/index.test.ts`, `README.md`, `package.json`, dist)

---

## 판정: **GO**

- Vercel AI SDK 4 `tool()` + zod 3 인터페이스와 tsc 호환되고, 읽기 전용 2-tool로 Agenti wallet·
  private key·signer를 받거나 읽지 않으며, 응답 스키마·크기·오류 가드가 fail-closed입니다.
- **공개 reference 및 Agenti #138 후속 제안 진행 가능.**

### 심각도별 건수
| Critical | High | Medium | Low | Informational |
|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 1 (비차단) |

---

## 점검 결과 (요청 1~8)

1. **Vercel AI SDK 4 + zod 3 호환 — PASS.** `import { tool } from "ai"`, `tool({description,
   parameters, execute})` 패턴, zod v3 idiom(`z.ZodIssueCode.custom`·`.passthrough()`·
   `z.record(z.unknown())`). peerDeps `ai >=4<5`·`zod >=3.23<4`, dev `ai@4.3.19`·`zod@3.25.76`.
   `npm run check`(tsc --noEmit) exit 0, `npm run build` exit 0.
2. **2 tool·Agenti 지갑/키/서명자 미접근 — PASS.** `assetfareGetCapabilities`·`assetfareQuoteRoute`
   뿐. execute는 `client.capabilities()`/`client.quote()`→`request()`만 호출. wallet·getSetting·
   private key·signer 수신/읽기 **없음**(execute는 wallet 인자조차 받지 않음). 소스·dist 모두 실제
   접근 호출 0(‘wallet’은 설명·`walletAccessed:false` 플래그뿐). 테스트 "Vercel tools add only
   capability and quote functions"가 sign/submit/fund/bridge tool 부재를 검증.
3. **5필드 POST·9 endpoint·identity·$1–$1,000 — PASS.** body = from_chain/from_token/to_chain/
   to_token/amount_usd(정확히 5). `AssetFareQuoteSchema` strict + superRefine으로 9 endpoint 멤버십·
   identity 거부, `amountUsd finite().min(1).max(1000)`. execute 진입 시 SDK 검증 + `client.quote`
   내부 `.parse()` 재검증(이중).
4. **signing/submission false·execution supported fail-closed — PASS.** `QuoteSchema`: status
   literal, execution.supported literal true, risk.server_signing/submission literal false. 미충족 시
   parse throw → "outside the capped public safety boundary". capabilities/status도 동일 literal.
5. **45s timeout·1MiB 가드·오류 래핑·응답 schema — PASS.** `AbortSignal.timeout(45_000)`,
   content-length 가드 + `TextEncoder` 실측 바이트 가드(1,048,576), fetch try/catch(네트워크),
   JSON.parse try/catch + 배열·비객체 거부(비JSON).
6. **자동선택·prepare·sign·submit 미유도 — PASS.** quote 결과에 `guidance{compareWithOtherRoutes:
   true, walletAccessed:false, actionPrepared:false, transactionSigned:false, transactionSubmitted:
   false}`. tool description "never authenticate, prepare, sign, submit, swap, or bridge". README
   "installation never implies preference / Phase 2 execution은 별도 승인·caller-signed".
7. **package/pack/prod dep·비밀 노출 — PASS.** `files:["dist","README.md"]` → `npm pack --dry-run`
   **4파일**(README, dist/index.d.ts, dist/index.js, package.json), src·test·시크릿 미포함.
   `npm audit --omit=dev` → **0 vulnerabilities**. MIT.
8. **재현 — 전부 통과.** check 0 / build 0 / **test 5/5**(schema, 5필드, 2-tool-only, submission
   fail-closed, invalid+oversized fail-closed — 전부 mock fetch, 라이브 미호출) / audit 0 / pack 4파일.

## 발견 항목

### I-1 (Informational, 비차단) — content-length 없는 응답의 선버퍼링
1MiB 실측 가드가 `response.text()`로 본문을 다 읽은 뒤 측정 → content-length 생략 서버가 초대형
본문을 보내면 거부 전 버퍼링 가능. content-length 가드·45s timeout·신뢰 호스트·quote-only 특성상
위험 낮음. 스트리밍 누적 컷오프로 강화 가능(선택). (SendAI·elizaOS 어댑터와 동일 성격의 잔여.)

## 결론
Vercel AI SDK 4 + zod 3과 호환되고 Agenti 지갑·키·서명자에 접근하지 않으며 fail-closed 경계가
견고합니다. 5개 테스트·audit(0)·pack(4파일) 모두 통과. **GO** — 공개 reference와 Agenti #138 후속
제안 진행 가능. I-1은 선택적 방어 강화일 뿐 차단 요인이 아닙니다.

## 서명·전송·비밀 취급 확인
시크릿·env·wallet·npm token을 열지 않았고, 라이브 quote·인증·세션·prepare·서명·전송·실거래·외부
issue/PR/publish를 수행하지 않았으며, 원본을 수정하지 않았습니다. 격리 실행 + mock만 사용했습니다.
