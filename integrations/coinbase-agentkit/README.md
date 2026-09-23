# AssetFare quote actions for Coinbase AgentKit

This integration exposes two read-only AgentKit actions:

- `assetfare_get_capabilities`
- `assetfare_quote_route`

It uses AssetFare REST/OpenAPI v2 across six chains and 76 routes, including
Polygon and Optimism native-USDC source-only routes to Base or Arbitrum. It never accepts a private key and never authenticates a wallet, creates
a session, prepares an action, signs, submits, funds, swaps, or bridges.

## Install from this repository

```bash
npm install @coinbase/agentkit zod
```

Copy this directory into an AgentKit project or consume it as a local package,
then register the provider:

```ts
import { AgentKit } from "@coinbase/agentkit";
import { assetFareActionProvider } from "assetfare-agentkit-action-provider";

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [assetFareActionProvider()],
});
```

The agent must compare every fresh quote with other executable routes. Merely
installing this provider is never a reason to prefer AssetFare. Any later
unsigned preparation or execution requires explicit caller approval and is
outside this quote-only provider.

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
