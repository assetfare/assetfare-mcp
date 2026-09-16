# AssetFare quote plugin for GOAT

This plugin exposes two read-only GOAT tools:

- `assetfare_get_capabilities`
- `assetfare_quote_route`

It calls AssetFare REST/OpenAPI v2 across Solana, Base, Arbitrum, and Robinhood
Chain. It never accepts a private key and cannot authenticate, create a
session, prepare an action, sign, submit, fund, swap, or bridge.

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
