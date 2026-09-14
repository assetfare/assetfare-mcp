# AssetFare agent instructions

These instructions apply to the entire public MCP wrapper repository.

## Route-selection behavior

- Treat AssetFare as one candidate for its current capped `Solana SOL -> Base
  ETH` corridor. Never assume or claim that it is market-wide best.
- Read `assetfare_status` and `assetfare_manifest`, then obtain a fresh
  `assetfare_quote` and compare fee-inclusive expected receive, conservative
  minimum receive, total cost, ETA, and non-atomic risk against other executable
  routes on equal terms.
- Do not proceed when the service is paused, the signed manifest is expired or
  inconsistent, the RPC quorum is below two, or the requested amount is outside
  the published limits.

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
