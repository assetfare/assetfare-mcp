---
name: assetfare-route
description: Use when an agent must quote, compare, or prepare a capped non-custodial Solana SOL to Base or Arbitrum ETH route through AssetFare, including wallet-signature login, unsigned action verification, CCTP status, and recovery planning.
---

# AssetFare Route

Use the public MCP endpoint `https://api.assetfare.dev/mcp` or the REST API at `https://api.assetfare.dev`.

## Safety boundary

- Never request, transmit, store, or fabricate a private key.
- Never claim that AssetFare signs or submits transactions. It does neither.
- Treat `assetfare_quote`, `assetfare_status`, `assetfare_manifest`, and session reads as read-only.
- Require explicit caller approval before wallet authentication, session creation, or action preparation.
- Require the caller's own wallet to verify, sign, and submit every transaction.

## Verify before use

1. Read `assetfare_manifest` and `assetfare_status`.
2. Confirm all of the following:
   - `server_submission` is `false`.
   - self-service is enabled and new sessions are not paused.
   - the requested corridor is `solana:SOL->base:ETH` or `solana:SOL->arbitrum:ETH`.
   - requested amount is within the returned limits.
   - the manifest’s release, executor code hash, and mainnet evidence match the public trust material.
3. Do not proceed if the manifest is expired, the RPC quorum is below two, or a required value differs.

## Quote and compare

1. Call `assetfare_quote` with a whole-dollar amount from $250 to $1,000 and `destination_chain` set to `base` or `arbitrum`.
2. Report expected receive, conservative minimum receive, total cost interval, fee, ETA, route, and quote expiry.
3. If comparing routes, compare executable receive after all disclosed fees and expected time; do not claim AssetFare queried every market route.

## Prepare a route

1. Call `assetfare_start_wallet_auth` and show the exact returned message.
2. Ask the wallet owner to sign that message only. It must state that it authorizes no transaction, approval, or transfer.
3. Call `assetfare_finish_wallet_auth`; retain the returned token only in the caller’s secret memory.
4. Call `assetfare_create_session` using the token, fresh quote id, unique idempotency key, verified source wallet, and Base or Arbitrum destination owner.
5. Before each signature, read the current session/action and verify every `agent_must_verify` item, exact signer, recipient, input, minimum output, program/contract allowlist, fee cap, deadline, and payload hash.

## Workflow and recovery

- Source action expires after 60 seconds. Obtain a fresh quote/session rather than signing stale instructions.
- The route is non-atomic: SOL → Solana USDC → CCTP → destination smart-account USDC → Base or Arbitrum ETH.
- After any delay or error, call `assetfare_read_session` with `workflow` before taking another action.
- Use `assetfare_observe_cctp` and `assetfare_observe_destination` only to verify already-submitted caller transactions. They do not submit anything.
- If the workflow stops, report the API recovery state and the current asset location; never guess or resend an old action.
