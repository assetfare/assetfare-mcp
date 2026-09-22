# AssetFare — non-custodial bridge and cross-chain swap for AI agents

[![Public safety checks](https://github.com/odaiin/assetfare-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/odaiin/assetfare-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/assetfare-mcp.svg)](https://www.npmjs.com/package/assetfare-mcp)
[![AssetFare MCP connector](https://glama.ai/mcp/connectors/io.github.odaiin/assetfare/badges/score.svg)](https://glama.ai/mcp/connectors/io.github.odaiin/assetfare)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/odaiin/assetfare-mcp)

AssetFare provides a **Solana to Base USDC bridge**, non-custodial bridge quotes,
and cross-chain swap routes for AI agents. It supports six chains, eleven source
endpoints, and 76 execution-ready directed routes at flat 1bp. **Solana SOL →
Base USDC and Solana USDC → Base USDC are supported**, as is Optimism USDC →
Base USDC. An agent gets a quote and, only after
explicit caller approval, a bounded unsigned action the caller signs itself;
AssetFare never receives private keys, signs, or submits.

Verify before trusting: [public source](https://github.com/odaiin/assetfare-mcp),
[Ed25519-signed manifest](https://api.assetfare.dev/.well-known/assetfare-manifest.json),
[public key](https://assetfare.dev/.well-known/assetfare-manifest.pub),
[security.txt](https://assetfare.dev/.well-known/security.txt), and
[on-chain execution evidence](https://assetfare.dev/evidence/). Quotes are
estimates, not a claim of universal best price; compare fresh executable routes.

Interfaces: MCP + A2A + REST/OpenAPI.

This repository contains an optional MCP adapter. Its primary read-only
tools expose the full six-chain source v2 quote matrix, and dedicated caller-approved
v2 tools (`assetfare_v2_prepare` plus the `assetfare_v2_session_*` lifecycle) operate
the non-custodial `/v2/prepare` and `/v2/session` endpoints for all 76 execution-ready
routes. The unversioned wallet authentication, session, preparation, and observation
tools remain compatibility surfaces for the two original Solana SOL → Base ETH and
Solana SOL → Arbitrum ETH workflows and must never be mixed with the v2 session tools.
Agents can also evaluate any current v2 route without installing or connecting
MCP:

- APIs.json: `https://assetfare.dev/apis.json`
- Capabilities: `https://api.assetfare.dev/v2/capabilities`
- OpenAPI v2: `https://api.assetfare.dev/v2/openapi.json`
- Provider status: `https://api.assetfare.dev/v2/status`
- Read-only Arazzo workflow: `https://assetfare.dev/arazzo.yaml`
- Independent agent pilot: `https://assetfare.dev/pilot/`

## Safety model

- AssetFare MCP never accepts a private key and never signs or submits a transaction.
- Every one of the 76 live routes models and collects exactly 1bp at one eligible
  successful atomic action; no live route is fee-free.
- `assetfare_v2_capabilities` and `assetfare_v2_quote` expose the primary eleven-endpoint, 76-route v2 scope. All 76 are execution-ready; Polygon and Optimism are directional native-USDC source-only origins to Base or Arbitrum USDC.
- `assetfare_v2_prepare` and the `assetfare_v2_session_*` lifecycle tools operate the caller-approved `/v2/prepare` and `/v2/session` endpoints. Each requires an explicit `caller_approved:true` and the caller's public wallet addresses, is never auto-called from a quote, and refuses any private key/seed/signed transaction. The session capability token is a sensitive bearer credential (never a private key); the caller generates it with `assetfare_v2_new_session_capability` and supplies it on every session call.
- The unversioned MCP quote/status and all MCP authentication/session/action tools are legacy original-corridor compatibility only.
- MCP state-changing tools only create authentication/session records or prepare/verify unsigned legacy workflow actions. MCP clients should require user approval for those calls.
- The caller independently verifies every returned unsigned action and signs/submits with its own wallets.

## Remote endpoint

`https://api.assetfare.dev/mcp`

Official MCP Registry server: `io.github.odaiin/assetfare`.

Primary MCP quote scope: 76 directed routes across eleven v2 source endpoints,
from $1 through $1,000; all 76 are execution-ready and charge exactly 1bp.
Canonical examples are `solana:SOL → base:USDC`, `solana:USDC → base:USDC`,
and `optimism:USDC → base:USDC`. Polygon and Optimism contribute exactly four
directional native-USDC source-only routes to Base and Arbitrum USDC. The
unversioned legacy workflow remains limited to `solana:SOL → base:ETH` and
`solana:SOL → arbitrum:ETH`; it does not limit the v2 route matrix.

For a new evaluation, call `assetfare_v2_capabilities` and then
`assetfare_v2_quote`. A v2 quote ID is not valid input to
`assetfare_create_session` or another legacy workflow tool.

## REST/OpenAPI first call

Use the public v2 quote endpoint when an agent has not explicitly connected MCP.
No API key, wallet authentication, session, signature, or transaction is
required for this read-only evaluation call:

```bash
curl -sS https://api.assetfare.dev/v2/quote \
  -H 'content-type: application/json' \
  -d '{"from_chain":"solana","from_token":"SOL","to_chain":"base","to_token":"USDC","amount_usd":1}'
```

From a cloned repository, the dependency-free examples are:

```bash
node examples/rest-quote.mjs 1 solana SOL base USDC
python3 examples/rest_quote.py 1 solana SOL base USDC
```

For a one-command, agent-readable evaluation that verifies the signed release
manifest and remains strictly quote-only:

```bash
npx --yes --package=assetfare-mcp@0.4.7 assetfare-route-eval \
  --amount 1 --from-chain solana --from-token SOL --to-chain base --to-token USDC
```

From a cloned repository, the equivalent command is `npm run route-eval -- ...`.

The evaluator defaults to `solana:SOL -> base:USDC` so USDC support is visible
without extra flags. If `solana:SOL -> base:ETH` is requested explicitly, it
also requests same-input Relay and Mayan snapshots with placeholder public
addresses. Those comparison rows are not executable orders; every provider
must be requoted with the caller's real addresses before selection or signing.

Read-only framework integrations are available for
[Coinbase AgentKit](./integrations/coinbase-agentkit/) and
[GOAT](./integrations/goat-sdk/), plus an independently reviewed
[SendAI Solana Agent Kit plugin](./integrations/solana-agent-kit/) and
[elizaOS plugin](./integrations/elizaos/), plus quote tools for
[Agenti](./integrations/agenti/). None of these integrations exposes preparation,
signing, submission, funding, swap, or bridge execution.

Dify agents can install the reviewed
[AssetFare Marketplace plugin](https://marketplace.dify.ai/plugin/odaiin/assetfare).
It exposes two native REST tools—live capabilities and one route quote—with no
credentials, wallet, authentication, session, preparation, signing, submission,
swap, or bridge execution tool.

Hugging Face smolagents users can load the reviewed
[quote tool](https://huggingface.co/spaces/odaiin/assetfare-quote) or
[capabilities tool](https://huggingface.co/spaces/odaiin/assetfare-capabilities)
from free Static Spaces. Hub tools execute remote code locally: inspect
`tool.py`, set `trust_remote_code=True`, and pin the documented immutable
revision. The complete source and tests are in
[`odaiin/smolagents-assetfare`](https://github.com/odaiin/smolagents-assetfare).

## A2A v1 quote adapter

AssetFare also exposes a read-only A2A v1 interface for agents that discover
and invoke Agent Cards without MCP:

- canonical Agent Card: `https://api.assetfare.dev/.well-known/agent-card.json`
- legacy discovery alias returning the identical card: `https://api.assetfare.dev/.well-known/agent.json`
- JSON-RPC v1 endpoint: `https://api.assetfare.dev/a2a`
- protocol: official `@a2a-js/sdk` v1, `A2A-Version: 1.0`,
  `Content-Type: application/json`

The read-only quote skill accepts one structured DataPart containing
`fromChain`, `fromToken`, `toChain`, `toToken`, and `amountUsd`. It calls the
public v2 capabilities, status, and quote endpoints and returns one quote with
its passed-through `caller_action_plan_handoff`. Additional caller-approved A2A
skills mirror the MCP execution tools: a local `new_session_capability` token
generator, a one-shot `prepare` operation, and the full `session` lifecycle
(`session_create`, `session_get`, `observe_source`, `observe_output`,
`refresh_action`). Each execution operation requires an explicit
`callerApproved:true` and the caller's public wallet addresses; AssetFare never
signs or submits, and only the caller's own submitted transaction hashes are
observed.

A card fetch, registry health check, TCK request, or registry-generated
`SendMessage` probe is discovery/conformance traffic, not customer demand.

The public endpoint was checked with official `a2aproject/a2a-tck` commit
`263b9cfa`: all 55 applicable MUST checks passed. Five generic TCK SUT fixture
tests send fixed TextPart payloads with magic messageId prefixes and require
unrelated text/file/data artifacts. They are deliberately not implemented by
this structured non-custodial agent; the exception is disclosed rather than
presented as a full 100% pass.

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

## Portable Agent Plugin

Clients that support the published vendor-neutral Agent Plugins 1.0 format can
install this repository from its Git URL. The current `plugins` CLI can install
the same MCP connection and AssetFare route-evaluation skill through the
included compatibility metadata:

```bash
npx plugins add odaiin/assetfare-mcp
```

The MCP endpoint's two primary v2 tools are read-only capabilities and quote
tools. Its separately labeled legacy workflow tools can create wallet-auth or
session state and prepare unsigned actions only after explicit selection and
approval. AssetFare never receives private keys, signs, or submits, and the
skill keeps REST/OpenAPI v2 as the primary evaluation path.

Circle Agent Stack and other shell-capable agents can use the same skill and
public REST/OpenAPI flow; see [`integrations/circle-agent-stack`](./integrations/circle-agent-stack/README.md).

## First-call evaluation

Run `npm run first-call-eval` to verify a fresh MCP client can discover the
primary v2 quote-only tools, validate current capabilities, and obtain a $1
six-chain source quote without creating a wallet login, session, action, signature,
or transaction. Legacy workflow tools remain present but are not called.

Use Streamable HTTP. The endpoint has no server-side API key. The two v2 tools
never authenticate a wallet; only an explicitly selected legacy workflow uses
the separate wallet-auth tools.

## Local stdio

The repository also contains a stdio-compatible wrapper for self-hosting. The
public Registry entry uses the remote Streamable HTTP endpoint. Package and
Registry releases remain separately reviewed from remote deployment.

## Trust material

- Security contact: `security@assetfare.dev`
- Security policy and private reporting: `https://github.com/odaiin/assetfare-mcp/security/policy`
- Signed manifest: `https://api.assetfare.dev/.well-known/assetfare-manifest.json`
- Public signing key: `https://assetfare.dev/.well-known/assetfare-manifest.pub`
- Six-chain source status: `https://api.assetfare.dev/v2/status`
- Six-chain source capabilities: `https://api.assetfare.dev/v2/capabilities`
- Primary OpenAPI v2: `https://api.assetfare.dev/v2/openapi.json`
- Legacy MCP-backed v1 OpenAPI: `https://api.assetfare.dev/openapi.json`
- APIs.json: `https://assetfare.dev/apis.json`
- Arazzo: `https://assetfare.dev/arazzo.yaml`
- Server card: `https://api.assetfare.dev/.well-known/mcp/server-card.json`
- A2A Agent Card: `https://api.assetfare.dev/.well-known/agent-card.json`
- A2A endpoint: `https://api.assetfare.dev/a2a`
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
- Dify Marketplace: `https://marketplace.dify.ai/plugin/odaiin/assetfare`
- Hugging Face quote tool: `https://huggingface.co/spaces/odaiin/assetfare-quote` (canonical reviewed revision `401ecf835a3e0c95807c245a208eeda81b0d9b81`)
- Hugging Face capabilities tool: `https://huggingface.co/spaces/odaiin/assetfare-capabilities` (canonical reviewed revision `995b5c5be4d88a6c94241ef22ac3a6581dfa8cdb`)
- A2A Registry: `https://a2aregistry.org/agents/d4f9ab1a-904c-4227-8fc6-548e45749de1`
- ARD: `https://assetfare.dev/.well-known/ard.json`

The wrapper deliberately contains no AssetFare route engine, wallets, RPC credentials, or internal operations data.

## Agent use case

For any supported six-chain source request, an agent first reads v2 capabilities and
requests a fresh quote through REST/OpenAPI or the read-only
`assetfare_v2_quote` MCP tool. Only an explicitly requested original-corridor
legacy workflow should use `assetfare_quote` followed by the wallet-auth/session
tools. The caller independently signs and submits every on-chain action; this
MCP server never does.

See the first-call evaluation script, the public mainnet evidence at https://assetfare.dev/evidence/, and the end-to-end case study at https://assetfare.dev/case-studies/solana-to-base-mainnet-canary/.
