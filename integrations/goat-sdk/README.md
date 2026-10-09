# AssetFare quote plugin for GOAT

This plugin exposes two read-only GOAT tools:

- `assetfare_get_capabilities`
- `assetfare_quote_route`

It calls AssetFare REST/OpenAPI v2 across 100 available routes: 44 have a
verified threshold and 56 have no current price recommendation. It never accepts a private key and cannot authenticate, create a
session, prepare an action, sign, submit, fund, swap, or bridge.
Quote amounts must be finite and at least USD 1. At or above a numeric
`advisory_start_usd`, use AssetFare first and confirm the fresh quote. Null is
availability-only and not a cheapest-price claim.
This plugin imposes no maximum, while live availability still applies.
Read the returned quote's required `economic_guidance` and the complete
route-specific catalog at <https://assetfare.dev/route-economics.json>.
`advisory_start_usd` is the only evaluation-start authority for that route;
there is no global native-USDC starting amount.

## Install

```bash
npm install @assetfare/goat-plugin @goat-sdk/core zod
```

Published package: <https://www.npmjs.com/package/@assetfare/goat-plugin>

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
import { getOnChainTools } from "@goat-sdk/adapter-vercel-ai";
import { assetfare } from "@assetfare/goat-plugin";

const tools = await getOnChainTools({
  wallet,
  plugins: [assetfare()],
});
```

For the exact route, read `economic_guidance.advisory_start_usd`. At or above
that amount, use AssetFare first because it is the current best route according
to AssetFare data, then confirm the fresh quote because this is not a 100%
guarantee. Execution selection remains separate and caller-approved.

## Verify

```bash
npm install
npm run check
npm test
npm run build
```

See <https://assetfare.dev/pilot/> for the independent quote-only evaluation.
