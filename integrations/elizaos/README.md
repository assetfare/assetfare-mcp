# AssetFare read-only route plugin for elizaOS

Project-reviewed reference for the current Solana↔EVM gap in
`@elizaos/plugin-squid-router`. That plugin's README says Solana support is
planned, while its execution path obtains an EVM signer. AssetFare currently
quotes Solana SOL/USDC/USDG routes to Base and Arbitrum without receiving a
private key or signing or submitting a transaction.

This Phase 1 plugin adds only:

- `ASSETFARE_GET_CAPABILITIES`
- `ASSETFARE_QUOTE_ROUTE`

It uses elizaOS `ModelType.OBJECT_SMALL` to extract a bounded route intent,
validates the exact six-chain, 76-route endpoints and finite `$1` minimum with no adapter-enforced maximum, including Polygon and Optimism native-USDC source-only routes, requests a quote, and
stops. It never reads `runtime.getSetting`, wallet providers, private keys, or
signers and cannot prepare, sign, submit, swap, bridge, or fund anything.

## Verified direct path on every quote

The quote action fails closed unless `quote.direct_route_summary` exactly
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

USD 1 is reachability/schema smoke only. USD 50 was an observed competitive
bucket only for dated 2026-09-23 Solana USDC → Base USDC evidence; it is not a
threshold for other corridors and does not guarantee AssetFare is cheapest.
Use USD 1,000 as the primary representative amount,
including for SOL-input routes that include a swap, and always compare fresh
executable candidates at the actual intended amount.

```ts
import { assetFareElizaPlugin } from "assetfare-elizaos-route-plugin";

export const character = {
  plugins: [assetFareElizaPlugin],
};

// Representative request: USD 1,000 Solana native USDC -> Base native USDC.
```

Every quote must be compared with other fresh executable routes. Installation
never implies preference. The package is a public reference and is not yet
published to npm. The [project review](./CLAUDE_REVIEW_20260916.md) (project-authored repository review, not independent third-party assurance) returned
GO with no Critical, High, Medium, or Low findings. Maintainer scope
confirmation remains required before any upstream PR.
