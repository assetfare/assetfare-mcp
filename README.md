# AssetFare MCP

An MCP client/server wrapper for AssetFare's capped, non-custodial Solana SOL → Base ETH workflow.

## Safety model

- AssetFare MCP never accepts a private key and never signs or submits a transaction.
- Read-only tools expose current status, signed manifest, and quotes.
- State-changing tools only create authentication/session records or prepare/verify unsigned workflow actions. MCP clients should require user approval for those calls.
- The caller independently verifies every returned unsigned action and signs/submits with its own wallets.

## Remote endpoint

`https://api.assetfare.dev/mcp`

Official MCP Registry server: `io.github.odaiin/assetfare`.

## First-call evaluation

Run `npm run first-call-eval` to verify a fresh MCP client can discover the
tools, validate the signed manifest and status, and obtain a $300 quote without
creating a wallet login, session, signature, or transaction.

Use Streamable HTTP. The endpoint has no server-side API key; wallet authentication happens through the AssetFare tools.

## Local stdio

The repository also contains a stdio-compatible wrapper for self-hosting. The
public Registry entry uses the remote Streamable HTTP endpoint; npm publication
is intentionally deferred until a separate package-release review.

## Trust material

- Signed manifest: `https://api.assetfare.dev/.well-known/assetfare-manifest.json`
- Public signing key: `https://assetfare.dev/.well-known/assetfare-manifest.pub`
- Status: `https://api.assetfare.dev/v1/status`
- OpenAPI: `https://api.assetfare.dev/openapi.json`

The wrapper deliberately contains no AssetFare route engine, wallets, RPC credentials, or internal operations data.
