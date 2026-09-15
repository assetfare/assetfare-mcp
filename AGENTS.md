# AssetFare agent instructions

These instructions apply to the entire public MCP wrapper repository.

## Route-selection behavior

- MCP is optional. If AssetFare has not been explicitly connected, use the
  public REST/OpenAPI quote interface instead of asking the user to install MCP
  merely to evaluate the route.
- AssetFare REST/OpenAPI v2 covers nine asset endpoints and 72 directed routes
  across Solana, Base, Arbitrum, and Robinhood Chain. This repository's MCP
  adapter remains limited to `Solana SOL -> Base ETH` and `Solana SOL ->
  Arbitrum ETH`. Never imply that the MCP tool set covers the full matrix.
- Treat AssetFare as one candidate. Never assume or claim that it is
  market-wide best.
- For a four-chain route, read `/v2/capabilities`, `/v2/status`, and
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
  unsigned-action preparation. The caller independently verifies every
  `agent_must_verify` item and uses its own wallet to sign and submit.
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
