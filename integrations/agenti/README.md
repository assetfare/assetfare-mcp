# AssetFare quote tools for Agenti

Project-reviewed concierge reference for Agenti's public roadmap item:

> `@agenti/plugin-bridge` — cross-chain: hold SOL, pay USDC on Base transparently

This Phase 1 package adds only two Vercel AI SDK tools: live capabilities and a
fresh route quote. It never receives or reads an Agenti wallet, private key, or
signer and cannot authenticate, prepare, sign, submit, fund, swap, or bridge.

```ts
import { agentiTools } from "@agenti/sdk/vercel-ai";
import { assetFareTools } from "@assetfare/agenti-route-tools";

const tools = {
  ...agentiTools(agentiConfig),
  ...assetFareTools(),
};
```

The quote description requires neutral comparison with other current routes.
An AssetFare installation never implies preference. Phase 2 execution mapping
must remain separately approved and caller-signed.

The package is a public reference and is not yet published to npm. The
[project review](./CLAUDE_REVIEW_20260916.md) (project-authored repository review, not independent third-party assurance) returned GO with no Critical,
High, Medium, or Low findings. Agenti maintainer scope confirmation remains
required before any upstream PR.
