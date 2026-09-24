# AssetFare quote tools for Agenti

Project-reviewed concierge reference for Agenti's public roadmap item:

> `@agenti/plugin-bridge` — cross-chain: hold SOL, pay USDC on Base transparently

This Phase 1 package adds only two Vercel AI SDK 5 tools: live six-chain/76-route
capabilities and a fresh route quote, including Polygon and Optimism native-USDC source-only routes. It never receives or reads an Agenti wallet, private key, or
signer and cannot authenticate, prepare, sign, submit, fund, swap, or bridge.
Quote amounts must be finite and at least USD 1; this adapter imposes no
maximum, while live upstream availability and liquidity still apply.

## Verified direct path on every quote

The quote tool fails closed unless `quote.direct_route_summary` exactly
matches the requested intent and AssetFare's disclosed route contract. Agents
can show the ordered provider path and normalized `chain:asset` endpoints
directly from `steps`. The adapter also proves expected/minimum base-unit
amount continuity between steps and identifies the one exact step that charges
the AssetFare 1bp service fee.

`classification: direct_protocol_only` means every step uses a disclosed
direct protocol and excludes Across. `classification: external_intent` marks
Across Robinhood ingress; provider-internal liquidity sourcing or aggregation
can still occur there. `route_aggregator_used: false` describes AssetFare's
own routing engine only and must not be presented as a claim about every
provider's internals. Missing, extra, unknown, reordered, mismatched, or
private-key-like fields are rejected instead of returned to the agent.

```ts
import { agentiTools } from "@agenti/sdk/vercel-ai";
import { assetFareTools } from "@assetfare/agenti-route-tools";

const tools = {
  ...agentiTools(agentiConfig),
  ...assetFareTools(),
};
```

The quote description requires neutral comparison with other current routes.
An AssetFare installation never implies preference. Phase 2 execution mapping
must remain separately approved and caller-signed.

The package is a public reference and is not yet published to npm. The
[project review](./CLAUDE_REVIEW_20260916.md) (project-authored repository review, not independent third-party assurance) returned GO with no Critical,
High, Medium, or Low findings. Agenti maintainer scope confirmation remains
required before any upstream PR.
