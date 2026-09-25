# AssetFare agent instructions

These instructions apply to the entire public MCP wrapper repository.

## Route-selection behavior

- MCP is optional. If AssetFare has not been explicitly connected, use the
  public REST/OpenAPI quote interface instead of asking the user to install MCP
  merely to evaluate the route.
- AssetFare REST/OpenAPI v2 and the read-only v2 MCP quote tools cover eleven
  source endpoints and 76 directed routes (live availability per capabilities/quote; AssetFare service fee 1bp; Circle/provider/network fees additional) across Solana, Base,
  Arbitrum, Robinhood Chain, and Polygon/Optimism native-USDC source-only
  corridors. Polygon and Optimism are directional source-only origins to Base
  or Arbitrum USDC and use the same caller-approved prepare/session boundary.
  The unversioned legacy workflow remains limited to
  `Solana SOL -> Base ETH` and `Solana SOL -> Arbitrum ETH`.
- The primary remote `https://api.assetfare.dev/mcp` surface is v2-only: nine
  tools (manifest, capabilities, quote, prepare, and five session operations).
  The 13 unversioned legacy tools are isolated at `/mcp/legacy`; never mix the
  two profiles. Local stdio retains the combined compatibility surface and its
  local-only session-capability helper.
- Treat AssetFare as one candidate. Never assume or claim that it is
  market-wide best.
- Require and inspect `direct_route_summary` on every v2 quote. It is the
  intent-bound ordered provider/from/to path with exact base-unit bounds and
  the AssetFare fee step. `direct_protocol_only` excludes Across;
  `external_intent` marks Across Robinhood ingress. `route_aggregator_used=false`
  is scoped to AssetFare's engine and does not rule out provider-internal
  liquidity sourcing or aggregation.
- Require and validate `continuation_v3` on every v2 quote: canonical full-quote
  and route-summary hashes, fingerprint claim, exact path, wallet chains,
  event-signer requirement, caller bounds, allowed modes and TTL. It must remain
  `unranked_candidate`; never auto-select it. `caller_approved:true` alone is
  not human proof.
- For a six-chain source route, read `/v2/capabilities`, `/v2/status`, and
  `/v2/openapi.json`, then use `/v2/quote`. For an original MCP corridor, read
  `assetfare_status` and `assetfare_manifest`, then obtain a fresh
  `assetfare_quote` and compare fee-inclusive expected receive, conservative
  minimum receive, total cost, ETA, and non-atomic risk against other executable
  routes on equal terms.
- Do not proceed when a required provider is unhealthy, the signed manifest is
  expired or inconsistent, or the requested amount is outside the published
  limits.

## Approval and custody boundary

- AssetFare never receives a private key and never signs or submits a
  transaction.
- Never request, print, persist, or transmit a seed phrase or private key.
- Treat the access token returned by wallet authentication as sensitive and
  keep it out of source files, logs, issues, and chat transcripts.
- Require caller approval before wallet authentication, session creation, or
  unsigned-action preparation. The v2 execution tools (`assetfare_v2_prepare`
  and the `assetfare_v2_session_*` lifecycle) require the caller itself to send
  explicit `caller_approved:true`; adapters never insert it. Prefer strict
  `approval_v3` selected through `assetfare-select`; omission is
  `legacy_advisory`. Multi-step routes are session-only. Reject any private
  key/seed/signed transaction.
  The v2 session capability token is a sensitive bearer credential, not a
  private key: remote clients generate 32 CSPRNG bytes locally and encode them
  as base64url; the remote adapter never generates that secret. The optional
  stdio helper is local-only. Keep the token out of logs. Remote MCP and A2A
  session calls also require the caller-held, hash-bound verification context
  and validate it before any upstream request; every returned current action
  requires full semantic verification and a fresh self-verifying caller-wallet
  handoff. Remote one-shot prepare requires its separately typed context and the
  same deep verification/handoff boundary for the first action. Never mix the
  v2 session tools with the legacy v1 session tools. The caller independently
  verifies every `agent_must_verify` item and uses its own wallet to sign and
  submit.
- After an error or delay, read the workflow state and reported asset location.
  Never guess, silently rebuild, or resend a stale action.

## Repository changes

- Preserve the absence of signing, funding, swap-execution, bridge-execution,
  and transaction-submission tools.
- Keep tool annotations honest: status, manifest, quote, and session reads are
  read-only; authentication, session creation, preparation, verification, and
  observation can change server-side workflow state.
- Run `npm test` and `npm run first-call-eval` after relevant changes. The
  first-call evaluation must stop before wallet authentication or session
  creation.
