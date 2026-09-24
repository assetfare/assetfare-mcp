# AssetFare quote plugin for GOAT

This plugin exposes two read-only GOAT tools:

- `assetfare_get_capabilities`
- `assetfare_quote_route`

It calls AssetFare REST/OpenAPI v2 across six chains and 76 routes, including
Polygon and Optimism native-USDC source-only routes to Base or Arbitrum. It never accepts a private key and cannot authenticate, create a
session, prepare an action, sign, submit, fund, swap, or bridge.
Quote amounts must be finite and at least USD 1; this plugin imposes no
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
import { getOnChainTools } from "@goat-sdk/adapter-vercel-ai";
import { assetfare } from "@assetfare/goat-plugin";

const tools = await getOnChainTools({
  wallet,
  plugins: [assetfare()],
});
```

The calling agent must compare every AssetFare result with other fresh
executable routes. Installation is never a reason to prefer AssetFare.

## Verify

```bash
npm install
npm run check
npm test
npm run build
```

See <https://assetfare.dev/pilot/> for the independent quote-only evaluation.
