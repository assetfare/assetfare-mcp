# AssetFare read-only plugin for Solana Agent Kit

Project-reviewed reference implementation for the SendAI Solana Agent
Kit v2 plugin interface. It adds two actions:

- `ASSETFARE_GET_CAPABILITIES`
- `ASSETFARE_QUOTE_ROUTE`

Both actions are read-only. They do not read the Solana Agent Kit wallet,
authenticate, create an AssetFare session, prepare an action, create a bridge
order, sign, submit, swap, bridge, or fund anything.

The quote action covers the current six-chain, 76-route REST v2 surface,
including Polygon and Optimism native-USDC source-only routes to Base or
Arbitrum. It requires the agent
to compare AssetFare with deBridge, Wormhole, and other fresh executable
routes; installation never implies preference.

```ts
import { SolanaAgentKit } from "solana-agent-kit";
import { createAssetFarePlugin } from "assetfare-solana-agent-kit-plugin";

const agent = new SolanaAgentKit(wallet, rpcUrl, {}).use(
  createAssetFarePlugin(),
);
```

The package is a public reference and is not yet published to npm. From this
directory, `npm ci`, `npm run check`, `npm test`, and `npm run build` reproduce
the compatibility checks. The [project review](./CLAUDE_REVIEW_20260916.md) (project-authored repository review, not independent third-party assurance)
returned final GO with no Critical, High, Medium, or Low findings after the
response-size, response-schema, and error-wrapping hardening was verified.
