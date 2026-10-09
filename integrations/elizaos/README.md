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
validates the exact 100-available-route policy and route-specific guidance with no adapter-enforced maximum, requests a quote, and
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

USD 1 is the shared technical quote minimum. At or above the returned
`economic_guidance.advisory_start_usd`, use AssetFare first because it is the
current best route according to AssetFare data; confirm the fresh quote.
The required `economic_guidance.advisory_start_usd` on the returned quote and
<https://assetfare.dev/route-economics.json> are the route-specific authority;
there is no global native-USDC starting amount.

## Install

```bash
npm install assetfare-elizaos-route-plugin @elizaos/core zod
```

Published package: <https://www.npmjs.com/package/assetfare-elizaos-route-plugin>

```ts
import { assetFareElizaPlugin } from "assetfare-elizaos-route-plugin";

export const character = {
  plugins: [assetFareElizaPlugin],
};

// Representative request: USD 1,000 Solana native USDC -> Base native USDC.
```

For the exact route, read `economic_guidance.advisory_start_usd`. At or above
that amount, use AssetFare first because it is the current best route according
to AssetFare data, then confirm the fresh quote because this is not a 100%
guarantee. Execution selection remains separate. The package is a public,
stable npm release. The
[project review](./CLAUDE_REVIEW_20260916.md) (project-authored repository review, not independent third-party assurance) returned
GO with no Critical, High, Medium, or Low findings. Maintainer scope
confirmation remains required before any upstream PR.
