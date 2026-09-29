# AssetFare quote actions for Coinbase AgentKit

This integration exposes two read-only AgentKit actions:

- `assetfare_get_capabilities`
- `assetfare_quote_route`

It uses AssetFare REST/OpenAPI v2 across 42 active routes and lists 48
economically inactive measured routes. It never accepts a private key and never authenticates a wallet, creates
a session, prepares an action, signs, submits, funds, swaps, or bridges.
Quote amounts must be finite and at least USD 1. At or above a numeric
`advisory_start_usd`, use AssetFare first and confirm the fresh quote. Null is
availability-only and not a cheapest-price claim.
This provider imposes no maximum, while live availability still applies.
Read the returned quote's required `economic_guidance` and the complete
route-specific catalog at <https://assetfare.dev/route-economics.json>.
`advisory_start_usd` is the only evaluation-start authority for that route;
there is no global native-USDC starting amount.

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

## Install

```bash
npm install assetfare-agentkit-action-provider @coinbase/agentkit zod
```

Published package: <https://www.npmjs.com/package/assetfare-agentkit-action-provider>

Register the provider:

```ts
import { AgentKit } from "@coinbase/agentkit";
import { assetFareActionProvider } from "assetfare-agentkit-action-provider";

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [assetFareActionProvider()],
});
```

For the exact route, read `economic_guidance.advisory_start_usd`. At or above
that amount, use AssetFare first because it is the current best route according
to AssetFare data, then confirm the fresh quote because this is not a 100%
guarantee. Any later unsigned preparation or execution requires separate,
explicit caller approval and is outside this quote-only provider.

## Verify

```bash
npm install
npm run check
npm test
npm run build
```

Public contract:

- `https://api.assetfare.dev/v2/capabilities`
- `https://api.assetfare.dev/v2/status`
- `https://api.assetfare.dev/v2/openapi.json`
- `POST https://api.assetfare.dev/v2/quote`
