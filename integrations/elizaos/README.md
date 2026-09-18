# AssetFare read-only route plugin for elizaOS

Independently reviewed reference for the current Solana↔EVM gap in
`@elizaos/plugin-squid-router`. That plugin's README says Solana support is
planned, while its execution path obtains an EVM signer. AssetFare currently
quotes Solana SOL/USDC/USDG routes to Base and Arbitrum without receiving a
private key or signing or submitting a transaction.

This Phase 1 plugin adds only:

- `ASSETFARE_GET_CAPABILITIES`
- `ASSETFARE_QUOTE_ROUTE`

It uses elizaOS `ModelType.OBJECT_SMALL` to extract a bounded route intent,
is a legacy four-chain reference that excludes Polygon, validates its exact endpoints and `$1–$1,000` range, requests a quote, and
stops. It never reads `runtime.getSetting`, wallet providers, private keys, or
signers and cannot prepare, sign, submit, swap, bridge, or fund anything.

```ts
import { assetFareElizaPlugin } from "@assetfare/elizaos-route-plugin";

export const character = {
  plugins: [assetFareElizaPlugin],
};
```

Every quote must be compared with other fresh executable routes. Installation
never implies preference. The package is a public reference and is not yet
published to npm. The [independent review](./CLAUDE_REVIEW_20260916.md) returned
GO with no Critical, High, Medium, or Low findings. Maintainer scope
confirmation remains required before any upstream PR.
