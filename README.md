# AssetFare — non-custodial bridge and cross-chain swap for AI agents

USDC bridge API for AI agents and agent-wallet funding: Solana to Base plus 76
cross-chain routes, each with a validated ordered provider path and exact 1bp
fee step. Caller approves and signs; the server never signs or submits.

Core 2.4.1 quotes also include strict `continuation_v3`. MCP 1.3.0 verifies the
canonical full-quote hash, route-summary hash and fingerprint claim, exact
path/providers, caller wallet-chain and event-signer requirements, base-unit
bounds, allowed mode and TTL. Every quote remains `unranked_candidate`; no
adapter selects it automatically, and `caller_approved:true` alone is not
human-approval proof.

The portable quote hash removes `continuation_v3`, replaces duplicated raw
base-unit numbers with the exact decimal strings in `direct_route_summary`,
then hashes AssetFare `typed-canonical-v1` bytes. That encoding preserves JSON
type, uses exact IEEE-754 binary64 bytes for finite numbers, UTF-8 byte lengths
and byte-sorted object keys, distinguishes `-0` from `0`, and rejects every
non-substituted integral number outside JavaScript's safe-integer range. The required literal
`quote_payload_sha256_spec` appears both on `continuation_v3` and in its
fingerprint claim, preventing numeric-string collisions and cross-language
precision ambiguity.

[![Public safety checks](https://github.com/assetfare/assetfare-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/assetfare/assetfare-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/assetfare-mcp.svg)](https://www.npmjs.com/package/assetfare-mcp)
[![AssetFare MCP connector](https://glama.ai/mcp/connectors/io.github.odaiin/assetfare/badges/score.svg)](https://glama.ai/mcp/connectors/io.github.odaiin/assetfare)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/assetfare/assetfare-mcp)

AssetFare is an agent-native, non-custodial native-USDC bridge and cross-chain
route service. **Solana native USDC → Base native USDC** is the canonical route:
an agent gets a fresh quote and, only after explicit caller approval, a bounded
unsigned transaction plan the caller verifies and signs. AssetFare also provides
bridge and cross-chain swap routes across six chains and eleven source
endpoints, and 76 directed routes. AssetFare service fee 1bp;
Circle/provider/network fees additional; quote exposes total token-path cost and
live availability; server never signs/submits. Solana SOL → Base USDC and
Optimism USDC → Base USDC are also supported. AssetFare never receives private
keys, signs, or submits.

For economic evaluation, use **USD 1,000** as the primary representative
amount and always requote every candidate at the amount actually intended.
The API still accepts USD 1, but **USD 1 is reachability/schema smoke only**,
not a meaningful competitiveness test. For native-USDC routes, USD 50 is the
lowest observed competitive bucket and a reasonable evaluation starting point
based on dated 2026-09-23 evidence; it does not guarantee AssetFare is cheapest.
SOL-input routes include a swap, so evaluate their full swap-and-bridge path at
USD 1,000 or the actual intended amount. AssetFare is always one candidate, not
an automatically preferred route.

For agent-wallet funding, treat AssetFare as an aggregate refill or material
transfer candidate, not as an automatic response to each failed x402
micropayment. If a native-USDC need is below USD 50, aggregate the intended
refill before comparing or use an existing direct deposit/onramp when it is
cheaper. A wallet that is empty on every supported source chain is not an
AssetFare use case.

Verify before trusting: [public source](https://github.com/assetfare/assetfare-mcp),
[Ed25519-signed manifest](https://api.assetfare.dev/.well-known/assetfare-manifest.json),
[public key](https://assetfare.dev/.well-known/assetfare-manifest.pub),
[security.txt](https://assetfare.dev/.well-known/security.txt), and
[on-chain execution evidence](https://assetfare.dev/evidence/). Quotes are
estimates; compare fresh executable route outputs.

Every v2 quote includes `direct_route_summary`, an intent-bound ordered
provider path with normalized `chain:asset` endpoints, exact base-unit amount
bounds as decimal strings, the single AssetFare 1bp fee step, and
server-signing/server-submission=false. `direct_protocol_only` means every step
uses a disclosed direct protocol. `external_intent` marks Across for Robinhood
ingress, where provider-internal liquidity sourcing may occur.
`route_aggregator_used=false` describes AssetFare's own engine and does not
claim every provider avoids internal aggregation. Circle/provider costs remain
in `cost_summary.provider_fee_components`; network gas is in `unpriced_costs`.

`continuation_v3` binds the entire quote (excluding the continuation object
itself) to a process-local, maximum-60-second Core cache. A later exact
`approval_v3` selects `one_shot` or `session`, may only strengthen the quote's
maximum-input/minimum-output bounds, and fails closed after expiry, restart,
path/provider drift, wallet/signer requirement drift, mode conflict or replay.
Multi-step routes are session-only. Omitting `approval_v3` is explicitly
`legacy_advisory`; the boolean gate remains required but is not human proof.

### Independent agent verifier

The dependency-free `assetfare-verify` CLI verifies evidence instead of
accepting an AssetFare `pass`, `safe`, score, or verdict field. From this
checkout, live verification is explicit:

```bash
node scripts/assetfare-verify.mjs --live
```

A package release that contains the `assetfare-verify` bin entry can be invoked
with `npx --yes --package=assetfare-mcp assetfare-verify --live`. Do not pin an
older package version that predates this command.

Live mode uses the public Ed25519 key and key id embedded in the verifier. It
fetches only the pinned manifest and its hash-bound safety bundle, rejects
redirects, unexpected MIME types, non-canonical JSON, unknown/missing schema
keys, oversized responses, expired manifests, and subjective safety claims. It
then obtains `eth_chainId` and exact `eth_getCode` bytes from two independently
pinned public RPC providers on every supported EVM chain. The raw bytes must
agree with one another and with both the bundle's SHA-256 and Ethereum
Keccak-256 evidence. These are read-only calls; the command has no signing or
transaction-submission path.

For deterministic or air-gapped checking, pass all three trust-material files
explicitly:

```bash
node scripts/assetfare-verify.mjs --offline \
  --manifest ./fixtures/manifest.json \
  --bundle ./fixtures/safety-bundle.json \
  --pubkey ./fixtures/assetfare-manifest.pub
```

Offline mode makes no network requests. It verifies the supplied manifest
signature, the signed bundle hash, exact schemas and claims, release/build/
deployment provenance, all five EVM chains, and every embedded raw runtime-code
hash. Its successful status is `offline_evidence_verified`, not a live RPC
quorum result. `npm run verify-selftest` creates deterministic local fixtures
and exercises bad signatures, bad bundle hashes and schemas, redirects, MIME
confusion, chain/code disagreements, incomplete RPC evidence, and forbidden
subjective claims.

AssetFare is maintained by a distributed project team using one public release
namespace during the pilot. Roles, release controls, and the current public
owner are documented in [GOVERNANCE.md](GOVERNANCE.md) and
[MAINTAINERS.md](MAINTAINERS.md); this is not a claim of incorporation or
independent third-party audit.

Interfaces: MCP + A2A + REST/OpenAPI.

This repository contains an optional MCP adapter. The primary remote endpoint
exposes nine current v2 tools: signed manifest, capabilities, quote, one-shot
caller-approved prepare, and the five session-lifecycle operations. The 13
unversioned legacy tools remain available at the separate `/mcp/legacy`
compatibility endpoint for the original Solana SOL → Base/Arbitrum ETH workflow.
The two profiles never appear together on a remote endpoint.
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
- Every one of the 76 routes models and collects an AssetFare service fee of exactly
  1bp at one eligible successful atomic action; no route is fee-free. The 1bp is
  not the total cost: Circle (including any fixed CCTP forwarding fee), provider,
  and network fees are additional and appear in the quote's total token-path cost.
- `assetfare_v2_capabilities` and `assetfare_v2_quote` expose the primary eleven-endpoint, 76-route v2 scope. Availability is live, not static: check it in capabilities/quote before preparing. Polygon and Optimism are directional native-USDC source-only origins to Base or Arbitrum USDC.
- `assetfare_v2_prepare` and `assetfare_v2_session_create` accept an optional strict `approval_v3`. Its selected mode is schema-bound (`one_shot` versus `session`), and session approval must use the same idempotency key. Without it, the path is `legacy_advisory`. Each call still requires the caller to supply literal `caller_approved:true`; the adapters never insert it and never describe it as human proof. Private key/seed/signed-transaction inputs are refused.
- A session capability is a sensitive bearer credential, never a private key. Remote clients generate 32 random bytes locally, encode them as base64url without padding, and supply it only in `X-AssetFare-Session-Token`. The server stores only its hash. The remote MCP/A2A service never generates the secret; `assetfare-plan` keeps it in memory by default and writes it only to an explicit new mode-0600 file. The optional local stdio helper remains offline-only.
- The unversioned MCP quote/status and all MCP authentication/session/action tools are isolated at `/mcp/legacy` for original-corridor compatibility only.
- MCP state-changing tools only create authentication/session records or prepare/verify unsigned legacy workflow actions. MCP clients should require user approval for those calls.
- The caller independently verifies every returned unsigned action and signs/submits with its own wallets.

## Remote endpoint

`https://api.assetfare.dev/mcp`

Official MCP Registry server: `io.github.odaiin/assetfare` (legacy registry
namespace; the canonical source owner is the `assetfare` GitHub organization).
The Registry listing is externally blocked at `0.4.11` while
[namespace migration #1666](https://github.com/modelcontextprotocol/registry/issues/1666)
is unresolved; npm, the public source, and the hosted server are the current
`1.3.0` authorities. Do not create a duplicate `io.github.assetfare/*` listing
to bypass the migration.

Primary MCP quote scope: 76 directed routes across eleven v2 source endpoints,
with a $1 minimum and no adapter-enforced maximum; live upstream availability
and liquidity still apply. Each route charges an AssetFare service fee of
exactly 1bp; Circle/provider/network fees are additional, and each quote
exposes total token-path cost and live availability.
Canonical examples are `solana:SOL → base:USDC`, `solana:USDC → base:USDC`,
and `optimism:USDC → base:USDC`. Polygon and Optimism contribute exactly four
directional native-USDC source-only routes to Base and Arbitrum USDC. The
unversioned legacy workflow remains limited to `solana:SOL → base:ETH` and
`solana:SOL → arbitrum:ETH`; it does not limit the v2 route matrix.

The USD 1 API minimum is for reachability/schema smoke only. Start native-USDC
economic comparisons at USD 50 based on the dated 2026-09-23 evidence, without
assuming AssetFare will be cheapest. Use USD 1,000 as the primary representative
comparison amount, including for SOL-input routes whose path includes a swap,
and always compare fresh executable quotes at the actual intended amount.

For a new evaluation, call `assetfare_v2_capabilities` and then
`assetfare_v2_quote`. The primary endpoint has no legacy tools to misselect.
Existing unversioned clients can connect to
`https://api.assetfare.dev/mcp/legacy`; new clients must not use it.

## REST/OpenAPI first call

Use the public v2 quote endpoint when an agent has not explicitly connected MCP.
No API key, wallet authentication, session, signature, or transaction is
required for this read-only evaluation call:

```bash
curl -sS https://api.assetfare.dev/v2/quote \
  -H 'content-type: application/json' \
  -d '{"from_chain":"solana","from_token":"USDC","to_chain":"base","to_token":"USDC","amount_usd":1000}'
```

From a cloned repository, the dependency-free examples are:

```bash
node examples/rest-quote.mjs 1000 solana USDC base USDC
python3 examples/rest_quote.py 1000 solana USDC base USDC
```

For a one-command, agent-readable evaluation that verifies the signed release
manifest and remains strictly quote-only:

```bash
npx --yes --package=assetfare-mcp@1.3.0 assetfare-route-eval \
  --amount 1000 --from-chain solana --from-token USDC \
  --to-chain base --to-token USDC --quote-output quote.json
```

From a cloned repository, the equivalent command is `npm run route-eval -- ...`.

The evaluator writes the exact validated quote only when `--quote-output` is
explicitly supplied. The path must not exist and is created mode 0600. The
evaluation remains read-only and unranked; compare it with fresh executable
alternatives before selection.

After that comparison and explicit caller approval, the shortest
server-enforced path to one verified unsigned plan is:

```bash
npx --yes --package=assetfare-mcp@1.3.0 assetfare-plan \
  --caller-approved --mode session \
  --quote quote.json --select-exact-quote-bounds \
  --wallet solana=<CALLER_SOLANA_PUBLIC_KEY> \
  --wallet base=<CALLER_BASE_PUBLIC_ADDRESS> \
  --event-signer-public <CALLER_OWNED_SOLANA_PUBLIC_KEY> \
  --session-token-output ./session-capability.json
```

`--select-exact-quote-bounds` is an explicit local selection of the quote's
maximum-input and minimum-output bounds. It generates strict `approval_v3` in
memory and does not claim that `--caller-approved` proves human approval. For
custom stricter bounds or an independently reviewable approval artifact, keep
the three-step path: run `assetfare-select` with explicit bounds and pass its
mode-0600 `approval.json` to `assetfare-plan --approval approval.json`.

`assetfare-plan` validates the quote and approval binding, makes only the
selected prepare/session POST, checks the returned path/provider/bounds and
ActionSafetyReceiptV1/raw/action/bundle hashes, and stops unsigned and
unsubmitted. Session tokens never appear in stdout or structured results. The
optional token output path must not exist and is created mode 0600; omit it only
if loss of recovery after process exit is acceptable.

The evaluator defaults to the representative USD 1,000
`solana:USDC -> base:USDC` request. That USDC result is one AssetFare candidate,
not a cross-provider market comparison. If `solana:SOL -> base:ETH` is requested
explicitly, it also requests same-input Relay and Mayan snapshots with
placeholder public addresses. Those comparison rows are not executable orders;
every provider must be requoted with the caller's real addresses and actual
intended amount before selection or signing.

Read-only framework integrations are available for
[Coinbase AgentKit](./integrations/coinbase-agentkit/) and
[GOAT](./integrations/goat-sdk/), plus project-reviewed (a project-authored repository review, not independent third-party assurance)
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
[`assetfare/smolagents-assetfare`](https://github.com/assetfare/smolagents-assetfare).

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
its passed-through `caller_action_plan_handoff`. `amountUsd` must be finite and
at least 1; the adapter imposes no maximum, while live upstream availability
and liquidity still apply. Two additional caller-approved A2A
skills mirror the MCP execution tools: a one-shot `prepare` operation and the full `session` lifecycle
(`session_create`, `session_get`, `observe_source`, `observe_output`,
`refresh_action`). Before calling `session_create`, the A2A client generates
its session token locally; the remote A2A endpoint deliberately exposes no
token-generation operation. Each execution operation requires an explicit
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

Connecting is unauthenticated. The primary endpoint uses caller-owned public
wallets and, for session mode, a client-generated capability. Only the separate
legacy endpoint uses the wallet-bound token produced by the old signMessage
flow; never place either capability in an MCP configuration file.

## Agent skill

The portable Agent Skill is [`skills/assetfare-route/SKILL.md`](./skills/assetfare-route/SKILL.md).
Skills.lc-compatible clients can install it directly from this public GitHub repository.

```bash
npx --yes skills add assetfare/assetfare-mcp --skill assetfare-route -g -y
```

## Portable Agent Plugin

Clients that support the published vendor-neutral Agent Plugins 1.0 format can
install this repository from its Git URL. The current `plugins` CLI can install
the same MCP connection and AssetFare route-evaluation skill through the
included compatibility metadata:

```bash
npx plugins add assetfare/assetfare-mcp
```

The primary MCP endpoint is v2-only. Legacy wallet-auth/session tools are
isolated at `/mcp/legacy`. AssetFare never receives private keys, signs, or
submits, and the skill keeps REST/OpenAPI v2 as the primary evaluation path.

Circle Agent Stack and other shell-capable agents can use the same skill and
public REST/OpenAPI flow; see [`integrations/circle-agent-stack`](./integrations/circle-agent-stack/README.md).

## First-call evaluation

Run `npm run first-call-eval` to verify a fresh MCP client can discover the
primary v2 quote-only tools, validate current capabilities, and obtain a
representative USD 1,000 Solana-native-USDC to Base-native-USDC quote without
creating a wallet login, session, action, signature, or transaction. Legacy
tools are absent from the primary endpoint. Use USD 1 only for a deliberate
reachability/schema smoke test.

Use Streamable HTTP. The endpoint has no server-side API key. Read-only v2 tools
never authenticate a wallet; prepare/session tools require explicit caller
approval and public wallets. Legacy wallet authentication is a separate endpoint.

## Local stdio

The repository also contains a stdio-compatible all-tools wrapper for
self-hosting, including the local-only session-capability helper. The public
Registry entry uses the lean v2-only Streamable HTTP endpoint. Package and
Registry releases remain separately reviewed from remote deployment.

## npm release publishing

npm releases use GitHub Actions OIDC trusted publishing through
`.github/workflows/publish-npm.yml`. The workflow is manually dispatched with
an existing immutable `v<package-version>` GitHub release tag, verifies that
the exact tag is on `main` and matches `package.json`, runs the complete package
checks and production audit, refuses an already-published version, and publishes
with short-lived OIDC credentials. No npm write token is stored in GitHub or
this repository.

The npm trusted-publisher record is pinned to GitHub organization `assetfare`,
repository `assetfare-mcp`, and workflow filename `publish-npm.yml`. Direct
`npm publish` is allowed only for that workflow. Package settings should require
2FA and disallow traditional tokens after the OIDC connection is verified.

### Integration npm releases

The three unscoped integration packages use a separate, package-allowlisted
release path. Their immutable tags are pinned exactly as follows:

- `assetfare-agentkit-action-provider-v0.1.1`
- `assetfare-elizaos-route-plugin-v0.1.1`
- `assetfare-solana-agent-kit-plugin-v0.1.1`

`release-integration-provenance.yml` accepts only those three package choices.
It requires the corresponding lightweight tag to resolve to a commit signed by
the pinned AssetFare release key and contained in `main`, requires an already
published non-draft GitHub release, runs the package's locked checks, tests,
build, production audit, and pack verification, then uploads exactly the npm
tarball and its SHA-256 file and records GitHub build provenance. It never
publishes to npm.

Both workflows must be dispatched with `--ref` set to that package's exact tag,
never `main` or another branch/tag. They require `GITHUB_REF` to equal
`refs/tags/<exact-package-tag>` and `GITHUB_SHA` to equal the signed tag commit;
the tag itself must contain the same two workflow files and pinned signer data.
For example, after the trusted-publisher prerequisite below is complete, the
provenance phase for AgentKit is selected with
`gh workflow run release-integration-provenance.yml --ref assetfare-agentkit-action-provider-v0.1.1 -f package=assetfare-agentkit-action-provider`.
The publish phase uses the same `--ref` and package choice with
`publish-integration-npm.yml` only after provenance succeeds.

`publish-integration-npm.yml` accepts the same allowlist and version 0.1.1. It
repeats the signed-tag, release, manifest, lockfile, test, build, audit, and pack
checks; downloads only the two exact release assets; verifies GitHub's asset
digest, SHA-256 file, GitHub attestation, package identity, and byte-for-byte
reproducibility; then publishes that downloaded tarball with short-lived OIDC
credentials. An existing registry version is accepted only when its shasum
matches exactly; a conflict fails closed. The final gate requires the expected
`latest` tag, shasum, and npm SLSA provenance.

**Do not dispatch either integration release workflow until the target npm
package's Settings → Trusted Publisher entry is configured and independently
checked with organization `assetfare`, repository `assetfare-mcp`, exact
workflow filename `publish-integration-npm.yml`, no environment, and direct
`npm publish` permission.** Configure that exact entry separately for all three
packages. Do not substitute `publish-npm.yml`, a fork, a differently named
workflow, or an npm write token. The existing root v1.x provenance and publish
workflows remain separate and unchanged.

## Trust material

- Security contact: `security@assetfare.dev`
- Security policy and private reporting: `https://github.com/assetfare/assetfare-mcp/security/policy`
- Signed manifest: `https://api.assetfare.dev/.well-known/assetfare-manifest.json`
- Public signing key: `https://assetfare.dev/.well-known/assetfare-manifest.pub`
- Continuously revalidated operator ownership: `https://api.assetfare.dev/.well-known/owners.json`
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
- Dated Solana USDC → Base USDC comparison ($250, 2026-09-23; explicit non-all-in and non-identical-lane caveats): `https://assetfare.dev/compare/solana-usdc-to-base-usdc/`

## Discovery

- Official MCP Registry: `io.github.odaiin/assetfare` (legacy namespace pending Registry migration)
- MCP Servers: `https://mcpservers.org/servers/assetfare/assetfare-mcp`
- Smithery: `https://smithery.ai/servers/twotw55/assetfare`
- Glama: `https://glama.ai/mcp/connectors/io.github.odaiin/assetfare`
- Agent Skill: `https://www.skills.sh/assetfare/assetfare-mcp/assetfare-route`
- Dify Marketplace: `https://marketplace.dify.ai/plugin/odaiin/assetfare`
- Hugging Face quote tool: `https://huggingface.co/spaces/odaiin/assetfare-quote` (canonical reviewed revision `401ecf835a3e0c95807c245a208eeda81b0d9b81`)
- Hugging Face capabilities tool: `https://huggingface.co/spaces/odaiin/assetfare-capabilities` (canonical reviewed revision `995b5c5be4d88a6c94241ef22ac3a6581dfa8cdb`)
- A2A Registry: `https://a2aregistry.org/agents/d4f9ab1a-904c-4227-8fc6-548e45749de1`
- ARD: `https://assetfare.dev/.well-known/ard.json`

The wrapper deliberately contains no AssetFare route engine, wallets, RPC credentials, or internal operations data.

## Agent use case

For any supported six-chain source request, an agent first reads v2 capabilities and
requests a fresh quote through REST/OpenAPI or the read-only
`assetfare_v2_quote` MCP tool. Only an existing original-corridor client should
connect separately to `/mcp/legacy`. The caller independently signs and submits
every on-chain action; this MCP server never does.

See the first-call evaluation script, the public mainnet evidence at https://assetfare.dev/evidence/, and the end-to-end case study at https://assetfare.dev/case-studies/solana-to-base-mainnet-canary/.
