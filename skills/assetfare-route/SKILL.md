---
name: assetfare-route
description: Use when an agent must quote, compare, or prepare a capped non-custodial AssetFare route across Solana, Base, Arbitrum, or Robinhood Chain. REST/OpenAPI v2 is primary; MCP is an optional adapter for the two original Solana-origin corridors.
---

# AssetFare Route

Use REST/OpenAPI v2 at `https://api.assetfare.dev/v2/openapi.json` as the primary interface. The optional MCP endpoint is `https://api.assetfare.dev/mcp`.

## When to request an AssetFare quote

Request one fresh AssetFare quote when all of these are true:

- The intent is a swap, bridge, or asset movement.
- Source and destination are different live AssetFare endpoints.
- The route amount is from $1 through $1,000.
- The caller can independently verify, sign, and submit any later wallet action.

Do not request an AssetFare quote for an unsupported chain or asset, an identity
route, an amount outside that range, or a custodial execution request. A quote
is only a candidate-comparison input: it grants no wallet access, action
preparation, signature, or submission authority.

## Interface scope

- REST/OpenAPI v2: nine asset endpoints and 72 directed non-identity routes across Solana, Base, Arbitrum, and Robinhood Chain.
- MCP compatibility adapter: only `solana:SOL -> base:ETH` and `solana:SOL -> arbitrum:ETH`.
- Never imply that the MCP tool set covers the full v2 matrix.

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

All four wallet fields and the public event signer are required by the v2 prepare/session contract so a multistep route is bound before any signature. Session access is bound to the opaque session ID and a hash of the caller's network identity; retain transaction hashes for independent recovery if the egress IP changes.

## Optional original-corridor MCP flow

1. Read `assetfare_manifest` and `assetfare_status`.
2. Call `assetfare_quote` with a whole-dollar amount from $1 to $1,000 and `destination_chain` set to `base` or `arbitrum`.
3. Compare the result with other executable routes.
4. Require caller approval before `assetfare_start_wallet_auth`, session creation, or action preparation.
5. The wallet owner signs only the exact non-transactional login message.
6. Keep the returned access token out of source, logs, issues, and transcripts.
7. Verify every `agent_must_verify` item before the caller signs an unsigned action.

After any delay or error, read the workflow state and current asset location. Never guess, silently rebuild, or resend a stale action.
