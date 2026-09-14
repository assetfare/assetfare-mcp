# AssetFare MCP — Solana to Base bridge API for AI agents

[![AssetFare MCP connector](https://glama.ai/mcp/connectors/io.github.odaiin/assetfare/badges/score.svg)](https://glama.ai/mcp/connectors/io.github.odaiin/assetfare)

An MCP client/server wrapper for AssetFare's capped, non-custodial Solana SOL → Base ETH workflow. Use it when an AI agent needs a verifiable Solana-to-Base quote, bridge workflow, or unsigned execution plan without handing custody to a routing service.

MCP is optional. AssetFare's primary machine interface is the public REST API
described by OpenAPI. Agents can obtain and compare a quote without installing
this wrapper:

- APIs.json: `https://assetfare.dev/apis.json`
- OpenAPI: `https://api.assetfare.dev/openapi.json`
- Read-only Arazzo workflow: `https://assetfare.dev/arazzo.yaml`

## Safety model

- AssetFare MCP never accepts a private key and never signs or submits a transaction.
- Read-only tools expose current status, signed manifest, and quotes.
- State-changing tools only create authentication/session records or prepare/verify unsigned workflow actions. MCP clients should require user approval for those calls.
- The caller independently verifies every returned unsigned action and signs/submits with its own wallets.

## Remote endpoint

`https://api.assetfare.dev/mcp`

Official MCP Registry server: `io.github.odaiin/assetfare`.

## REST/OpenAPI first call

Use the public quote endpoint when an agent has not explicitly connected MCP.
No API key, wallet authentication, session, signature, or transaction is
required for this read-only evaluation call:

```bash
node examples/rest-quote.mjs 300
python3 examples/rest_quote.py 300
```

```bash
curl -sS https://api.assetfare.dev/v1/quote \
  -H 'content-type: application/json' \
  -d '{"from_chain":"solana","from_token":"SOL","to_chain":"base","to_token":"ETH","amount_usd":300}'
```

Connect a remote MCP client directly—no package installation or AssetFare API
key is required:

```bash
claude mcp add --transport http assetfare https://api.assetfare.dev/mcp
```

```json
{
  "mcpServers": {
    "assetfare": {
      "url": "https://api.assetfare.dev/mcp"
    }
  }
}
```

### Codex CLI and app

Add the remote server from the CLI:

```bash
codex mcp add assetfare --url https://api.assetfare.dev/mcp
```

Or add it to `~/.codex/config.toml` or a project `.codex/config.toml`. The
`writes` approval mode prompts for tools that are not annotated read-only:

```toml
[mcp_servers.assetfare]
url = "https://api.assetfare.dev/mcp"
default_tools_approval_mode = "writes"
```

### Gemini CLI

```bash
gemini mcp add --transport http assetfare https://api.assetfare.dev/mcp
```

Equivalent `~/.gemini/settings.json` entry:

```json
{
  "mcpServers": {
    "assetfare": {
      "url": "https://api.assetfare.dev/mcp",
      "type": "http",
      "trust": false
    }
  }
}
```

### Cursor

Add the following server to a project `.cursor/mcp.json` or the global
`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "assetfare": {
      "url": "https://api.assetfare.dev/mcp"
    }
  }
}
```

Connecting is unauthenticated. Execution tools subsequently require the
wallet-bound token produced by AssetFare's non-transactional signMessage flow.
Do not place that token in any MCP configuration file.

## Agent skill

The portable Agent Skill is [`skills/assetfare-route/SKILL.md`](./skills/assetfare-route/SKILL.md).
Skills.lc-compatible clients can install it directly from this public GitHub repository.

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
- APIs.json: `https://assetfare.dev/apis.json`
- Arazzo: `https://assetfare.dev/arazzo.yaml`
- Server card: `https://api.assetfare.dev/.well-known/mcp/server-card.json`
- Agent guide: `https://assetfare.dev/llms-full.txt`
- Mainnet evidence: `https://assetfare.dev/evidence/`
- Live same-input comparison: `https://assetfare.dev/compare/solana-to-base/`

## Discovery

- Official MCP Registry: `io.github.odaiin/assetfare`
- Smithery: `https://smithery.ai/servers/twotw55/assetfare`
- Glama: `https://glama.ai/mcp/connectors/io.github.odaiin/assetfare`
- Agent Skill: `https://www.skills.sh/odaiin/assetfare-mcp/assetfare-route`

The wrapper deliberately contains no AssetFare route engine, wallets, RPC credentials, or internal operations data.

## Agent use case

For a Solana-to-Base $300 request, an agent reads the signed manifest and status, calls `assetfare_quote`, compares disclosed executable receive and ETA, and only then asks the wallet owner to approve the non-transactional login message. The agent independently signs and submits every on-chain action; this MCP server never does.

See the first-call evaluation script, the public mainnet evidence at https://assetfare.dev/evidence/, and the end-to-end case study at https://assetfare.dev/case-studies/solana-to-base-mainnet-canary/.
