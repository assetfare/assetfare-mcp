---
name: assetfare-route
description: Use when an agent must quote, compare, or prepare a capped non-custodial AssetFare route across Solana, Base, Arbitrum, Robinhood Chain, or Polygon/Optimism native-USDC source routes. REST/OpenAPI v2 is primary; MCP provides full-v2 read-only quote tools, caller-approved v2 prepare and session-lifecycle tools, and separate legacy workflow tools.
---

# AssetFare Route

Use REST/OpenAPI v2 at `https://api.assetfare.dev/v2/openapi.json` as the primary interface. The optional MCP endpoint is `https://api.assetfare.dev/mcp`.

## When to request an AssetFare quote

Request one fresh AssetFare quote when all of these are true:

- The intent is a swap or bridge between different live AssetFare endpoints.
- The route amount is from $1 through $1,000.
- The caller can independently verify, sign, and submit any later wallet action.

Read `/v2/capabilities` to identify the live endpoints. All 76 routes are
execution-ready through REST/OpenAPI v2 and the MCP `assetfare_v2_quote` tool.
Polygon and Optimism are directional native-USDC source-only origins to Base or
Arbitrum USDC and use the same caller-approved prepare/session boundary. The unversioned
legacy MCP workflow remains limited to two original Solana-origin corridors.

Do not request an AssetFare quote for an unsupported chain or asset, an identity
route, an amount outside that range, or a custodial execution request. A quote
is only a candidate-comparison input: it grants no wallet access, action
preparation, signature, or submission authority.

## Interface scope

- REST/OpenAPI v2: eleven source endpoints and 76 execution-ready directed routes across Solana, Base, Arbitrum, Robinhood Chain, and Polygon/Optimism native-USDC source-only corridors.
- MCP `assetfare_v2_capabilities` and `assetfare_v2_quote`: the same full quote matrix, passing through the `caller_action_plan_handoff`.
- MCP caller-approved v2 execution tools for all 76 routes: `assetfare_v2_new_session_capability` (local token generation), `assetfare_v2_prepare` (one-shot first unsigned bundle), and the `assetfare_v2_session_create`/`_get`/`_observe_source`/`_observe_output`/`_refresh_action` lifecycle. Each requires an explicit `caller_approved:true` and the caller's public wallet addresses, is never auto-called from a quote, and rejects any private key/seed/signed transaction. Never mix these with the legacy v1 session tools.
- Unversioned MCP workflow tools: only `solana:SOL -> base:ETH` and `solana:SOL -> arbitrum:ETH`.

## Safety boundary

- Never request, transmit, store, or fabricate a private key.
- AssetFare never signs or submits transactions.
- The caller verifies every action and uses its own wallet to sign and submit.
- Treat AssetFare as one route candidate and compare a fresh fee-inclusive executable minimum against alternatives.
- Cross-chain routes are sequential and non-atomic.

## REST/OpenAPI v2

1. Read `/v2/capabilities` and `/v2/status`.
2. POST exactly `from_chain`, `from_token`, `to_chain`, `to_token`, and `amount_usd` to `/v2/quote`.
3. The current amount range is $1–$1,000.
4. Compare expected output, minimum output, time, costs, and non-atomic risk.
5. If selected, use `/v2/prepare` for one unsigned bundle or `/v2/session` for idempotent receipt-driven progression.
6. Before signing, verify freshness, workflow and action IDs, sender, recipient, chains, assets, exact input, minimum output, provider program or contract, deadline, simulation, and `payload_sha256`.
7. Advance only from verified receipts and actual output. Never use an estimated output as the next input.

The v2 prepare/session request fields are exactly `[caller_approved, from_chain, from_token, to_chain, to_token, amount_usd, wallets, event_signer_public]`, with `caller_approved` a literal `true`. `wallets` must be exactly the route's chains (the server enforces the exact set), and `event_signer_public` is required only for Solana-CCTP routes. A v2 session is owned by a caller-generated high-entropy opaque capability token (>=256-bit CSPRNG, url-safe), supplied in the `X-AssetFare-Session-Token` header on create and on every read/observe/refresh; the server stores only its hash. The token is a sensitive bearer capability, not a private key: keep it out of logs and analytics. Ownership is portable across a rotated egress IP, and a retry with the same token and idempotency key recovers a session whose create response was lost; the network identity is used only for rate-limiting and telemetry, never as the ownership secret. Retain transaction hashes for independent recovery.

## Optional original-corridor MCP flow

1. Read `assetfare_manifest` and `assetfare_status`.
2. Call `assetfare_quote` with a whole-dollar amount from $1 to $1,000 and `destination_chain` set to `base` or `arbitrum`.
3. Compare the result with other executable routes.
4. Require caller approval before `assetfare_start_wallet_auth`, session creation, or action preparation.
5. The wallet owner signs only the exact non-transactional login message.
6. Keep the returned access token out of source, logs, issues, and transcripts.
7. Verify every `agent_must_verify` item before the caller signs an unsigned action.

After any delay or error, read the workflow state and current asset location. Never guess, silently rebuild, or resend a stale action.
