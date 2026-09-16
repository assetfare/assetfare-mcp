# AssetFare — agent-first multichain routes with an optional MCP adapter

[![Public safety checks](https://github.com/odaiin/assetfare-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/odaiin/assetfare-mcp/actions/workflows/ci.yml)
[![AssetFare MCP connector](https://glama.ai/mcp/connectors/io.github.odaiin/assetfare/badges/score.svg)](https://glama.ai/mcp/connectors/io.github.odaiin/assetfare)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/odaiin/assetfare-mcp)

AssetFare's primary product is a capped, non-custodial REST/OpenAPI v2 route
service for AI agents across Solana, Base, Arbitrum, and Robinhood Chain. It
exposes nine asset endpoints and 72 directed non-identity conversions, returns
bounded unsigned actions, and never receives private keys, signs, or submits.

This repository contains the optional MCP compatibility adapter for the two
original Solana SOL → Base ETH and Solana SOL → Arbitrum ETH workflows. The MCP
tool set does **not** expose the full four-chain matrix. Agents can evaluate any
current v2 route without installing or connecting MCP:

- APIs.json: `https://assetfare.dev/apis.json`
- Capabilities: `https://api.assetfare.dev/v2/capabilities`
- OpenAPI v2: `https://api.assetfare.dev/v2/openapi.json`
- Provider status: `https://api.assetfare.dev/v2/status`
- Read-only Arazzo workflow: `https://assetfare.dev/arazzo.yaml`
- Independent agent pilot: `https://assetfare.dev/pilot/`

## Safety model

- AssetFare MCP never accepts a private key and never signs or submits a transaction.
- The v2 REST API and this compatibility MCP adapter expose different route scopes; read capabilities before selecting an interface.
- MCP read-only tools expose status, the signed manifest, and original-corridor quotes.
- MCP state-changing tools only create authentication/session records or prepare/verify unsigned original-corridor workflow actions. MCP clients should require user approval for those calls.
- The caller independently verifies every returned unsigned action and signs/submits with its own wallets.

## Remote endpoint

`https://api.assetfare.dev/mcp`

Official MCP Registry server: `io.github.odaiin/assetfare`.

MCP adapter scope: `solana:SOL → base:ETH` and `solana:SOL → arbitrum:ETH`,
from $1 through $1,000. Use REST/OpenAPI v2 for the four-chain matrix.

## REST/OpenAPI first call

Use the public v2 quote endpoint when an agent has not explicitly connected MCP.
No API key, wallet authentication, session, signature, or transaction is
required for this read-only evaluation call:

```bash
node examples/rest-quote.mjs 1 solana SOL base USDC
python3 examples/rest_quote.py 1 solana SOL base USDC
```

For a one-command, agent-readable evaluation that verifies the signed release
manifest and remains strictly quote-only:

```bash
npx --yes --package=github:odaiin/assetfare-mcp assetfare-route-eval \
  --amount 1 --from-chain solana --from-token SOL --to-chain base --to-token ETH
```

From a cloned repository, the equivalent command is `npm run route-eval -- ...`.

For `solana:SOL -> base:ETH`, the evaluator also requests same-input Relay and
Mayan snapshots with placeholder public addresses. Those comparison rows are
not executable orders; every provider must be requoted with the caller's real
addresses before selection or signing. Other routes return the AssetFare quote
without pretending that a generic competitor comparison is available.

Read-only framework integrations are available for
[Coinbase AgentKit](./integrations/coinbase-agentkit/) and
[GOAT](./integrations/goat-sdk/), plus an independently reviewed
[SendAI Solana Agent Kit plugin](./integrations/solana-agent-kit/) and
[elizaOS plugin](./integrations/elizaos/), plus quote tools for
[Agenti](./integrations/agenti/). None of these integrations exposes preparation,
signing, submission, funding, swap, or bridge execution.

```bash
curl -sS https://api.assetfare.dev/v2/quote \
  -H 'content-type: application/json' \
  -d '{"from_chain":"solana","from_token":"SOL","to_chain":"base","to_token":"USDC","amount_usd":1}'
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

Connecting is unauthenticated. The legacy MCP execution tools subsequently require the
wallet-bound token produced by AssetFare's non-transactional signMessage flow.
Do not place that token in any MCP configuration file.

## Agent skill

The portable Agent Skill is [`skills/assetfare-route/SKILL.md`](./skills/assetfare-route/SKILL.md).
Skills.lc-compatible clients can install it directly from this public GitHub repository.

```bash
npx --yes skills add odaiin/assetfare-mcp --skill assetfare-route -g -y
```

Circle Agent Stack and other shell-capable agents can use the same skill and
public REST/OpenAPI flow; see [`integrations/circle-agent-stack`](./integrations/circle-agent-stack/README.md).

## First-call evaluation

Run `npm run first-call-eval` to verify a fresh MCP client can discover the
legacy compatibility tools, validate the signed manifest and status, and obtain a $1 original-corridor quote without
creating a wallet login, session, signature, or transaction.

Use Streamable HTTP. The endpoint has no server-side API key; wallet authentication happens through the AssetFare tools.

## Local stdio

The repository also contains a stdio-compatible wrapper for self-hosting. The
public Registry entry uses the remote Streamable HTTP endpoint; npm publication
is intentionally deferred until a separate package-release review.

## Trust material

- Security contact: `security@assetfare.dev`
- Security policy and private reporting: `https://github.com/odaiin/assetfare-mcp/security/policy`
- Signed manifest: `https://api.assetfare.dev/.well-known/assetfare-manifest.json`
- Public signing key: `https://assetfare.dev/.well-known/assetfare-manifest.pub`
- Four-chain status: `https://api.assetfare.dev/v2/status`
- Four-chain capabilities: `https://api.assetfare.dev/v2/capabilities`
- Primary OpenAPI v2: `https://api.assetfare.dev/v2/openapi.json`
- Legacy MCP-backed v1 OpenAPI: `https://api.assetfare.dev/openapi.json`
- APIs.json: `https://assetfare.dev/apis.json`
- Arazzo: `https://assetfare.dev/arazzo.yaml`
- Server card: `https://api.assetfare.dev/.well-known/mcp/server-card.json`
- Agent guide: `https://assetfare.dev/llms-full.txt`
- Mainnet evidence: `https://assetfare.dev/evidence/`
- Paired route evidence: [`evidence/solana-base-paired-quotes-20260916.md`](./evidence/solana-base-paired-quotes-20260916.md)
- Agent-payment route evidence: [`evidence/solana-base-usdc-paired-quotes-20260916.md`](./evidence/solana-base-usdc-paired-quotes-20260916.md)
- Live same-input comparison: `https://assetfare.dev/compare/solana-to-base/`

## Discovery

- Official MCP Registry: `io.github.odaiin/assetfare`
- MCP Servers: `https://mcpservers.org/servers/odaiin/assetfare-mcp`
- Smithery: `https://smithery.ai/servers/twotw55/assetfare`
- Glama: `https://glama.ai/mcp/connectors/io.github.odaiin/assetfare`
- Agent Skill: `https://www.skills.sh/odaiin/assetfare-mcp/assetfare-route`

The wrapper deliberately contains no AssetFare route engine, wallets, RPC credentials, or internal operations data.

## Agent use case

For any supported four-chain request, an agent first reads the v2 capabilities
and OpenAPI contract and requests a fresh REST quote. For one of the two
original MCP corridors, an explicitly connected client may instead call
`assetfare_quote`, compare disclosed executable receive and ETA, and only then
ask the wallet owner to approve the non-transactional login message. The caller
independently signs and submits every on-chain action; this MCP server never
does.

See the first-call evaluation script, the public mainnet evidence at https://assetfare.dev/evidence/, and the end-to-end case study at https://assetfare.dev/case-studies/solana-to-base-mainnet-canary/.
