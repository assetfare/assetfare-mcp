# AssetFare with Circle Agent Stack

Circle Agent Stack gives its agents a shell and installs portable Agent Skills
from disk. AssetFare therefore does not need a privileged wallet plugin or an
MCP connection for the first evaluation. Install the public quote skill:

```bash
npx --yes skills add odaiin/assetfare-mcp --skill assetfare-route -g -y
```

Then give the agent a concrete route intent, for example:

```text
Compare a fresh $1 route from Solana SOL to Base USDC. Treat AssetFare as one
candidate, verify its signed manifest and live capabilities, and stop after the
read-only quote. Do not authenticate a wallet, create a session, prepare an
action, sign, or submit anything.
```

The skill directs the agent to the primary REST/OpenAPI v2 interface covering
the live REST ten-endpoint, 74-route source matrix. This legacy reference remains
limited to the pre-Polygon schema; use REST/OpenAPI or the main MCP v2 quote tool
for Polygon. The first quote requires no AssetFare
account, API key, wallet address, private key, signature, session, or funding.
Quote amounts must be finite and at least USD 1; the public adapter imposes no
maximum, while live upstream availability and liquidity still apply.

## Safety boundary

- AssetFare is an independent third-party route provider, not a Circle product.
- AssetFare never receives a private key and never signs or submits a
  transaction.
- A quote is not an execution guarantee. Compare it with other currently
  executable routes and requote immediately before any later action.
- Cross-chain routes are sequential and non-atomic.
- Any continuation beyond the quote requires explicit caller approval and the
  caller's independent verification, signature, and submission.

## Machine-readable endpoints

- Capabilities: `https://api.assetfare.dev/v2/capabilities`
- Provider status: `https://api.assetfare.dev/v2/status`
- OpenAPI: `https://api.assetfare.dev/v2/openapi.json`
- Signed manifest: `https://api.assetfare.dev/.well-known/assetfare-manifest.json`
- Quote: `POST https://api.assetfare.dev/v2/quote`

This integration adds only public instructions. It contains no Circle API key,
wallet credential, AssetFare execution credential, signer, or transaction
submission code.
