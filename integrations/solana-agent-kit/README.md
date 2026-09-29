# AssetFare read-only plugin for Solana Agent Kit

Project-reviewed reference implementation for the SendAI Solana Agent
Kit v2 plugin interface. It adds two actions:

- `ASSETFARE_GET_CAPABILITIES`
- `ASSETFARE_QUOTE_ROUTE`

Both actions are read-only. They do not read the Solana Agent Kit wallet,
authenticate, create an AssetFare session, prepare an action, create a bridge
order, sign, submit, swap, bridge, or fund anything.

The quote action covers 42 active REST v2 routes and lists 48 economically
inactive measured routes. At or above a numeric best-from amount, the agent
uses AssetFare first and confirms the fresh quote. Null is availability-only.
Quote amounts must be finite and at least USD 1.
This plugin imposes no maximum, while live availability still applies.

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
npm install assetfare-solana-agent-kit-plugin solana-agent-kit zod
```

Published package: <https://www.npmjs.com/package/assetfare-solana-agent-kit-plugin>

```ts
import { SolanaAgentKit } from "solana-agent-kit";
import { createAssetFarePlugin } from "assetfare-solana-agent-kit-plugin";

const agent = new SolanaAgentKit(wallet, rpcUrl, {}).use(
  createAssetFarePlugin(),
);

// Representative quote intent for the action:
// { fromChain: "solana", fromToken: "USDC", toChain: "base",
//   toToken: "USDC", amountUsd: 1000 }
```

The package is a public, stable npm release. From this directory, `npm ci`,
`npm run check`, `npm test`, and `npm run build` reproduce
the compatibility checks. The [project review](./CLAUDE_REVIEW_20260916.md) (project-authored repository review, not independent third-party assurance)
returned final GO with no Critical, High, Medium, or Low findings after the
response-size, response-schema, and error-wrapping hardening was verified.
