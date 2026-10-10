#!/usr/bin/env node
import express from "express";
import { isIP } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { z } from "zod";
import { AGENT_CARD_PATH, createAssetFareA2A } from "./a2a.js";
import { approvalDraft, approvalV3Schema, continuationV3CapabilitySchema, continuationV3Schema, reapprovalV3Schema, validateContinuationV3 } from "./continuation-v3.js";
import { DIRECT_ROUTE_CONTRACT_COUNTS, isTargetActiveRoute, validateDirectRouteSummary } from "./direct-route-summary.js";
import { validateExpandedEconomicPolicy, validatePreExpansionEconomicPolicy } from "./economic-guidance-policy.js";
import { isMain } from "./is-main.js";

const VERSION = "1.19.1";
const API_BASE = (process.env.ASSETFARE_API_BASE_URL || "https://api.assetfare.dev").replace(/\/$/, "");
// The legacy v1 API and the active-route v2 API run on separate local services
// in production. Reuse the already-required A2A/v2 base as the safe fallback,
// while allowing an explicit v2 override for other deployments.
const V2_API_BASE = (
  process.env.ASSETFARE_V2_API_BASE_URL
  || process.env.ASSETFARE_A2A_API_BASE_URL
  || "https://api.assetfare.dev"
).replace(/\/$/, "");
const HOST = process.env.ASSETFARE_MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.ASSETFARE_MCP_PORT || "8790");
const ORIGINS = new Set((process.env.ASSETFARE_MCP_ALLOWED_ORIGINS || "https://chatgpt.com,https://chat.openai.com,https://claude.ai,https://claude.com").split(",").map((value) => value.trim()).filter(Boolean));
const PUBLIC_HOST = process.env.ASSETFARE_MCP_PUBLIC_HOST || "api.assetfare.dev";
const A2A_API_BASE = (process.env.ASSETFARE_A2A_API_BASE_URL || "http://127.0.0.1:8791").replace(/\/$/, "");
const A2A_SERVICE_URL = process.env.ASSETFARE_A2A_SERVICE_URL || "https://api.assetfare.dev/a2a";
const A2A_DISCOVERY_CHANNELS = Object.freeze({
  "/discovery/a2aregistry/agent-card.json": "a2aregistry",
  "/discovery/apis-io/agent-card.json": "apis-io",
  "/discovery/manual/agent-card.json": "manual",
});
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, "127.0.0.1", "localhost"]);
const V2_TIMEOUT_MS = 45_000;
const V2_MAX_RESPONSE_BYTES = 1_048_576;
// Six-chain quote and caller-approved execution surface. Polygon and Optimism are
// directional native-USDC SOURCE-ONLY origins, but their four corridors are execution-ready.
const V2_SOURCE_CHAINS = ["solana", "base", "arbitrum", "robinhood", "polygon", "optimism", "ethereum", "hyperevm", "xlayer", "sei", "sonic", "monad", "avalanche", "cronos", "injective", "linea", "aptos", "unichain", "ink"];
const V2_DESTINATION_CHAINS = ["solana", "base", "arbitrum", "robinhood"];
const V2_SOURCE_ONLY_CHAINS = new Set(["polygon", "optimism", "ethereum", "hyperevm", "xlayer", "sei", "sonic", "monad", "avalanche", "cronos", "injective", "linea", "aptos", "unichain", "ink"]);
const V2_NO_FORWARD_SOURCE_ONLY_CHAINS = new Set(["polygon", "optimism"]);
const V2_EXPANSION_SOURCE_CHAINS = new Set(["ethereum", "hyperevm"]);
const V2_CANDIDATE_SOURCE_CHAINS = new Set(["xlayer", "sei", "sonic", "monad", "avalanche", "cronos", "injective", "linea", "aptos"]);
const V2_SOLANA_ONLY_SOURCE_CHAINS = new Set(["unichain", "ink"]);
const V2_TOKENS = ["SOL", "ETH", "USDC", "USDG"];
const V2_ENDPOINTS = new Set([
  "solana:SOL", "solana:USDC", "solana:USDG",
  "base:ETH", "base:USDC",
  "arbitrum:ETH", "arbitrum:USDC",
  "robinhood:ETH", "robinhood:USDG",
  "polygon:USDC",
  "optimism:USDC",
  "ethereum:USDC",
  "hyperevm:USDC",
  "xlayer:USDC",
  "sei:USDC",
  "sonic:USDC",
  "monad:USDC",
  "avalanche:USDC",
  "cronos:USDC",
  "injective:USDC",
  "linea:USDC",
  "aptos:USDC",
  "unichain:USDC",
  "ink:USDC",
]);
const V2_PRE_EXPANSION_ENDPOINTS = new Set([...V2_ENDPOINTS].filter((value)=>!["ethereum:","hyperevm:","xlayer:","sei:","sonic:","monad:","avalanche:","cronos:","injective:","linea:","aptos:","unichain:","ink:"].some((prefix)=>value.startsWith(prefix))));
const V2_PRE_100_ENDPOINTS = new Set([...V2_ENDPOINTS].filter((value)=>!["unichain:USDC","ink:USDC"].includes(value)));
const V2_TARGET_ENDPOINTS = new Set(V2_ENDPOINTS);
const V2_ROUTE_NAMES = new Set();
for (const source of V2_ENDPOINTS) for (const destination of V2_ENDPOINTS) {
  const [fromChain,fromToken]=source.split(":"),[toChain,toToken]=destination.split(":");
  if(source===destination||V2_SOURCE_ONLY_CHAINS.has(toChain))continue;
  if(V2_NO_FORWARD_SOURCE_ONLY_CHAINS.has(fromChain)&&!(fromToken==="USDC"&&["base","arbitrum"].includes(toChain)&&toToken==="USDC"))continue;
  if(V2_EXPANSION_SOURCE_CHAINS.has(fromChain)&&!(fromToken==="USDC"&&["base","solana"].includes(toChain)&&toToken==="USDC"))continue;
  if(V2_CANDIDATE_SOURCE_CHAINS.has(fromChain)&&!(fromToken==="USDC"&&["base","solana"].includes(toChain)&&toToken==="USDC"))continue;
  if(V2_SOLANA_ONLY_SOURCE_CHAINS.has(fromChain)&&!(fromToken==="USDC"&&toChain==="solana"&&toToken==="USDC"))continue;
  V2_ROUTE_NAMES.add(`${source}->${destination}`);
}
// Canonical caller_action_plan_handoff shape (upstream is the authority; the adapter
// FAIL-CLOSES if it deviates). Fixed origin for the caller-operated prepare/session REST.
const V2_PREPARE_URL = "https://api.assetfare.dev/v2/prepare";
const V2_SESSION_URL = "https://api.assetfare.dev/v2/session";
const V2_HANDOFF_REQUEST_FIELDS = ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets", "event_signer_public"];
const V2_FEE_COLLECTION_CONST = "only_on_eligible_successful_executor_step";
const V2_SESSION_TOKEN_HEADER = "x-assetfare-session-token";
const V2_BUNDLE_VERSION = "assetfare-direct-multichain-action-v2";
const V2_BUNDLE_HASH_SPEC = "sha256(UTF-8 JSON with sorted keys and compact separators, excluding payload_sha256 itself)";
const LEGACY_STATUS_DESCRIPTION = "Read legacy v1 compatibility status and original-corridor safety gates. Use only before the unversioned Solana-SOL-to-Base/Arbitrum-ETH workflow; for every current v2 route use assetfare_v2_capabilities instead. Read-only; makes a network request and never authenticates, signs, submits, or advances a session.";
const LEGACY_QUOTE_DESCRIPTION = "Legacy v1 original-corridor quote: get Solana SOL to Base or Arbitrum ETH pricing. Use only with the unversioned legacy wallet-auth/session tools; for every new v2 evaluation use assetfare_v2_quote instead. Read-only; makes a network request and never authenticates, creates a session, prepares an action, signs, or submits.";
const V2_MANIFEST_DESCRIPTION = "Read the Ed25519-signed release manifest and safety-bundle binding before preparing an action. Example: call this once to verify the current release and contract pins; it never creates state, signs, or submits.";
const V2_CAPABILITIES_DESCRIPTION = "Read all 100 technically available routes, live provider readiness, route-specific guidance, direct_route_summary, and continuation_v3 contracts before quoting. Forty-four routes are price-recommended only at or above their published threshold; 56 have no current price recommendation. Example: call once before requesting an exact route quote. Confirm every fresh quote. Economic guidance is advisory and never adds an execution gate. continuation_v3 separately binds execution selection, wallets, bounds, and mode. Read-only; creates no wallet login, session, or action.";
const V2_ROUTE_SELECTION_DESCRIPTION = "Use recent multi-amount exploration only to shortlist three candidates, quote all three at the caller's actual requested amount, and return up to two fresh complete all-in recommendations. Example: compare Solana USDC to Base USDC at USD 347.25 with the balanced 60-second profile. Fast uses 30 seconds and economy is explicit up to 1,800 seconds; slower candidates are reference-only. The result is not execution approval and never prepares, signs, or submits.";
const V2_SELECTED_QUOTE_DESCRIPTION = "Return the chosen candidate's exact request-time quote without another provider call while it remains valid. If it expired, refresh only that candidate at the same amount and never silently reselect. Example: pass the chosen candidate_id and exact selection receipt hash. AssetFare quotes retain continuation_v3; external quotes contain normalized facts and a provider handoff without executable payloads. This tool never prepares, signs, submits, or creates transaction authority.";
const V2_QUOTE_DESCRIPTION = "Get one fresh AssetFare quote with amount-specific economic_guidance, direct_route_summary, continuation_v3, and unsigned_prepare_requirements. Example: quote Solana USDC to Base USDC. price_recommended_for_amount is advisory; compare alternatives when price matters, but no economic acknowledgement field is required. The quote remains an unranked_candidate until separate explicit approval selects one mode. The adapter validates hashes, path, bounds, and TTL and never creates approval, prepares, signs, or submits.";
const V2_NEW_SESSION_CAPABILITY_DESCRIPTION = "Local stdio only: generate one caller-owned 256-bit session capability without a network call. Remote MCP/A2A servers deliberately do not expose this helper; remote clients generate 32 random bytes locally, encode them as 43-character base64url without padding, and pass the result to assetfare_v2_session_create and every lifecycle call. The token is a sensitive bearer capability, never a private key.";
const V2_PREPARE_DESCRIPTION = "Return one deeply verified first unsigned bundle and caller-wallet handoff. Example: pass caller_approved=true, a one_shot approval_v3, and the quote-bound verification_context; multi-step routes reject one_shot. Economic guidance is advisory and adds no request field. Context is validated before the upstream request and never forwarded. AssetFare never signs or submits.";
const V2_SESSION_CREATE_DESCRIPTION = "Create one receipt-driven workflow. Example: pass caller_approved=true, a session approval_v3, its idempotency_key, a caller-local session token, and the quote-bound verification_context. Economic guidance is advisory and adds no request field. The adapter validates approval and context before the upstream request. Every returned action is deeply verified and receives a caller-wallet handoff. AssetFare never signs or submits.";
const V2_SESSION_GET_DESCRIPTION = "Read an existing v2 workflow without advancing it. Example: pass session_id, session_token, and the original verification_context after restart. The adapter deeply verifies any current_action and emits a self-verifying wallet handoff, or fails closed. Read-only; never signs or submits.";
const V2_SESSION_OBSERVE_SOURCE_DESCRIPTION = "Record source hashes the caller already signed and submitted, then advance the workflow. Example: pass one finalized source hash, a new idempotency key, and the original verification_context. Any next current_action is deeply verified and receives a wallet handoff. AssetFare never signs or submits.";
const V2_SESSION_OBSERVE_OUTPUT_DESCRIPTION = "Record an already-produced bridge or destination output, then advance the workflow. Example: pass the output hash, a new idempotency key, and the original verification_context. Any next current_action is deeply verified and receives a wallet handoff. AssetFare never signs or submits.";
const V2_SESSION_REFRESH_ACTION_DESCRIPTION = "Refresh an expired action only while it remains unsubmitted. Example: pass the existing session, a new idempotency key, and the original verification_context. The refreshed action is deeply verified and receives a wallet handoff. Never refresh a submitted step; AssetFare never signs or submits.";

const accessToken = z.string().min(20).max(512).describe("Sensitive legacy v1 wallet-bound bearer token returned by assetfare_finish_wallet_auth. Use only with unversioned legacy session tools; never log or use it as a v2 session capability.");
const legacySessionId = z.string().uuid().describe("Legacy v1 session UUID returned by assetfare_create_session. Use only with the unversioned legacy workflow; do not pass a v2 session ID.");
const v2SessionId = z.string().uuid().describe("V2 workflow session UUID returned by assetfare_v2_session_create. Use only with assetfare_v2_session_* tools; do not pass a legacy session ID.");
// Preserve the 1.1.x compatibility surface for legacy and legacy-advisory
// operations. Strict Core 2.4 approval_v3 carries its own constrained key and,
// when present on session creation, must exactly match this request field.
const idempotencyKey = z.string().min(8).max(128).describe("Caller-generated retry key, 8-128 characters. Reuse it only when retrying the same logical mutation; choose a new key for a new operation. Strict approval_v3 requests additionally enforce its ASCII key pattern.");
const sourceWallet = z.string().min(32).max(64).describe("Caller-owned Solana public wallet address for the legacy v1 source. Public address only; never provide a seed phrase or private key.");
const destinationWallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("Caller-owned Base or Arbitrum EVM destination address as 0x plus 40 hex characters. Public address only; never provide a private key.");
const legacyChallengeId = z.string().uuid().describe("Short-lived legacy wallet-login challenge UUID returned by assetfare_start_wallet_auth.");
const legacyQuoteId = z.string().uuid().describe("Fresh legacy v1 quote UUID returned by assetfare_quote. A v2 quote ID is invalid here.");
const legacySignature = z.string().min(64).max(128).describe("Caller-produced Solana signature for the exact indicated legacy message or transaction. Never provide a seed phrase, private key, or signed transaction payload.");
const legacyTermsVersion = z.string().min(1).max(160).describe("Exact terms version supplied in the legacy wallet-login challenge; copy it unchanged from that challenge.");
const legacyAmountUsd = z.number().finite().int().min(1).describe("Whole-dollar input value for the legacy Solana SOL route, minimum 1. Use assetfare_v2_quote for fractional amounts or any v2 route.");
const legacyDestinationChain = z.enum(["base", "arbitrum"]).default("base").describe("Legacy destination chain for SOL-to-ETH only: base or arbitrum. Use a v2 route tool for any other destination or token.");
const legacySessionView = z.enum(["session", "workflow", "receipt", "next_action"]).default("session").describe("Legacy read projection: session summary, workflow state, receipt, or next_action. This selection never advances the workflow.");
const legacyEventSignerPublic = sourceWallet.describe("Fresh caller-generated ephemeral Solana event signer public key for the legacy CCTP burn. Keep the matching private key client-side; never send it.");
const legacyTransactionHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("Destination EVM transaction hash already submitted by the caller, formatted as 0x plus 64 hex characters.");
const legacyQuoteIntent=z.object({amount_usd:legacyAmountUsd,destination_chain:legacyDestinationChain}).strict();
const legacyStartAuthIntent=z.object({source_wallet:sourceWallet}).strict();
const legacyFinishAuthIntent=z.object({challenge_id:legacyChallengeId,source_wallet:sourceWallet,signature:legacySignature,terms_version:legacyTermsVersion}).strict();
const legacyCreateSessionIntent=z.object({access_token:accessToken,quote_id:legacyQuoteId,idempotency_key:idempotencyKey,source_wallet:sourceWallet,destination_wallet:destinationWallet}).strict();
const legacyReadSessionIntent=z.object({access_token:accessToken,session_id:legacySessionId,view:legacySessionView}).strict();
const legacyPrepareSourceIntent=z.object({access_token:accessToken,session_id:legacySessionId}).strict();
const legacyVerifySourceIntent=z.object({access_token:accessToken,session_id:legacySessionId,signature:legacySignature,idempotency_key:idempotencyKey}).strict();
const legacyPrepareCctpIntent=z.object({access_token:accessToken,session_id:legacySessionId,event_signer_public:legacyEventSignerPublic,idempotency_key:idempotencyKey}).strict();
const legacyObserveCctpIntent=z.object({access_token:accessToken,session_id:legacySessionId,burn_signature:legacySignature.describe("Finalized Solana burn signature already submitted by the caller for this legacy CCTP step."),idempotency_key:idempotencyKey}).strict();
const legacyPrepareDestinationIntent=z.object({access_token:accessToken,session_id:legacySessionId,idempotency_key:idempotencyKey}).strict();
const legacyObserveDestinationIntent=z.object({access_token:accessToken,session_id:legacySessionId,transaction_hash:legacyTransactionHash,idempotency_key:idempotencyKey}).strict();
const v2QuoteFields = {
  from_chain: z.enum(V2_SOURCE_CHAINS).describe("Source chain for the v2 route. Polygon, Optimism, Ethereum, HyperEVM, X Layer, Sei, Sonic, Monad, Avalanche, Cronos, Injective, Linea, Aptos, Unichain, and Ink are source-only and cannot be used as to_chain."),
  from_token: z.enum(V2_TOKENS).describe("Input token symbol on from_chain. The chain-token pair must appear in current v2 capabilities."),
  to_chain: z.enum(V2_DESTINATION_CHAINS).describe("Destination chain for the v2 route: Solana, Base, Arbitrum, or Robinhood Chain. Source-only chains are not destinations."),
  to_token: z.enum(V2_TOKENS).describe("Output token symbol on to_chain. The chain-token pair must appear in current v2 capabilities."),
  amount_usd: z.number().finite().min(1).describe("Requested input value in USD, minimum 1. USD 1 is reachability/schema smoke only. A USD 50 competitive bucket was observed only for dated 2026-09-23 Solana USDC to Base USDC evidence and must not be generalized to another corridor. USD 1,000 is the primary representative amount. SOL input includes a swap. Always quote the actual intended amount."),
};
const emptyStrictInput = z.object({}).strict();
const v2QuoteIntent = z.object(v2QuoteFields).strict();
const v2SelectionProfile=z.enum(["fast","balanced","economy"]).optional().describe("Time policy: fast (30s), balanced (60s default), or explicit economy (up to 1,800s).");
const v2SelectionMaxEta=z.number().int().min(1).max(1800).optional().describe("Optional stricter maximum ETA in seconds; it cannot exceed the selected profile limit.");
const v2RouteSelectionIntent = z.object({...v2QuoteFields,profile:v2SelectionProfile,max_eta_seconds:v2SelectionMaxEta}).strict();
const v2SelectedQuoteIntent = z.object({...v2QuoteFields,profile:v2SelectionProfile,max_eta_seconds:v2SelectionMaxEta,candidate_id:z.string().min(1).max(160).describe("Exact candidate_id returned by assetfare_v2_route_selection; it is never chosen automatically."),selection_receipt_sha256:z.string().regex(/^[0-9a-f]{64}$/).describe("Exact selection_receipt.sha256 returned with the fresh shortlist.")}).strict();
// A caller-generated session capability token: high-entropy, url-safe, 43-128 chars.
// It is a SENSITIVE bearer capability, NOT a private key; the server stores only its hash.
const v2SessionToken = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/).describe("Sensitive caller-generated v2 session capability: at least 32 CSPRNG bytes encoded as 43-128 URL-safe base64 characters. Generate it locally; never log it or substitute a private key or legacy access token.");
// Public wallet address: EVM 0x-40-hex or Solana base58 (32-44). Never a private key/seed.
const v2PublicAddress = z.string().refine((value) => /^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(value) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value), "assetfare_v2_wallet_not_public_address").describe("Caller-owned public wallet address: 0x plus 40 hex characters for EVM, 0x plus 64 hex characters for Aptos, or 32-44 base58 characters for Solana. Never provide secret key material.");
const v2EventSignerPublic = v2PublicAddress.describe("Solana CCTP only: caller-generated ephemeral public key. Keep the matching private key client-side and use it to co-sign the returned unsigned event-account transaction; never send the private key.");
const v2WalletMap = z.record(z.enum(V2_SOURCE_CHAINS), v2PublicAddress).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 19, "assetfare_v2_wallets_out_of_range").describe("Map each chain needed by this route to the caller's public wallet address. Include public addresses only; never private keys or seed phrases.");
const v2OneShotApproval=approvalV3Schema.extend({selected_mode:z.literal("one_shot")}).strict();
const v2SessionApproval=approvalV3Schema.extend({selected_mode:z.literal("session")}).strict();
const v2PrepareFields = {
  caller_approved: z.literal(true).describe("Legacy caller assertion that MUST be supplied explicitly. It is not human-proof and is never auto-inserted; approval_v3 adds server-enforced quote binding."),
  ...v2QuoteFields,
  wallets: v2WalletMap,
  event_signer_public: v2EventSignerPublic.optional(),
  approval_v3: v2OneShotApproval.optional().describe("Strict Core 2.4.1 one_shot quote-bound selection from the exact unexpired quote. Required for every new flow; omission remains legacy_advisory compatibility only."),
};
let v2PrepareIntent;
let v2SessionCreateIntent;
const v2TransactionHashes = z.array(z.string().min(16).max(128)).min(1).max(8).describe("One to eight hashes for source transactions the caller already signed and submitted. Do not provide unsigned payloads or destination hashes.");
const v2OutputTransactionHash = z.string().min(16).max(128).optional().describe("Optional bridge or destination transaction hash already produced outside AssetFare. Omit only when the provider output can be observed without a hash.");
let v2SessionReadIntent,v2SessionObserveSourceIntent,v2SessionObserveOutputIntent,v2SessionRefreshIntent;
const v2SessionCapabilityOutput = z.object({
  session_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/).describe("New 256-bit, URL-safe caller-owned bearer capability. Treat as sensitive and never log, share, or persist it in plaintext."),
  token_bits: z.literal(256).describe("Entropy size of the generated CSPRNG token in bits."),
  token_length: z.literal(43).describe("Length of the unpadded base64url token in characters."),
  sensitivity: z.literal("sensitive_capability").describe("Classification showing that the token is a sensitive bearer capability."),
  is_private_key: z.literal(false).describe("Always false: this capability is not a wallet private key and cannot sign transactions."),
  usage: z.string().min(1).describe("Handling and tool-use instructions for the capability."),
  server_signing: z.literal(false).describe("Always false: AssetFare never signs caller transactions."),
  server_submission: z.literal(false).describe("Always false: AssetFare never submits caller transactions."),
}).strict();
const V2_SOURCE_ONLY_ENDPOINTS = ["ethereum:USDC", "hyperevm:USDC", "optimism:USDC", "polygon:USDC", "xlayer:USDC", "sei:USDC", "sonic:USDC", "monad:USDC", "avalanche:USDC", "cronos:USDC", "injective:USDC", "linea:USDC", "aptos:USDC", "unichain:USDC", "ink:USDC"];
const V2_SOURCE_ONLY_ROUTES = ["ethereum:USDC->base:USDC", "ethereum:USDC->solana:USDC", "hyperevm:USDC->base:USDC", "hyperevm:USDC->solana:USDC", "optimism:USDC->arbitrum:USDC", "optimism:USDC->base:USDC", "polygon:USDC->arbitrum:USDC", "polygon:USDC->base:USDC", ...["xlayer","sei","sonic","monad","avalanche","cronos","injective","linea","aptos"].flatMap((chain)=>[`${chain}:USDC->base:USDC`,`${chain}:USDC->solana:USDC`]), "unichain:USDC->solana:USDC", "ink:USDC->solana:USDC"];
const V2_PRE_100_SOURCE_ONLY_ROUTES = V2_SOURCE_ONLY_ROUTES.filter((route)=>!route.startsWith("unichain:")&&!route.startsWith("ink:"));
const V2_TARGET_SOURCE_ONLY_ROUTES = ["ethereum:USDC->solana:USDC", "hyperevm:USDC->solana:USDC", "optimism:USDC->base:USDC", ...["xlayer","sei","sonic","monad","avalanche","cronos","injective","linea","aptos"].flatMap((chain)=>[`${chain}:USDC->base:USDC`,`${chain}:USDC->solana:USDC`])];
const callerOwnedExecutionBase={supported:z.literal(true),scope:z.literal("caller_process_only"),package:z.literal("assetfare-mcp"),command:z.literal("assetfare-agent-runner"),key_location:z.literal("caller_wallet_adapter_only"),remote_mcp_tool:z.literal(false),a2a_remote_skill:z.literal(false),assetfare_server_key_access:z.literal(false),assetfare_server_signing:z.literal(false),assetfare_server_submission:z.literal(false)};
const callerOwnedAgentExecutionSchema=z.union([
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v1"),minimum_package_version:z.literal("1.5.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v1.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v1")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.6.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.6.1"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.6.2"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.7.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.7.1"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.8.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.8.1"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.8.2"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.8.3"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.8.4"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.9.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.10.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.11.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.12.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.13.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.13.1"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.13.2"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.14.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.14.1"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.14.2"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.14.3"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.14.4"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.14.5"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.15.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.15.1"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.15.3"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.16.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.17.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.18.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.19.0"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
  z.object({...callerOwnedExecutionBase,version:z.literal("assetfare-caller-owned-agent-execution-v2"),minimum_package_version:z.literal("1.19.1"),policy_schema:z.literal("https://assetfare.dev/schemas/caller-owned-execution-policy-v2.json"),wallet_adapter_contract_version:z.literal("assetfare-caller-wallet-adapter-v2")}).strict(),
]);
const directRouteCapabilityLegacy=z.object({version:z.literal("assetfare-direct-route-summary-v1"),required_on_every_quote:z.literal(true),route_count:z.literal(76),step_count:z.literal(172),ordered_provider_path:z.literal(true),normalized_chain_asset_endpoints:z.literal(true),base_unit_amounts_are_decimal_strings:z.literal(true),assetfare_fee_step_bound:z.literal(true),classification_values:z.tuple([z.literal("direct_protocol_only"),z.literal("external_intent")]),route_aggregator_used_scope:z.literal("assetfare_engine_only"),external_intent:z.literal("Across only for Robinhood ingress; provider-internal liquidity sourcing or aggregation remains possible"),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const directRouteCapabilityPrevious=z.object({version:z.literal("assetfare-direct-route-summary-v1"),required_on_every_quote:z.literal(true),route_count:z.literal(76),primary_direct_route_count:z.literal(67),external_coverage_only_route_count:z.literal(9),step_count:z.literal(170),ordered_provider_path:z.literal(true),normalized_chain_asset_endpoints:z.literal(true),base_unit_amounts_are_decimal_strings:z.literal(true),assetfare_fee_step_bound:z.literal(true),classification_values:z.tuple([z.literal("direct_protocol_only"),z.literal("external_intent")]),product_classification_values:z.tuple([z.literal("primary_direct"),z.literal("external_coverage_only")]),economic_eligibility_is_route_and_amount_conditioned:z.literal(true),route_aggregator_used_scope:z.literal("assetfare_engine_only"),external_intent:z.literal("Across only for nine Robinhood ingress coverage routes; provider-internal liquidity sourcing or aggregation remains possible"),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const directRouteCapabilityCurrent=z.object({version:z.literal("assetfare-direct-route-summary-v1"),required_on_every_quote:z.literal(true),route_count:z.literal(76),primary_direct_route_count:z.literal(76),external_coverage_only_route_count:z.literal(0),step_count:z.literal(184),ordered_provider_path:z.literal(true),normalized_chain_asset_endpoints:z.literal(true),base_unit_amounts_are_decimal_strings:z.literal(true),assetfare_fee_step_bound:z.literal(true),classification_values:z.tuple([z.literal("direct_protocol_only"),z.literal("external_intent")]),product_classification_values:z.tuple([z.literal("primary_direct"),z.literal("external_coverage_only")]),economic_eligibility_is_route_and_amount_conditioned:z.literal(true),route_aggregator_used_scope:z.literal("assetfare_engine_only"),external_intent:z.literal("No public route uses an external intent protocol; provider-internal liquidity sourcing or aggregation remains possible"),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const directRouteCapabilityExpanded=z.object({version:z.literal("assetfare-direct-route-summary-v1"),required_on_every_quote:z.literal(true),route_count:z.literal(80),primary_direct_route_count:z.literal(80),external_coverage_only_route_count:z.literal(0),step_count:z.literal(188),ordered_provider_path:z.literal(true),normalized_chain_asset_endpoints:z.literal(true),base_unit_amounts_are_decimal_strings:z.literal(true),assetfare_fee_step_bound:z.literal(true),classification_values:z.tuple([z.literal("direct_protocol_only"),z.literal("external_intent")]),product_classification_values:z.tuple([z.literal("primary_direct"),z.literal("external_coverage_only")]),economic_eligibility_is_route_and_amount_conditioned:z.literal(true),route_aggregator_used_scope:z.literal("assetfare_engine_only"),external_intent:z.literal("No public route uses an external intent protocol; provider-internal liquidity sourcing or aggregation remains possible"),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const directRouteCapabilityPreviousTarget=z.object({version:z.literal("assetfare-direct-route-summary-v1"),required_on_every_quote:z.literal(true),route_count:z.literal(54),primary_direct_route_count:z.literal(54),external_coverage_only_route_count:z.literal(0),step_count:z.literal(95),ordered_provider_path:z.literal(true),normalized_chain_asset_endpoints:z.literal(true),base_unit_amounts_are_decimal_strings:z.literal(true),assetfare_fee_step_bound:z.literal(true),classification_values:z.tuple([z.literal("direct_protocol_only"),z.literal("external_intent")]),product_classification_values:z.tuple([z.literal("primary_direct"),z.literal("external_coverage_only")]),economic_eligibility_is_route_and_amount_conditioned:z.literal(true),route_aggregator_used_scope:z.literal("assetfare_engine_only"),external_intent:z.literal("No public route uses an external intent protocol; provider-internal liquidity sourcing or aggregation remains possible"),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const directRouteCapabilityTarget=z.object({version:z.literal("assetfare-direct-route-summary-v1"),required_on_every_quote:z.literal(true),route_count:z.literal(98),primary_direct_route_count:z.literal(98),external_coverage_only_route_count:z.literal(0),step_count:z.literal(206),ordered_provider_path:z.literal(true),normalized_chain_asset_endpoints:z.literal(true),base_unit_amounts_are_decimal_strings:z.literal(true),assetfare_fee_step_bound:z.literal(true),classification_values:z.tuple([z.literal("direct_protocol_only"),z.literal("external_intent")]),product_classification_values:z.tuple([z.literal("primary_direct"),z.literal("external_coverage_only")]),economic_eligibility_is_route_and_amount_conditioned:z.literal(true),route_aggregator_used_scope:z.literal("assetfare_engine_only"),external_intent:z.literal("No public route uses an external intent protocol; provider-internal liquidity sourcing or aggregation remains possible"),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const directRouteCapabilityRelease100=z.object({version:z.literal("assetfare-direct-route-summary-v1"),required_on_every_quote:z.literal(true),route_count:z.literal(100),primary_direct_route_count:z.literal(100),external_coverage_only_route_count:z.literal(0),step_count:z.literal(208),ordered_provider_path:z.literal(true),normalized_chain_asset_endpoints:z.literal(true),base_unit_amounts_are_decimal_strings:z.literal(true),assetfare_fee_step_bound:z.literal(true),classification_values:z.tuple([z.literal("direct_protocol_only"),z.literal("external_intent")]),product_classification_values:z.tuple([z.literal("primary_direct"),z.literal("external_coverage_only")]),economic_eligibility_is_route_and_amount_conditioned:z.literal(true),route_aggregator_used_scope:z.literal("assetfare_engine_only"),external_intent:z.literal("No public route uses an external intent protocol; provider-internal liquidity sourcing or aggregation remains possible"),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const guidanceCount=z.number().int().min(0).max(80),guidanceConfidenceCounts=z.object({measured_two_day:guidanceCount,measured_route_specific:guidanceCount,structural_estimate:guidanceCount,reworked_route_remeasure:guidanceCount,coverage_only_retest:guidanceCount}).strict().refine((value)=>Object.values(value).reduce((sum,count)=>sum+count,0)===80),guidanceDistribution=z.object({"50":guidanceCount,"100":guidanceCount,"250":guidanceCount,"500":guidanceCount,"1000":guidanceCount,"2500":guidanceCount,"5000":guidanceCount,"10000":guidanceCount}).strict().refine((value)=>Object.values(value).reduce((sum,count)=>sum+count,0)===80);
const economicGuidanceCapabilityLegacy=z.object({version:z.literal("assetfare-route-economic-guidance-v1"),as_of:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),route_count:z.literal(80),currency:z.literal("USD"),technical_quote_minimum_usd:z.literal(1),economic_guidance_is_non_enforcing:z.literal(true),amount_is_never_rejected_by_economic_guidance:z.literal(true),values_change_with_market:z.literal(true),fresh_quote_and_caller_decision_control:z.literal(true),update_policy:z.literal("append_daily_observations_then_replace_values_without_schema_change"),confidence_counts:guidanceConfidenceCounts,advisory_start_distribution:guidanceDistribution}).strict();
const targetGuidanceCount=z.number().int().min(0).max(100),targetGuidanceDistribution=z.object({"50":targetGuidanceCount,"100":targetGuidanceCount,"250":targetGuidanceCount,"500":targetGuidanceCount,"1000":targetGuidanceCount,"2500":targetGuidanceCount,"5000":targetGuidanceCount,"10000":targetGuidanceCount}).strict().refine((value)=>Object.values(value).reduce((sum,count)=>sum+count,0)===44),targetRecommendationCounts=z.object({active_price_verified:z.literal(44),active_availability_only:z.literal(10),active_compare_required:z.literal(44)}).strict();
const economicGuidanceCapabilityTarget=z.object({version:z.literal("assetfare-route-economic-guidance-v4"),as_of:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),route_count:z.literal(98),public_active_route_count:z.literal(98),public_inactive_route_count:z.literal(0),verified_best_from_route_count:z.literal(44),availability_only_route_count:z.literal(10),compare_required_route_count:z.literal(44),nonrecommended_route_count:z.literal(54),currency:z.literal("USD"),technical_quote_minimum_usd:z.literal(1),economic_guidance_is_non_enforcing:z.literal(true),economic_guidance_blocks_execution:z.literal(false),amount_is_never_rejected_by_economic_guidance:z.literal(true),values_change_with_market:z.literal(true),fresh_quote_and_caller_decision_control:z.literal(true),update_policy:z.literal("daily_measurement_with_three_day_recommendation_hysteresis_availability_separate"),first_use_zero_allowance_scenario:z.literal(true),expected_output_ranking:z.literal(true),incomplete_cost_never_promoted:z.literal(true),tested_ceiling_usd:z.literal(10000),advisory_start_distribution:targetGuidanceDistribution,recommendation_status_counts:targetRecommendationCounts}).strict();
const release100RecommendationCounts=z.object({active_price_verified:z.literal(44),active_availability_only:z.literal(10),active_compare_required:z.literal(46)}).strict();
const economicGuidanceCapabilityRelease100=z.object({version:z.literal("assetfare-route-economic-guidance-v4"),as_of:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),route_count:z.literal(100),public_active_route_count:z.literal(100),public_inactive_route_count:z.literal(0),verified_best_from_route_count:z.literal(44),availability_only_route_count:z.literal(10),compare_required_route_count:z.literal(46),nonrecommended_route_count:z.literal(56),currency:z.literal("USD"),technical_quote_minimum_usd:z.literal(1),economic_guidance_is_non_enforcing:z.literal(true),economic_guidance_blocks_execution:z.literal(false),amount_is_never_rejected_by_economic_guidance:z.literal(true),values_change_with_market:z.literal(true),fresh_quote_and_caller_decision_control:z.literal(true),update_policy:z.literal("daily_measurement_with_three_day_recommendation_hysteresis_availability_separate"),first_use_zero_allowance_scenario:z.literal(true),expected_output_ranking:z.literal(true),incomplete_cost_never_promoted:z.literal(true),tested_ceiling_usd:z.literal(10000),advisory_start_distribution:targetGuidanceDistribution,recommendation_status_counts:release100RecommendationCounts}).strict();
const previousRecommendationCounts=z.object({active_price_verified:z.literal(44),active_availability_only:z.literal(10),inactive_economics:z.literal(44)}).strict();
const economicGuidanceCapabilityPrevious=z.object({version:z.literal("assetfare-route-economic-guidance-v3"),as_of:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),route_count:z.literal(98),public_active_route_count:z.literal(54),public_inactive_route_count:z.literal(44),verified_best_from_route_count:z.literal(44),availability_only_route_count:z.literal(10),currency:z.literal("USD"),technical_quote_minimum_usd:z.literal(1),economic_guidance_is_non_enforcing:z.literal(true),amount_is_never_rejected_by_economic_guidance:z.literal(true),values_change_with_market:z.literal(true),fresh_quote_and_caller_decision_control:z.literal(true),update_policy:z.literal("daily_measurement_with_three_day_reactivation_hysteresis"),first_use_zero_allowance_scenario:z.literal(true),expected_output_ranking:z.literal(true),incomplete_cost_never_promoted:z.literal(true),tested_ceiling_usd:z.literal(10000),advisory_start_distribution:targetGuidanceDistribution,recommendation_status_counts:previousRecommendationCounts}).strict();
const economicGuidanceCapability=z.union([economicGuidanceCapabilityLegacy,economicGuidanceCapabilityPrevious,economicGuidanceCapabilityTarget,economicGuidanceCapabilityRelease100]);
const routeEconomicGuidanceLegacy=z.object({advisory_start_usd:z.union([50,100,250,500,1000,2500,5000,10000].map((value)=>z.literal(value))),advisory_role:z.enum(["observed_economic_zone_start","structural_evaluation_start_not_observed_eligibility","retest_start_not_economic_eligibility"]),status:z.enum(["observed_near_parity","observed_competitive_or_near_parity","provisional_evaluation_start","reworked_route_remeasure","coverage_only_retest"]),confidence:z.enum(["measured_two_day","measured_route_specific","structural_estimate","reworked_route_remeasure","coverage_only_retest"]),basis:z.string().min(1),tested_amounts_usd:z.array(z.number().int().positive()).max(8),not_an_execution_minimum:z.literal(true),not_a_best_price_guarantee:z.literal(true),fresh_quote_required:z.literal(true)}).strict();
const routeEconomicGuidanceTarget=z.object({advisory_start_usd:z.union([z.null(),...[50,100,250,500,1000,2500,5000,10000].map((value)=>z.literal(value))]),best_from_usd:z.union([z.null(),...[50,100,250,500,1000,2500,5000,10000].map((value)=>z.literal(value))]),best_from_verified:z.boolean(),availability_only:z.boolean(),public_activation_status:z.enum(["active_price_verified","active_availability_only","active_compare_required"]),public_active:z.literal(true),recommendation_status:z.enum(["active_price_verified","active_availability_only","active_compare_required"]),recommended_action:z.enum(["price_recommended_at_or_above_best_from_otherwise_no_price_recommendation","available_no_cheapest_price_claim_compare_if_price_matters","available_not_price_recommended_compare_if_price_matters"]),confidence:z.enum(["paired_all_in_snapshot","availability_only_no_price_claim","paired_all_in_snapshot_competitor_cheaper_through_tested_ceiling"]),basis:z.string().min(1),economic_selection_policy:z.literal("advisory_only_no_execution_gate"),economic_guidance_blocks_execution:z.literal(false),tested_amounts_usd:z.array(z.number().int().positive()).length(8),tested_ceiling_usd:z.literal(10000),not_an_execution_minimum:z.literal(true),not_a_best_price_guarantee:z.literal(true),fresh_quote_required:z.literal(true),quoted_amount_usd:z.number().finite().min(1),price_recommended_for_amount:z.boolean()}).strict().superRefine((value,context)=>{const price=value.public_activation_status==="active_price_verified",recommended=price&&value.best_from_usd!==null&&value.quoted_amount_usd>=value.best_from_usd;if(price!==value.best_from_verified||value.availability_only!==(value.public_activation_status==="active_availability_only")||value.advisory_start_usd!==value.best_from_usd||(price?value.advisory_start_usd===null:value.advisory_start_usd!==null)||value.price_recommended_for_amount!==recommended)context.addIssue({code:z.ZodIssueCode.custom,message:"economic guidance activation mismatch"});});
const routeEconomicGuidancePrevious=z.object({advisory_start_usd:z.union([z.null(),...[50,100,250,500,1000,2500,5000,10000].map((value)=>z.literal(value))]),best_from_usd:z.union([z.null(),...[50,100,250,500,1000,2500,5000,10000].map((value)=>z.literal(value))]),best_from_verified:z.boolean(),availability_only:z.boolean(),public_activation_status:z.enum(["active_price_verified","active_availability_only"]),public_active:z.literal(true),recommendation_status:z.enum(["active_price_verified","active_availability_only"]),recommended_action:z.enum(["use_assetfare_first_at_or_above_best_from","use_assetfare_when_route_availability_is_required_without_price_claim"]),confidence:z.enum(["paired_all_in_snapshot","availability_only_no_price_claim"]),basis:z.string().min(1),tested_amounts_usd:z.array(z.number().int().positive()).length(8),tested_ceiling_usd:z.literal(10000),not_an_execution_minimum:z.literal(true),not_a_best_price_guarantee:z.literal(true),fresh_quote_required:z.literal(true)}).strict();
const routeEconomicGuidance=z.union([routeEconomicGuidanceLegacy,routeEconomicGuidancePrevious,routeEconomicGuidanceTarget]);
const v2CapabilitiesResponse = z.object({
  status: z.literal("capped_public_agent_release"),
  public_api_enabled: z.literal(true),
  chains: z.array(z.enum(V2_SOURCE_CHAINS)).min(6).max(19),
  asset_endpoints: z.array(z.object({ chain: z.enum(V2_SOURCE_CHAINS), token: z.enum(V2_TOKENS) }).strict()).min(11).max(24),
  source_only_asset_endpoints:z.array(z.object({chain:z.enum(["polygon","optimism","ethereum","hyperevm","xlayer","sei","sonic","monad","avalanche","cronos","injective","linea","aptos","unichain","ink"]),token:z.literal("USDC")}).strict()).min(2).max(15),
  source_only_routes:z.array(z.enum(V2_SOURCE_ONLY_ROUTES)).min(4).max(28),
  directed_conversion_routes: z.union([z.literal(100),z.literal(98),z.literal(54),z.literal(42),z.literal(76),z.literal(80)]),
  unsigned_route_plans_ready: z.union([z.literal(100),z.literal(98),z.literal(54),z.literal(42),z.literal(76),z.literal(80)]),
  execution_ready_routes: z.union([z.literal(100),z.literal(98),z.literal(54),z.literal(42),z.literal(76),z.literal(80)]),
  execution_implemented_routes: z.union([z.literal(100),z.literal(98),z.literal(54),z.literal(42),z.literal(76),z.literal(80)]).optional(),
  currently_prepare_ready_routes: z.number().int().min(0).max(100).optional(),
  temporarily_unavailable_routes: z.array(z.string().min(1)).max(100).optional(),
  temporarily_unavailable_route_count: z.number().int().min(0).max(100).optional(),
  execution_availability: z.object({ status:z.enum(["available","degraded","unknown"]), provider:z.literal("circle_iris"), provider_dependent_routes:z.number().int().min(0).max(100), recent_fee_snapshot_usable:z.boolean(), guarantees_future_availability:z.literal(false) }).passthrough().optional(),
  direct_route_summary:z.union([directRouteCapabilityLegacy,directRouteCapabilityPrevious,directRouteCapabilityCurrent,directRouteCapabilityExpanded,directRouteCapabilityPreviousTarget,directRouteCapabilityTarget,directRouteCapabilityRelease100]),
  continuation_v3: continuationV3CapabilitySchema,
  action_lifetime:z.object({quote_ttl_seconds:z.literal(60),action_bundle_ttl_seconds:z.literal(180),onchain_deadline_seconds:z.literal(240),wallet_ready_minimum_remaining_seconds:z.literal(120),refresh_policy:z.literal("expired_unsubmitted_only"),server_signing:z.literal(false),server_submission:z.literal(false)}).strict(),
  caller_owned_agent_execution:callerOwnedAgentExecutionSchema,
  economic_guidance:economicGuidanceCapability.optional(),
  phase_b_blocked_routes: z.literal(0),
  blocked_source_only_routes: z.array(z.never()).length(0),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).passthrough();
const v2SeparatelyPaidCost=z.object({provider:z.string().min(1),kind:z.enum(["layerzero_native_fee","source_chain_network_fee_estimate"]),paid_in:z.string().regex(/^[a-z0-9]+:[A-Z0-9]+$/),expected_amount_base:z.string().regex(/^[0-9]+$/),maximum_amount_base:z.string().regex(/^[0-9]+$/),decimals:z.number().int().min(0).max(18),expected_usd:z.number().finite().nonnegative(),maximum_usd:z.number().finite().nonnegative(),included_in_receive_amount:z.literal(false),basis:z.string().min(1)}).strict().refine((value)=>value.maximum_usd>=value.expected_usd&&BigInt(value.maximum_amount_base)>=BigInt(value.expected_amount_base));
const v2NativeBalanceRequirement=z.object({paid_in:z.string().regex(/^[a-z0-9]+:[A-Z0-9]+$/),decimals:z.number().int().min(0).max(18),expected_amount_base:z.string().regex(/^[0-9]+$/),maximum_amount_base:z.string().regex(/^[0-9]+$/),expected_amount:z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),maximum_amount:z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),expected_usd:z.number().finite().nonnegative(),maximum_usd:z.number().finite().nonnegative(),includes:z.array(z.enum(["layerzero_native_fee","source_chain_network_fee_estimate"])).min(1),included_in_receive_amount:z.literal(false),basis:z.string().min(1)}).strict().refine((value)=>value.maximum_usd>=value.expected_usd&&BigInt(value.maximum_amount_base)>=BigInt(value.expected_amount_base));
const v2CostSummaryCurrent = z.object({
  scope:z.literal("token_path_only_network_gas_excluded"), input_value_usd:z.number().finite().nonnegative(), expected_receive_value_usd:z.number().finite().nonnegative(), minimum_receive_value_usd:z.number().finite().nonnegative(), expected_total_cost_usd:z.number().finite().nonnegative(), maximum_total_cost_usd:z.number().finite().nonnegative(), expected_total_cost_percent:z.number().finite().nonnegative(), maximum_total_cost_percent:z.number().finite().nonnegative(),
  token_path_expected_cost_usd:z.number().finite().nonnegative(),token_path_maximum_cost_usd:z.number().finite().nonnegative(),separately_paid_costs:z.array(v2SeparatelyPaidCost),expected_all_in_cost_usd_estimate:z.number().finite().nonnegative(),maximum_all_in_cost_usd_estimate:z.number().finite().nonnegative(),expected_all_in_cost_percent_estimate:z.number().finite().nonnegative(),maximum_all_in_cost_percent_estimate:z.number().finite().nonnegative(),all_in_estimate_complete:z.boolean(),native_balance_requirements:z.array(v2NativeBalanceRequirement),source_native_balance_required:v2NativeBalanceRequirement.nullable(),
  assetfare_service_fee:z.object({bps:z.literal(1),estimated_usd:z.number().finite().nonnegative(),included_in_receive_amount:z.literal(true),note:z.string().min(1)}).strict(),
  provider_fee_components:z.array(z.object({provider:z.string().min(1),kind:z.string().min(1),expected_usd:z.number().finite().nonnegative(),maximum_usd:z.number().finite().nonnegative(),included_in_receive_amount:z.literal(true)}).passthrough().refine((value)=>value.maximum_usd>=value.expected_usd)),
  unpriced_costs:z.array(z.string().min(1)).min(1), rankable_all_in:z.literal(false), small_amount_warning:z.boolean(), warning:z.string().min(1).nullable(),
}).strict();
const v2CostSummaryLegacy=z.object({scope:z.literal("token_path_only_network_gas_excluded"),input_value_usd:z.number().finite().nonnegative(),expected_receive_value_usd:z.number().finite().nonnegative(),minimum_receive_value_usd:z.number().finite().nonnegative(),expected_total_cost_usd:z.number().finite().nonnegative(),maximum_total_cost_usd:z.number().finite().nonnegative(),expected_total_cost_percent:z.number().finite().nonnegative(),maximum_total_cost_percent:z.number().finite().nonnegative(),assetfare_service_fee:z.object({bps:z.literal(1),estimated_usd:z.number().finite().nonnegative(),included_in_receive_amount:z.literal(true),note:z.string().min(1)}).strict(),provider_fee_components:z.array(z.object({provider:z.string().min(1),kind:z.string().min(1),expected_usd:z.number().finite().nonnegative(),maximum_usd:z.number().finite().nonnegative(),included_in_receive_amount:z.literal(true)}).passthrough().refine((value)=>value.maximum_usd>=value.expected_usd)),unpriced_costs:z.array(z.string().min(1)).min(1),rankable_all_in:z.literal(false),small_amount_warning:z.boolean(),warning:z.string().min(1).nullable()}).strict();
const v2CostSummary=z.union([v2CostSummaryCurrent,v2CostSummaryLegacy]);
const v2EtaShape={estimated_time_seconds:z.number().int().positive().nullable(),estimated_time_range_seconds:z.tuple([z.number().int().nonnegative(),z.number().int().positive()]).nullable(),complete_route_estimate:z.boolean(),sources:z.array(z.string().url()),note:z.string().min(1)};
const v2Eta = z.object(v2EtaShape).strict().superRefine((value,context)=>{if(value.complete_route_estimate){if(value.estimated_time_seconds===null||value.estimated_time_range_seconds===null||value.estimated_time_range_seconds[0]>value.estimated_time_range_seconds[1]||value.estimated_time_range_seconds[1]!==value.estimated_time_seconds)context.addIssue({code:z.ZodIssueCode.custom,message:"eta_complete_inconsistent"});}else if(value.estimated_time_seconds!==null||value.estimated_time_range_seconds!==null)context.addIssue({code:z.ZodIssueCode.custom,message:"eta_incomplete_inconsistent"});});
const v2DirectRouteProviders=["raydium_clmm","orca_whirlpool","uniswap_v3","circle_cctp","circle_cctp_receive","paxos_usdg_layerzero_oft","across_intent_bridge"];
const v2DirectRouteModes=["aptos_move_cctp_direct","cctp_direct_composition","optimism_source_cctp","polygon_source_cctp","robinhood_across_ingress_composition","robinhood_paxos_egress_composition","robinhood_paxos_ingress_composition","same_chain_direct","same_chain_direct_composition"];
const v2EndpointNames=[...V2_ENDPOINTS],v2DestinationEndpointNames=v2EndpointNames.filter((value)=>!V2_SOURCE_ONLY_CHAINS.has(value.split(":",1)[0]));
const v2DirectRouteStep=z.object({index:z.number().int().min(0).max(7),action:z.enum(["swap","bridge","receive"]),provider:z.enum(v2DirectRouteProviders),from:z.enum(v2EndpointNames),to:z.enum(v2DestinationEndpointNames),expected_input_base:z.string().regex(/^[1-9][0-9]*$/),minimum_input_base:z.string().regex(/^[1-9][0-9]*$/),expected_output_base:z.string().regex(/^[1-9][0-9]*$/),minimum_output_base:z.string().regex(/^[1-9][0-9]*$/),assetfare_fee_bps:z.union([z.literal(0),z.literal(1)]),minimum_guard_bps:z.number().int().min(1).max(500).optional(),direct_protocol:z.boolean(),external_intent_protocol:z.boolean(),aggregator_api_used:z.literal(false)}).strict();
const v2DirectRouteSummary=z.object({version:z.literal("assetfare-direct-route-summary-v1"),route:z.enum([...V2_ROUTE_NAMES]),from:z.enum(v2EndpointNames),to:z.enum(v2DestinationEndpointNames),classification:z.enum(["direct_protocol_only","external_intent"]),mode:z.enum(v2DirectRouteModes),product_classification:z.enum(["primary_direct","external_coverage_only"]).optional(),economic_eligibility:z.enum(["not_asserted_by_capability","coverage_only_not_primary"]).optional(),public_execution_eligible:z.boolean().optional(),primary_selection_eligible:z.boolean().optional(),route_minimum_guard_bps:z.number().int().min(1).max(500).nullable().optional(),route_aggregator_used:z.literal(false),external_intent_protocol_used:z.boolean(),provider_internal_dex_aggregation_possible:z.boolean(),assetfare_fee_bps:z.literal(1),fee_collection_step_index:z.number().int().min(0).max(7),server_signing:z.literal(false),server_submission:z.literal(false),step_count:z.number().int().min(1).max(8),steps:z.array(v2DirectRouteStep).min(1).max(8)}).strict();
const v2RemoteVerificationContext=z.object({version:z.literal("assetfare-session-verification-context-v1"),intent:z.object(v2QuoteFields).strict(),wallets:v2WalletMap,event_signer_public:v2EventSignerPublic.nullable(),approval_v3:v2SessionApproval,direct_route_summary:v2DirectRouteSummary,verification_context_sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict().describe("Strict caller-held context copied from the selected quote and approval. It contains public intent/wallet data only, never the raw session token or a private key, and is required whenever a remote MCP session call can return current_action.");
const v2RemoteOneShotVerificationContext=z.object({version:z.literal("assetfare-one-shot-verification-context-v1"),intent:z.object(v2QuoteFields).strict(),wallets:v2WalletMap,event_signer_public:v2EventSignerPublic.nullable(),approval_v3:v2OneShotApproval,direct_route_summary:v2DirectRouteSummary,verification_context_sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict().describe("Strict caller-held one-shot context copied from the selected quote, approval and public wallets. It is verified before prepare and never forwarded upstream.");
v2PrepareIntent=z.object({...v2PrepareFields,approval_v3:v2OneShotApproval.describe("Strict one-shot approval copied from the exact unexpired selected quote; its bounds may only be strengthened."),verification_context:v2RemoteOneShotVerificationContext}).strict();
const remoteVerificationField={verification_context:v2RemoteVerificationContext};
v2SessionCreateIntent=z.object({ ...v2PrepareFields, approval_v3:v2SessionApproval.describe("Strict Core 2.4.1 session quote-bound selection from the exact unexpired quote. Required for every remote session flow."), session_token: v2SessionToken, idempotency_key: idempotencyKey,...remoteVerificationField }).strict();
v2SessionReadIntent=z.object({session_token:v2SessionToken,session_id:v2SessionId,...remoteVerificationField}).strict();
v2SessionObserveSourceIntent=z.object({session_token:v2SessionToken,session_id:v2SessionId,idempotency_key:idempotencyKey,transaction_hashes:v2TransactionHashes,...remoteVerificationField}).strict();
v2SessionObserveOutputIntent=z.object({session_token:v2SessionToken,session_id:v2SessionId,idempotency_key:idempotencyKey,transaction_hash:v2OutputTransactionHash,...remoteVerificationField}).strict();
v2SessionRefreshIntent=z.object({session_token:v2SessionToken,session_id:v2SessionId,idempotency_key:idempotencyKey,...remoteVerificationField}).strict();
const v2QuoteResponse = z.object({
  quote_id: z.string().uuid(),
  status: z.literal("capped_public_agent_release"),
  as_of: z.string().min(1).max(64),
  ttl_seconds: z.number().int().positive().max(60),
  intent: z.object({ from: z.string(), to: z.string(), amount_usd: z.number().finite(), estimated_input_base: z.number().int().positive() }).passthrough(),
  offer: z.object({
    expected_receive_amount: z.number().finite().positive(),
    estimated_min_receive_amount: z.number().finite().positive(),
    expected_receive_usd: z.number().finite().nonnegative(),
    estimated_min_receive_usd: z.number().finite().nonnegative(),
    output_symbol: z.enum(V2_TOKENS),
    estimated_time_seconds: z.number().int().nonnegative().nullable(),
    assetfare_fee_bps: z.literal(1),
    fee_modeled_bps: z.literal(1),
    fee_collectible_now: z.literal(true),
    fee_collection_steps: z.array(z.number().int().nonnegative()).length(1),
    fee_collection: z.literal(V2_FEE_COLLECTION_CONST),
  }).passthrough(),
  cost_summary: v2CostSummary.optional(),
  eta: v2Eta.optional(),
  economic_guidance: routeEconomicGuidance,
  route: z.object({
    steps: z.array(z.record(z.unknown())).min(1).max(8),
    server_signing: z.literal(false),
    server_submission: z.literal(false),
  }).passthrough(),
  direct_route_summary: v2DirectRouteSummary,
  continuation_v3: continuationV3Schema,
  risk: z.object({ server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough(),
  execution: z.object({
    supported: z.boolean(),
    first_unsigned_action_supported: z.boolean(),
  }).passthrough(),
  caller_action_plan_handoff: z.object({}).passthrough(),
}).passthrough();
const v2QuoteOutput = v2QuoteResponse.extend({ cost_summary:v2CostSummary, eta:z.object(v2EtaShape).strict() }).passthrough();
const v2RouteCandidateOutput=z.object({candidate_id:z.string().min(1).max(160),provider:z.string().min(1).max(160),provider_role:z.string().min(1).max(160),expected_receive_base:z.string().regex(/^[1-9][0-9]*$/),minimum_receive_base:z.string().regex(/^[1-9][0-9]*$/),all_in_cost_usd:z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),eta_seconds:z.number().int().positive(),eta_upper_bound_seconds:z.number().int().positive(),eta_basis:z.enum(["provider_reported","policy_conservative_bound","observed_p95"]),verification_tier:z.enum(["quote_verified","execution_verified"]),prepare_mode:z.enum(["assetfare_unsigned","external_handoff","external_unsigned"]),prepare_available:z.boolean(),assetfare_direct:z.boolean(),fee_included:z.literal(true),rank:z.number().int().min(1).max(2).optional(),excluded_reason:z.string().min(1).optional()}).passthrough();
const v2RouteSelectionOutput=z.object({schema_version:z.literal("assetfare-agent-route-selection-shadow-1.0.0"),status:z.enum(["recommendations_available","no_route_within_time_limit","no_comparable_candidate"]),shadow_only:z.literal(false),public_api_changed:z.literal(true),intent:z.object({route:z.enum([...V2_ROUTE_NAMES]),amount_usd:z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)}).strict(),selection_policy:z.object({profile:z.enum(["fast","balanced","economy"]),max_eta_seconds:z.number().int().min(1).max(1800),slower_than_limit_handling:z.literal("reference_only"),scope:z.string().min(1)}).strict(),recommendations:z.array(v2RouteCandidateOutput).max(2),reference_only:z.array(v2RouteCandidateOutput).max(3),assetfare_direct_reference:v2RouteCandidateOutput.nullable(),coverage:z.object({}).passthrough(),selection_receipt:z.object({version:z.literal("assetfare-agent-route-selection-receipt-1.0.0"),claim:z.object({}).passthrough(),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict(),as_of:z.string().min(1),request_amount_quoted_exactly:z.literal(true),request_time_exact_quote_count:z.number().int().min(1).max(3),shortlisted_candidate_count:z.literal(3),shortlisted_candidate_ids:z.array(z.string().min(1).max(160)).length(3),precompute_used_for_shortlisting_only:z.literal(true),precompute_amounts_used_usd:z.array(z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)).min(1).max(3),precompute_latest_evidence_at:z.string().min(1),exact_quote_failures:z.array(z.object({candidate_id:z.string().min(1).max(160),failure_class:z.string().min(1).max(160)}).strict()).max(3),fresh_requote_required_after_selection:z.literal(false),selection_quote_reused_while_valid:z.literal(true),expired_selection_refresh_scope:z.literal("selected_candidate_only_same_exact_amount"),automatic_reselection_forbidden:z.literal(true),selection_grants_execution_authority:z.literal(false),selection_quote_expires_at:z.string().min(1),safety:z.object({network_requests:z.literal(true),wallet_authentication:z.literal(false),prepare:z.literal(false),session:z.literal(false),signing:z.literal(false),submission:z.literal(false),funds_movement:z.literal(false),server_signing:z.literal(false),server_submission:z.literal(false),shortlist_is_not_customer_quote:z.literal(true),request_time_quotes_use_actual_amount:z.literal(true)}).strict()}).passthrough();
const v2RouteChoiceBinding=z.object({version:z.literal("assetfare-agent-route-choice-2.0.0"),candidate_id:z.string().min(1).max(160),selection_receipt_sha256:z.string().regex(/^[0-9a-f]{64}$/),selection_status:z.literal("explicitly_selected"),selection_grants_execution_authority:z.literal(false),request_time_quote_reused:z.boolean(),refresh_reason:z.literal("request_time_quote_expired").nullable(),refresh_scope:z.enum(["none","selected_candidate_only_same_exact_amount"]),automatic_reselection_forbidden:z.literal(true),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const v2ExternalFreshQuote=z.object({provider:z.enum(["mayan","relay","lifi","across"]),candidate_id:z.string().min(1).max(160),route:z.enum([...V2_ROUTE_NAMES]),amount_usd:z.number().finite().min(1),expected_receive_base:z.string().regex(/^[1-9][0-9]*$/),minimum_receive_base:z.string().regex(/^[1-9][0-9]*$/),all_in_cost_usd:z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),cost_complete:z.boolean(),eta_seconds:z.number().int().positive().nullable(),provider_variant:z.string().min(1).nullable(),contains_executable_payload:z.literal(false),requires_provider_confirmation:z.literal(true),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const v2SelectedQuoteBase={version:z.literal("assetfare-agent-route-choice-2.0.0"),choice_binding:v2RouteChoiceBinding,selected_candidate:v2RouteCandidateOutput,selection_quote_source:z.enum(["request_time_exact_quote","selected_candidate_expiry_refresh"]),server_signing:z.literal(false),server_submission:z.literal(false)};
const v2SelectedQuoteOutput=z.union([
  z.object({...v2SelectedQuoteBase,status:z.literal("fresh_assetfare_quote"),quote:v2QuoteOutput,next_step:z.string().min(1)}).strict(),
  z.object({...v2SelectedQuoteBase,status:z.literal("fresh_external_quote"),provider:z.enum(["mayan","relay","lifi","across"]),provider_quote_documentation:z.string().url().nullable(),intent:z.object({from:z.enum([...V2_ENDPOINTS]),to:z.enum([...V2_ENDPOINTS]),amount_usd:z.number().finite().min(1)}).strict(),fresh_quote:v2ExternalFreshQuote,instructions:z.string().min(1),assetfare_executes_external_route:z.literal(false)}).strict(),
]);
const v2SelectedQuoteToolOutput=z.object({version:z.literal("assetfare-agent-route-choice-2.0.0"),status:z.enum(["fresh_assetfare_quote","fresh_external_quote"]),choice_binding:v2RouteChoiceBinding,selected_candidate:v2RouteCandidateOutput,selection_quote_source:z.enum(["request_time_exact_quote","selected_candidate_expiry_refresh"]),server_signing:z.literal(false),server_submission:z.literal(false)}).passthrough();
const v2ManifestOutput = z.object({
  service: z.literal("AssetFare"),
  release_commit: z.string().regex(/^[0-9a-f]{40}$/),
  execution: z.record(z.unknown()),
  safety_bundle: z.object({ schema:z.string().url(), url:z.string().url(), sha256:z.string().regex(/^[0-9a-f]{64}$/), canonicalization:z.string().min(1) }).passthrough(),
  signature: z.object({ algorithm:z.literal("Ed25519"), key_id:z.string().min(1), public_key_url:z.string().url(), value:z.string().min(1) }).passthrough(),
}).passthrough();
const v2BundleOutput = z.object({
  version:z.literal(V2_BUNDLE_VERSION),
  workflow_id:z.string().uuid(), action_id:z.string().uuid(), step_index:z.number().int().nonnegative(), expires_at:z.string().min(1),
  unsigned_action:z.record(z.unknown()), payload_sha256:z.string().regex(/^[0-9a-f]{64}$/).describe(V2_BUNDLE_HASH_SPEC), payload_sha256_spec:z.literal(V2_BUNDLE_HASH_SPEC),
  server_signing:z.literal(false), server_submission:z.literal(false), signed:z.literal(false), submitted:z.literal(false),
}).passthrough();
const v2VerifiedBundleOutput=z.object({
  bundle:v2BundleOutput.describe("Exact Core bundle whose payload_sha256 remains scoped only to this nested object."),
  semantic_verification:z.literal(true).describe("True only after full decoded action, intent, receipt, payload and caller-bound verification."),
  action_verification:z.record(z.unknown()).describe("Fail-closed semantic and approval-bound verification result; it never authorizes a signature by itself."),
  caller_wallet_handoff:z.record(z.unknown()).describe("Fresh self-verifying EIP-1193 or Solana Wallet Standard handoff. The caller still simulates, confirms, signs and submits."),
}).strict();
const v2SessionQuoteBindingV3=z.object({version:z.literal("assetfare-quote-bound-session-constraints-v1"),quote_id:z.string().uuid(),quote_fingerprint:z.string().regex(/^[0-9a-f]{64}$/),selected_mode:z.literal("session"),whole_session_path_and_bounds_enforced:z.literal(true),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const v2SessionQuoteBindingLegacy=z.object({version:z.literal("legacy_advisory"),whole_session_path_and_bounds_enforced:z.literal(false),server_signing:z.literal(false),server_submission:z.literal(false)}).strict();
const v2SessionOutput = z.object({
  session_id:z.string().uuid(), status:z.string().min(1), action_available:z.boolean(), current_action:z.union([v2BundleOutput,z.null()]),
  quote_binding:z.union([v2SessionQuoteBindingV3,v2SessionQuoteBindingLegacy]),
  server_signing:z.literal(false), server_submission:z.literal(false), signed:z.literal(false), submitted:z.literal(false),
}).passthrough();

function asText(value, isError = false, includeStructuredContent = false) {
  const result = { isError, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  if (!isError && includeStructuredContent) result.structuredContent = value;
  return result;
}

function provenanceFromHeaders(headers) {
  const forwarded = typeof headers["x-forwarded-for"] === "string" ? headers["x-forwarded-for"].trim() : "";
  const userAgent = typeof headers["user-agent"] === "string" ? headers["user-agent"].trim().slice(0, 512) : "";
  return { requestIdentity: forwarded && !forwarded.includes(",") && isIP(forwarded) ? forwarded : "", userAgent };
}

async function responseText(response, maximumBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("assetfare_v2_response_too_large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new Error("assetfare_v2_response_too_large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("assetfare_v2_response_too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function safeV2ErrorPayload(payload, status) {
  if(status===409){
    let safe;
    try{safe=reapprovalV3Schema.parse(payload);}
    catch{throw Object.assign(new Error("assetfare_v2_request_rejected"),{status,payload:{error:"assetfare_v2_request_rejected"}});}
    return Object.assign(new Error(safe.error),{status,payload:safe});
  }
  const error = status === 429 ? "assetfare_v2_rate_limited" : status >= 500 ? "assetfare_v2_upstream_unavailable" : "assetfare_v2_request_rejected";
  const value = { error };
  if (Number.isInteger(payload?.retry_after_seconds) && payload.retry_after_seconds >= 0 && payload.retry_after_seconds <= 3600) value.retry_after_seconds = payload.retry_after_seconds;
  return Object.assign(new Error(error), { status, payload: value });
}

function apiClient(provenance = {}, baseUrl = API_BASE) {
  return async function api(path, { method = "GET", body, token, timeoutMs = 30_000, maximumBytes = 0, rejectRedirects = false, sanitizeErrors = false, extraHeaders } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (extraHeaders && typeof extraHeaders === "object") for (const [key, value] of Object.entries(extraHeaders)) if (typeof value === "string" && value) headers[key] = value;
  if (provenance.requestIdentity) headers["x-forwarded-for"] = provenance.requestIdentity;
  if (provenance.userAgent) headers["user-agent"] = provenance.userAgent;
  headers["x-assetfare-channel"] = "mcp";
  let response;
  try {
    response = await fetch(baseUrl + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: rejectRedirects ? "error" : "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (sanitizeErrors) throw new Error("assetfare_v2_upstream_unavailable");
    throw error;
  }
  let payload;
  if (maximumBytes > 0) {
    const mediaType = String(response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    if (mediaType !== "application/json" && !mediaType.endsWith("+json")) throw new Error("assetfare_v2_response_invalid");
    const text = await responseText(response, maximumBytes);
    try { payload = JSON.parse(text); }
    catch { throw new Error("assetfare_v2_response_invalid"); }
    if (!payload || Array.isArray(payload) || typeof payload !== "object") throw new Error("assetfare_v2_response_invalid");
  } else {
    payload = await response.json().catch(() => ({ error: "assetfare_non_json_response" }));
  }
  if (!response.ok) {
    if (sanitizeErrors) throw safeV2ErrorPayload(payload, response.status);
    const error = typeof payload.error === "string" ? payload.error : "assetfare_request_failed";
    throw Object.assign(new Error(error), { status: response.status, payload });
  }
  return payload;
  };
}

function readonly() { return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }; }
function quoteOnly() { return { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true }; }
function stateful(idempotent = false) { return { readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: true }; }

function parseV2Intent(args) {
  let intent;
  try { intent = v2QuoteIntent.parse(args); }
  catch { throw new Error("assetfare_v2_quote_intent_invalid"); }
  const source = `${intent.from_chain}:${intent.from_token}`;
  const destination = `${intent.to_chain}:${intent.to_token}`;
  if (!V2_ENDPOINTS.has(source)) throw new Error("assetfare_v2_source_endpoint_unsupported");
  if (!V2_ENDPOINTS.has(destination)) throw new Error("assetfare_v2_destination_endpoint_unsupported");
  if (source === destination) throw new Error("assetfare_v2_identity_route_not_required");
  if (V2_NO_FORWARD_SOURCE_ONLY_CHAINS.has(intent.from_chain) && !(intent.from_token === "USDC" && ["base", "arbitrum"].includes(intent.to_chain) && intent.to_token === "USDC")) throw new Error("assetfare_v2_source_only_route_unsupported");
  if (V2_EXPANSION_SOURCE_CHAINS.has(intent.from_chain) && !(intent.from_token === "USDC" && ["base", "solana"].includes(intent.to_chain) && intent.to_token === "USDC")) throw new Error("assetfare_v2_source_only_route_unsupported");
  if (V2_CANDIDATE_SOURCE_CHAINS.has(intent.from_chain) && !(intent.from_token === "USDC" && ["base", "solana"].includes(intent.to_chain) && intent.to_token === "USDC")) throw new Error("assetfare_v2_source_only_route_unsupported");
  if (V2_SOLANA_ONLY_SOURCE_CHAINS.has(intent.from_chain) && !(intent.from_token === "USDC" && intent.to_chain === "solana" && intent.to_token === "USDC")) throw new Error("assetfare_v2_source_only_route_unsupported");
  return intent;
}

function parseV2RouteSelectionIntent(args, selected = false) {
  let value;
  try { value=(selected?v2SelectedQuoteIntent:v2RouteSelectionIntent).parse(args); }
  catch { throw new Error(selected?"assetfare_v2_selected_quote_intent_invalid":"assetfare_v2_route_selection_intent_invalid"); }
  parseV2Intent({from_chain:value.from_chain,from_token:value.from_token,to_chain:value.to_chain,to_token:value.to_token,amount_usd:value.amount_usd});
  const profile=value.profile||"balanced",limit={fast:30,balanced:60,economy:1800}[profile];
  if(value.max_eta_seconds!==undefined&&value.max_eta_seconds>limit)throw new Error("assetfare_v2_route_selection_time_limit_invalid");
  return value;
}

function parseV2RouteSelection(payload,intent){
  rejectSigningClaims(payload);rejectPrivateOutputMaterial(payload);rejectUnsignedActionMaterial(payload);
  let value;try{value=v2RouteSelectionOutput.parse(payload);}catch{throw new Error("assetfare_v2_route_selection_response_invalid");}
  const route=`${intent.from_chain}:${intent.from_token}->${intent.to_chain}:${intent.to_token}`;
  if(value.intent.route!==route||Number(value.intent.amount_usd)!==intent.amount_usd||value.selection_policy.profile!==(intent.profile||"balanced")||(intent.max_eta_seconds!==undefined&&value.selection_policy.max_eta_seconds!==intent.max_eta_seconds))throw new Error("assetfare_v2_route_selection_binding_failed");
  if(value.request_amount_quoted_exactly!==true||value.precompute_used_for_shortlisting_only!==true||value.shortlisted_candidate_ids.length!==3||new Set(value.shortlisted_candidate_ids).size!==3)throw new Error("assetfare_v2_route_selection_binding_failed");
  if(value.status!=="recommendations_available"||value.recommendations.length<1||value.recommendations.length>2)throw new Error("assetfare_v2_route_selection_unavailable");
  const ids=value.recommendations.map((row)=>row.candidate_id);if(new Set(ids).size!==ids.length)throw new Error("assetfare_v2_route_selection_response_invalid");
  return value;
}

function parseV2SelectedQuote(payload,intent){
  rejectSigningClaims(payload);rejectPrivateOutputMaterial(payload);rejectUnsignedActionMaterial(payload);
  let value;try{value=v2SelectedQuoteOutput.parse(payload);}catch{throw new Error("assetfare_v2_selected_quote_response_invalid");}
  if(value.choice_binding.candidate_id!==intent.candidate_id||value.choice_binding.selection_receipt_sha256!==intent.selection_receipt_sha256)throw new Error("assetfare_v2_selected_quote_binding_failed");
  const reused=value.choice_binding.request_time_quote_reused===true;
  if((reused&&(value.choice_binding.refresh_reason!==null||value.choice_binding.refresh_scope!=="none"||value.selection_quote_source!=="request_time_exact_quote"))||(!reused&&(value.choice_binding.refresh_reason!=="request_time_quote_expired"||value.choice_binding.refresh_scope!=="selected_candidate_only_same_exact_amount"||value.selection_quote_source!=="selected_candidate_expiry_refresh")))throw new Error("assetfare_v2_selected_quote_binding_failed");
  if(value.selected_candidate.candidate_id!==intent.candidate_id)throw new Error("assetfare_v2_selected_quote_binding_failed");
  if(value.status==="fresh_assetfare_quote"){
    if(!intent.candidate_id.startsWith("assetfare:"))throw new Error("assetfare_v2_selected_quote_binding_failed");
    value.quote=parseV2Quote(value.quote,intent);
    const internal=intent.candidate_id==="assetfare:fixed_direct"?"assetfare_fixed_direct":intent.candidate_id.split(":",2)[1];
    if(value.quote.route_selection?.candidate_id!==internal||value.quote.route_selection?.automatic_reselection_forbidden!==true)throw new Error("assetfare_v2_selected_quote_binding_failed");
  }else if(intent.candidate_id.startsWith("assetfare:")||value.fresh_quote.candidate_id!==intent.candidate_id||value.fresh_quote.provider!==value.provider||value.fresh_quote.route!==`${intent.from_chain}:${intent.from_token}->${intent.to_chain}:${intent.to_token}`||value.fresh_quote.amount_usd!==intent.amount_usd||value.assetfare_executes_external_route!==false)throw new Error("assetfare_v2_selected_quote_binding_failed");
  return value;
}

// Gate a prepare/session route BEFORE any network call: endpoints must be real, the route
// must not be an identity, and directional source-only chains may use only their audited
// native-USDC corridors to Base or Arbitrum USDC.
function assertExecutableRoute(fromChain, fromToken, toChain, toToken, _amountUsd) {
  const source = `${fromChain}:${fromToken}`;
  const destination = `${toChain}:${toToken}`;
  if (!V2_ENDPOINTS.has(source)) throw new Error("assetfare_v2_source_endpoint_unsupported");
  if (!V2_ENDPOINTS.has(destination)) throw new Error("assetfare_v2_destination_endpoint_unsupported");
  if (source === destination) throw new Error("assetfare_v2_identity_route_not_required");
  if (V2_NO_FORWARD_SOURCE_ONLY_CHAINS.has(fromChain) && !(fromToken === "USDC" && ["base", "arbitrum"].includes(toChain) && toToken === "USDC")) throw new Error("assetfare_v2_source_only_route_unsupported");
  if (V2_EXPANSION_SOURCE_CHAINS.has(fromChain) && !(fromToken === "USDC" && ["base", "solana"].includes(toChain) && toToken === "USDC")) throw new Error("assetfare_v2_source_only_route_unsupported");
  if (V2_CANDIDATE_SOURCE_CHAINS.has(fromChain) && !(fromToken === "USDC" && ["base", "solana"].includes(toChain) && toToken === "USDC")) throw new Error("assetfare_v2_source_only_route_unsupported");
  if (V2_SOLANA_ONLY_SOURCE_CHAINS.has(fromChain) && !(fromToken === "USDC" && toChain === "solana" && toToken === "USDC")) throw new Error("assetfare_v2_source_only_route_unsupported");
}

// Reject any private key, seed phrase, signed transaction, or secret material a caller
// might mistakenly hand to a prepare/session tool. Public addresses and the session
// capability token are allowed; a raw private key never is.
function rejectSecretMaterial(value) {
  const forbiddenKeys = new Set(["private_key", "privatekey", "privkey", "secret_key", "secretkey", "seed", "seed_phrase", "mnemonic", "keypair", "secret", "signature", "signed_transaction", "signed_tx", "raw_transaction", "signed", "password", "passphrase"]);
  const stack = [[value, 0]]; let seen = 0;
  while (stack.length) {
    const [node, depth] = stack.pop(); seen += 1;
    if (seen > 512 || depth > 12) throw new Error("assetfare_v2_secret_material_rejected");
    if (Array.isArray(node)) { for (const child of node) stack.push([child, depth + 1]); continue; }
    if (node && typeof node === "object") {
      for (const key of Object.keys(node)) if (forbiddenKeys.has(String(key).toLowerCase())) throw new Error("assetfare_v2_secret_material_rejected");
      for (const child of Object.values(node)) stack.push([child, depth + 1]);
    }
  }
}

function rejectPrivateOutputMaterial(value) {
  const forbidden=new Set(["privatekey","privkey","secretkey","seed","seedphrase","mnemonic","keypair","secret","signedtransaction","signedtx","password","passphrase"]);
  const stack=[[value,0]];let seen=0;
  while(stack.length){const [node,depth]=stack.pop();seen+=1;if(seen>1024||depth>16)throw new Error("assetfare_v2_secret_material_rejected");if(Array.isArray(node)){for(const child of node)stack.push([child,depth+1]);continue;}if(node&&typeof node==="object"){for(const [key,child] of Object.entries(node)){const normalized=String(key).toLowerCase().replaceAll("_","").replaceAll("-","");const safePrivateKeyPolicy=(normalized==="privatekeysaccepted"&&child===false)||(normalized==="privatekeystaysclientside"&&child===true)||(normalized==="assetfareacceptsprivatekey"&&child===false);if(!safePrivateKeyPolicy&&[...forbidden].some((term)=>normalized.includes(term)))throw new Error("assetfare_v2_secret_material_rejected");}for(const child of Object.values(node))stack.push([child,depth+1]);}}
}

// Session capability values are caller-owned bearer secrets. Public hashes and
// quote/session bindings are allowed, but a raw token must never cross back out
// of the upstream response boundary under a familiar key or any other key.
function rejectSessionTokenEcho(value, expectedToken = null) {
  const rawKeys=new Set(["sessiontoken","rawsessiontoken","sessioncapability","rawsessioncapability"]),stack=[[value,0]];let seen=0;
  while(stack.length){const[node,depth]=stack.pop();seen+=1;if(seen>1024||depth>16)throw new Error("assetfare_v2_session_token_echo_rejected");if(Array.isArray(node)){for(const child of node)stack.push([child,depth+1]);continue;}if(node&&typeof node==="object"){for(const[key,child]of Object.entries(node)){const normalized=String(key).toLowerCase().replaceAll("_","").replaceAll("-","");if(rawKeys.has(normalized))throw new Error("assetfare_v2_session_token_echo_rejected");if(expectedToken&&typeof child==="string"&&child.includes(expectedToken))throw new Error("assetfare_v2_session_token_echo_rejected");stack.push([child,depth+1]);}}}
}

function rejectUnsignedActionMaterial(value) {
  const forbidden=new Set(["privatekey","privkey","secretkey","seed","seedphrase","mnemonic","keypair","secret","signedtransaction","signedtx","rawtransaction","password","passphrase","signature","signatures"]),stack=[[value,0]];let seen=0;
  while(stack.length){const [node,depth]=stack.pop();seen+=1;if(seen>1024||depth>16)throw new Error("assetfare_v2_bundle_unsafe");if(Array.isArray(node)){for(const child of node)stack.push([child,depth+1]);continue;}if(node&&typeof node==="object"){for(const [key,child] of Object.entries(node)){const normalized=String(key).toLowerCase().replaceAll("_","").replaceAll("-","");const aptosUnsignedRaw=["rawtransactionbcsbase64","rawtransactionsha256"].includes(normalized)&&value?.safety_receipt?.action?.kind==="aptos_cctp",safePrivateKeyPolicy=(normalized==="privatekeysaccepted"&&child===false)||(normalized==="privatekeystaysclientside"&&child===true)||(normalized==="assetfareacceptsprivatekey"&&child===false);if(!aptosUnsignedRaw&&!safePrivateKeyPolicy&&[...forbidden].some((term)=>normalized.includes(term)))throw new Error("assetfare_v2_bundle_unsafe");if(["signed","submitted"].includes(normalized)&&child!==false)throw new Error("assetfare_v2_bundle_unsafe");stack.push([child,depth+1]);}}}
}

function deepEqualArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

// EXACT key-set equality on a plain object: rejects BOTH missing and extra keys.
function exactKeys(object, keys) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return false;
  const actual = Object.keys(object);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(object, key));
}

// Fail-closed validation of the upstream caller_action_plan_handoff. No local fallback:
// a missing/null/array/extra/private-key/wrong-fields handoff is a real API regression.
function validateHandoff(handoff) {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) throw new Error("assetfare_v2_handoff_missing");
  if (handoff.kind !== "caller_operated_rest_prepare") throw new Error("assetfare_v2_handoff_invalid");
  if (handoff.method !== "POST") throw new Error("assetfare_v2_handoff_invalid");
  if (!deepEqualArray(handoff.request_fields, V2_HANDOFF_REQUEST_FIELDS)) throw new Error("assetfare_v2_handoff_request_fields_invalid");
  if (handoff.requires_explicit_caller_approval !== true) throw new Error("assetfare_v2_handoff_invalid");
  if (handoff.requires_public_wallet_addresses !== true) throw new Error("assetfare_v2_handoff_invalid");
  if (handoff.assetfare_server_signing !== false) throw new Error("assetfare_v2_handoff_invalid");
  if (handoff.assetfare_server_submission !== false) throw new Error("assetfare_v2_handoff_invalid");
  if (handoff.caller_must_verify_sign_and_submit !== true) throw new Error("assetfare_v2_handoff_invalid");
  if (handoff.requires_fresh_requote !== true) throw new Error("assetfare_v2_handoff_invalid");
  if (handoff.automatic_prepare_call_forbidden !== true) throw new Error("assetfare_v2_handoff_invalid");
  if (typeof handoff.note !== "string" || !handoff.note.length) throw new Error("assetfare_v2_handoff_invalid");
  // v1 stays the UNCHANGED exact allow-list (no machine fields) so this adapter also validates the backward-compatible
  // Core response; the advisory machine contract lives in the caller_action_plan_handoff_v2 sibling (validateHandoffV2).
  const allowed = new Set(["kind", "url", "method", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "request_fields", "assetfare_server_signing", "assetfare_server_submission", "caller_must_verify_sign_and_submit", "requires_fresh_requote", "automatic_prepare_call_forbidden", "options", "note", "available", "blocker"]);
  for (const key of Object.keys(handoff)) if (!allowed.has(key)) throw new Error("assetfare_v2_handoff_extra_field");
  if (handoff.available !== true) throw new Error("assetfare_v2_handoff_invalid");
  if (handoff.url !== V2_PREPARE_URL) throw new Error("assetfare_v2_handoff_invalid");
  if (!Array.isArray(handoff.options) || handoff.options.length !== 2) throw new Error("assetfare_v2_handoff_options_invalid");
  const [prepareOption, sessionOption] = handoff.options;
  if (!prepareOption || prepareOption.kind !== "one_shot_first_unsigned_bundle" || prepareOption.method !== "POST" || prepareOption.url !== V2_PREPARE_URL || prepareOption.requires_explicit_caller_approval !== true || prepareOption.requires_public_wallet_addresses !== true || prepareOption.assetfare_never_signs_submits_or_auto_calls !== true) throw new Error("assetfare_v2_handoff_prepare_option_invalid");
  if (!sessionOption || sessionOption.kind !== "caller_approved_full_workflow_session" || sessionOption.method !== "POST" || sessionOption.url !== V2_SESSION_URL || sessionOption.requires_explicit_caller_approval !== true || sessionOption.requires_public_wallet_addresses !== true || sessionOption.assetfare_never_signs_submits_or_auto_calls !== true) throw new Error("assetfare_v2_handoff_session_option_invalid");
  const lifecycle = sessionOption.lifecycle_urls;
  if (!lifecycle || typeof lifecycle !== "object" || lifecycle.create?.url !== V2_SESSION_URL || lifecycle.read?.url !== `${V2_SESSION_URL}/{session_id}` || lifecycle.observe_source?.url !== `${V2_SESSION_URL}/{session_id}/observe-source` || lifecycle.observe_output?.url !== `${V2_SESSION_URL}/{session_id}/observe-output` || lifecycle.refresh_action?.url !== `${V2_SESSION_URL}/{session_id}/refresh-action`) throw new Error("assetfare_v2_handoff_session_lifecycle_invalid");
  return handoff;
}

// Optional versioned SIBLING: validated EXACTLY when present (transition period accepts old-only OR v2). Advisory
// machine contract with per-kind exact option keys so prepare/session cross-fields are rejected.
function validateHandoffV2(handoff) {
  // Called ONLY when the sibling key is present (see parseV2Quote); a present-but-null/array sibling is rejected.
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) throw new Error("assetfare_v2_handoff_v2_invalid");
  if (!deepEqualArray(handoff.request_fields, V2_HANDOFF_REQUEST_FIELDS)) throw new Error("assetfare_v2_handoff_v2_request_fields_invalid");
  const scalars = [["schema_version", 2], ["kind", "caller_operated_rest_prepare"], ["method", "POST"], ["requires_explicit_caller_approval", true], ["requires_public_wallet_addresses", true], ["assetfare_server_signing", false], ["assetfare_server_submission", false], ["caller_must_verify_sign_and_submit", true], ["requires_fresh_requote", true], ["automatic_prepare_call_forbidden", true], ["selection", "choose_exactly_one"], ["mutually_exclusive", true], ["do_not_call_both", true], ["selection_before_signing", true], ["once_any_action_submitted_do_not_start_other_mode", true], ["enforcement", "advisory_caller_side"], ["available", true], ["url", V2_PREPARE_URL]];
  for (const [k, v] of scalars) if (handoff[k] !== v) throw new Error("assetfare_v2_handoff_v2_invalid");
  if (typeof handoff.note !== "string" || !handoff.note.length) throw new Error("assetfare_v2_handoff_v2_invalid");
  // v2 is ALWAYS the available=true machine contract: EXACT key set (no blocker) — reject missing AND extra.
  const topRequired = ["kind", "url", "method", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "request_fields", "assetfare_server_signing", "assetfare_server_submission", "caller_must_verify_sign_and_submit", "requires_fresh_requote", "automatic_prepare_call_forbidden", "schema_version", "selection", "mutually_exclusive", "do_not_call_both", "selection_before_signing", "once_any_action_submitted_do_not_start_other_mode", "enforcement", "options", "note", "available"];
  if (!exactKeys(handoff, topRequired)) throw new Error("assetfare_v2_handoff_v2_extra_field");
  if (!Array.isArray(handoff.options) || handoff.options.length !== 2) throw new Error("assetfare_v2_handoff_v2_options_invalid");
  const [prepareOption, sessionOption] = handoff.options;
  // Per-kind EXACT option key sets: reject missing AND extra keys (and cross-fields), require nonempty note.
  const prepKeys = ["kind", "method", "url", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "assetfare_never_signs_submits_or_auto_calls", "preview_or_manual_first_action_only", "not_a_session", "do_not_start_session_after_submission", "note"];
  if (!exactKeys(prepareOption, prepKeys) || prepareOption.kind !== "one_shot_first_unsigned_bundle" || prepareOption.method !== "POST" || prepareOption.url !== V2_PREPARE_URL || prepareOption.requires_explicit_caller_approval !== true || prepareOption.requires_public_wallet_addresses !== true || prepareOption.assetfare_never_signs_submits_or_auto_calls !== true || prepareOption.preview_or_manual_first_action_only !== true || prepareOption.not_a_session !== true || prepareOption.do_not_start_session_after_submission !== true || typeof prepareOption.note !== "string" || !prepareOption.note.length) throw new Error("assetfare_v2_handoff_v2_prepare_option_invalid");
  const sessKeys = ["kind", "method", "url", "lifecycle_urls", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "assetfare_never_signs_submits_or_auto_calls", "recommended_for_multistep", "note"];
  if (!exactKeys(sessionOption, sessKeys) || sessionOption.kind !== "caller_approved_full_workflow_session" || sessionOption.method !== "POST" || sessionOption.url !== V2_SESSION_URL || sessionOption.requires_explicit_caller_approval !== true || sessionOption.requires_public_wallet_addresses !== true || sessionOption.assetfare_never_signs_submits_or_auto_calls !== true || sessionOption.recommended_for_multistep !== true || typeof sessionOption.note !== "string" || !sessionOption.note.length) throw new Error("assetfare_v2_handoff_v2_session_option_invalid");
  // lifecycle_urls: EXACT key set + each { method, url } exact (same URLs as v1).
  const lifecycle = sessionOption.lifecycle_urls;
  if (!exactKeys(lifecycle, ["create", "read", "observe_source", "observe_output", "refresh_action"])) throw new Error("assetfare_v2_handoff_v2_session_lifecycle_invalid");
  const expectedLifecycle = [["create", "POST", V2_SESSION_URL], ["read", "GET", `${V2_SESSION_URL}/{session_id}`], ["observe_source", "POST", `${V2_SESSION_URL}/{session_id}/observe-source`], ["observe_output", "POST", `${V2_SESSION_URL}/{session_id}/observe-output`], ["refresh_action", "POST", `${V2_SESSION_URL}/{session_id}/refresh-action`]];
  for (const [name, method, url] of expectedLifecycle) { const entry = lifecycle[name]; if (!exactKeys(entry, ["method", "url"]) || entry.method !== method || entry.url !== url) throw new Error("assetfare_v2_handoff_v2_session_lifecycle_invalid"); }
  return handoff;
}

// Every live route must charge EXACTLY 1bp at one eligible successful atomic action.
function validateFee(offer, stepCount) {
  if (offer.fee_collection !== V2_FEE_COLLECTION_CONST) throw new Error("assetfare_v2_fee_invalid");
  if (offer.assetfare_fee_bps !== 1 || offer.fee_modeled_bps !== 1 || offer.fee_collectible_now !== true) throw new Error("assetfare_v2_fee_invalid");
  const steps = offer.fee_collection_steps;
  if (!Array.isArray(steps)) throw new Error("assetfare_v2_fee_invalid");
  if (steps.some((index) => !Number.isInteger(index) || index < 0 || index >= stepCount)) throw new Error("assetfare_v2_fee_step_out_of_range");
  if (new Set(steps).size !== steps.length) throw new Error("assetfare_v2_fee_step_duplicate");
  if (steps.length !== 1) throw new Error("assetfare_v2_fee_step_count_mismatch");
}

function rejectSigningClaims(value) {
  const stack=[[value,0]];let seen=0;
  while(stack.length){const [node,depth]=stack.pop();seen+=1;if(seen>1024||depth>16)throw new Error("assetfare_v2_safety_boundary_failed");if(Array.isArray(node)){for(const child of node)stack.push([child,depth+1]);continue;}if(node&&typeof node==="object"){for(const key of ["server_signing","server_submission","serverSigning","serverSubmission"])if(key in node&&node[key]!==false)throw new Error("assetfare_v2_safety_boundary_failed");for(const child of Object.values(node))stack.push([child,depth+1]);}}
}

function parseV2Capabilities(payload) {
  rejectPrivateOutputMaterial(payload);
  rejectSigningClaims(payload);
  let value;
  try { value = v2CapabilitiesResponse.parse(payload); }
  catch { throw new Error("assetfare_v2_safety_boundary_failed"); }
  const endpoints = new Set(value.asset_endpoints.map((item) => `${item.chain}:${item.token}`));
  const chains = new Set(value.chains);
  const release100=value.direct_route_summary.route_count===100,target=value.direct_route_summary.route_count===98,previousTarget=value.direct_route_summary.route_count===54,expanded=value.direct_route_summary.route_count===80,expectedEndpoints=release100?V2_TARGET_ENDPOINTS:target?V2_PRE_100_ENDPOINTS:previousTarget?new Set([...V2_PRE_100_ENDPOINTS].filter((value)=>value!=="base:ETH"&&value!=="polygon:USDC")):expanded?new Set([...V2_ENDPOINTS].filter((value)=>!V2_CANDIDATE_SOURCE_CHAINS.has(value.split(":",1)[0])&&!V2_SOLANA_ONLY_SOURCE_CHAINS.has(value.split(":",1)[0]))):V2_PRE_EXPANSION_ENDPOINTS,expectedSourceRoutes=new Set(release100?V2_SOURCE_ONLY_ROUTES:target?V2_PRE_100_SOURCE_ONLY_ROUTES:previousTarget?V2_TARGET_SOURCE_ONLY_ROUTES:expanded?V2_SOURCE_ONLY_ROUTES.filter((route)=>!["xlayer","sei","sonic","monad","avalanche","cronos","injective","linea","aptos","unichain","ink"].some((chain)=>route.startsWith(`${chain}:`))):V2_SOURCE_ONLY_ROUTES.filter((route)=>!["ethereum","hyperevm","xlayer","sei","sonic","monad","avalanche","cronos","injective","linea","aptos","unichain","ink"].some((chain)=>route.startsWith(`${chain}:`)))),expectedCount=release100?100:target?98:previousTarget?54:expanded?80:76;
  const expectedChains=new Set([...expectedEndpoints].map((item)=>item.split(":",1)[0]));
  if (chains.size!==expectedChains.size||[...expectedChains].some((item)=>!chains.has(item))||endpoints.size !== expectedEndpoints.size || [...expectedEndpoints].some((item) => !endpoints.has(item))) throw new Error("assetfare_v2_safety_boundary_failed");
  if(new Set(value.source_only_routes).size!==expectedSourceRoutes.size||[...expectedSourceRoutes].some((route)=>!value.source_only_routes.includes(route))||value.directed_conversion_routes!==expectedCount||value.unsigned_route_plans_ready!==expectedCount||value.execution_ready_routes!==expectedCount)throw new Error("assetfare_v2_safety_boundary_failed");
  try {
    if(expanded||target||previousTarget||release100){const policy=validateExpandedEconomicPolicy(payload,(guidance)=>economicGuidanceCapability.parse(guidance));if(policy.guidance)value.route_product_policy.economic_guidance=policy.guidance;}
    else validatePreExpansionEconomicPolicy(payload);
  } catch { throw new Error("assetfare_v2_amount_policy_invalid"); }
  if(value.blocked_source_only_routes.length!==0)throw new Error("assetfare_v2_safety_boundary_failed");
  const availabilityKeys=["execution_implemented_routes","currently_prepare_ready_routes","temporarily_unavailable_routes","temporarily_unavailable_route_count","execution_availability"];
  const availabilityPresent=availabilityKeys.filter((key)=>Object.prototype.hasOwnProperty.call(value,key));
  if(availabilityPresent.length!==0&&availabilityPresent.length!==availabilityKeys.length)throw new Error("assetfare_v2_current_availability_invalid");
  if(availabilityPresent.length===availabilityKeys.length){
    const unavailable=new Set(value.temporarily_unavailable_routes);
    if(value.temporarily_unavailable_route_count!==value.temporarily_unavailable_routes.length || value.currently_prepare_ready_routes!==value.execution_implemented_routes-value.temporarily_unavailable_route_count || unavailable.size!==value.temporarily_unavailable_routes.length || [...unavailable].some((route)=>!V2_ROUTE_NAMES.has(route)) || (unavailable.size===0)!==(value.execution_availability.status==="available"))throw new Error("assetfare_v2_current_availability_invalid");
  }
  return value;
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function bundlePayloadSha256(payload) {
  const unhashed = { ...payload };
  delete unhashed.payload_sha256;
  return createHash("sha256").update(canonicalJson(unhashed), "utf8").digest("hex");
}

// Validate the upstream bounded first unsigned action bundle returned by /v2/prepare and
// by /v2/session create. Fail-closed on any server signing/submission claim.
function parseV2Bundle(payload) {
  rejectSigningClaims(payload);
  rejectPrivateOutputMaterial(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("assetfare_v2_bundle_invalid");
  if (payload.version !== V2_BUNDLE_VERSION) throw new Error("assetfare_v2_bundle_version_invalid");
  if (payload.payload_sha256_spec !== V2_BUNDLE_HASH_SPEC) throw new Error("assetfare_v2_bundle_hash_spec_invalid");
  if (payload.server_signing !== false || payload.server_submission !== false || payload.signed !== false || payload.submitted !== false) throw new Error("assetfare_v2_bundle_unsafe");
  if (!payload.unsigned_action || typeof payload.unsigned_action !== "object") throw new Error("assetfare_v2_bundle_missing_action");
  rejectUnsignedActionMaterial(payload.unsigned_action);
  if (payload.unsigned_action.signed !== false || payload.unsigned_action.submitted !== false) throw new Error("assetfare_v2_bundle_unsafe");
  const receipt=payload.unsigned_action.safety_receipt;
  if(!receipt||typeof receipt!=="object"||Array.isArray(receipt)||receipt.schema!=="https://assetfare.dev/schemas/action-safety-receipt-v1"||receipt.schema_version!==1||receipt.generation!=="decoded_built_action_only"||receipt.custody?.server_signing!==false||receipt.custody?.server_submission!==false||typeof receipt.payload_binding?.action_sha256!=="string"||!Array.isArray(receipt.payload_binding?.raw_payloads))throw new Error("assetfare_v2_bundle_receipt_invalid");
  for(const key of ["signature","signatures","signed_transaction","signed_tx","raw_transaction","private_key","seed_phrase","mnemonic"])if(Object.prototype.hasOwnProperty.call(payload.unsigned_action,key))throw new Error("assetfare_v2_bundle_unsafe");
  if (!/^[0-9a-f]{64}$/.test(payload.payload_sha256 || "") || bundlePayloadSha256(payload) !== payload.payload_sha256) throw new Error("assetfare_v2_bundle_hash_mismatch");
  return payload;
}

// Validate a v2 session workflow-state response. It must never assert signing/submission.
function parseV2Session(payload, expectedApproval = null, expectedSessionToken = null) {
  rejectSigningClaims(payload);
  rejectPrivateOutputMaterial(payload);
  rejectSessionTokenEcho(payload, expectedSessionToken);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("assetfare_v2_session_invalid");
  if (typeof payload.session_id !== "string" || !payload.session_id) throw new Error("assetfare_v2_session_invalid");
  if (payload.server_signing !== false || payload.server_submission !== false || payload.signed !== false || payload.submitted !== false) throw new Error("assetfare_v2_session_unsafe");
  if(payload.current_action!==null&&payload.current_action!==undefined)parseV2Bundle(payload.current_action);
  let binding;
  try { binding=z.union([v2SessionQuoteBindingV3,v2SessionQuoteBindingLegacy]).parse(payload.quote_binding); }
  catch { throw new Error("assetfare_v2_session_quote_binding_invalid"); }
  if(expectedApproval && (binding.version!=="assetfare-quote-bound-session-constraints-v1" || binding.quote_id!==expectedApproval.quote_id || binding.quote_fingerprint!==expectedApproval.quote_fingerprint))throw new Error("assetfare_v2_session_quote_binding_mismatch");
  return payload;
}

function parseBoundVerificationContext(raw,expectedApproval,schema,prefix){
  let context;try{context=schema.parse(raw);}catch{throw new Error(`${prefix}_verification_context_invalid`);}
  const unhashed={...context};delete unhashed.verification_context_sha256;
  if(createHash("sha256").update(canonicalJson(unhashed),"utf8").digest("hex")!==context.verification_context_sha256)throw new Error(`${prefix}_verification_context_hash_mismatch`);
  if(context.approval_v3.direct_route_summary_sha256!==createHash("sha256").update(canonicalJson(context.direct_route_summary),"utf8").digest("hex")||context.direct_route_summary.route!==`${context.intent.from_chain}:${context.intent.from_token}->${context.intent.to_chain}:${context.intent.to_token}`||context.direct_route_summary.from!==`${context.intent.from_chain}:${context.intent.from_token}`||context.direct_route_summary.to!==`${context.intent.to_chain}:${context.intent.to_token}`||context.direct_route_summary.step_count!==context.direct_route_summary.steps.length)throw new Error(`${prefix}_verification_context_binding_failed`);
  if(expectedApproval&&canonicalJson(expectedApproval)!==canonicalJson(context.approval_v3))throw new Error(`${prefix}_verification_context_approval_mismatch`);
  return context;
}
function parseRemoteVerificationContext(raw,expectedApproval=null){return parseBoundVerificationContext(raw,expectedApproval,v2RemoteVerificationContext,"assetfare_v2_session");}
function parseRemoteOneShotVerificationContext(raw,expectedApproval=null){return parseBoundVerificationContext(raw,expectedApproval,v2RemoteOneShotVerificationContext,"assetfare_v2_prepare");}

async function verifyRemoteBundle(payload,rawContext,expectedApproval){
  const context=parseRemoteOneShotVerificationContext(rawContext,expectedApproval),bundle=parseV2Bundle(payload);
  const {callerWalletHandoff,verifyApprovalBundleBounds,verifyPlanBundle}=await import("../scripts/plan.mjs");
  const expected={...context.intent,wallets:context.wallets,...(context.event_signer_public?{event_signer_public:context.event_signer_public}:{})};
  const verification={...verifyPlanBundle(bundle,expected),approval_v3:verifyApprovalBundleBounds(bundle,{direct_route_summary:context.direct_route_summary},context.approval_v3)};
  return {bundle,semantic_verification:true,action_verification:verification,caller_wallet_handoff:callerWalletHandoff(bundle,verification)};
}

async function verifyRemoteSession(payload,rawContext,expectedSessionToken,expectedApproval=null){
  const context=rawContext?parseRemoteVerificationContext(rawContext,expectedApproval):null,approval=context?.approval_v3||expectedApproval;
  const session=parseV2Session(payload,approval||null,expectedSessionToken);
  if(!session.current_action)return {...session,semantic_verification:context!==null,caller_wallet_handoff:null};
  if(!context)throw new Error("assetfare_v2_session_verification_context_required");
  const {callerWalletHandoff,verifyApprovalBundleBounds,verifyPlanBundle}=await import("../scripts/plan.mjs");
  const expected={...context.intent,wallets:context.wallets,...(context.event_signer_public?{event_signer_public:context.event_signer_public}:{})};
  const verification={...verifyPlanBundle(session.current_action,expected),approval_v3:verifyApprovalBundleBounds(session.current_action,{direct_route_summary:context.direct_route_summary},context.approval_v3)};
  return {...session,semantic_verification:true,action_verification:verification,caller_wallet_handoff:callerWalletHandoff(session.current_action,verification)};
}

// Generate a caller-owned session capability token: 256-bit CSPRNG rendered url-safe
// base64 without padding (exactly 43 chars). Purely local — no network, never logged.
function generateSessionCapability() {
  const token = randomBytes(32).toString("base64url");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(token)) throw new Error("assetfare_v2_session_token_generation_failed");
  return {
    session_token: token,
    token_bits: 256,
    token_length: token.length,
    sensitivity: "sensitive_capability",
    is_private_key: false,
    usage: "Pass this token as session_token to assetfare_v2_session_create and to every session_get/observe/refresh call. It is sent to AssetFare in the X-AssetFare-Session-Token header; the server stores only its hash and never returns it. Treat it like a bearer credential: never log, share, or persist it in plaintext. It is NOT a private key and cannot move funds.",
    server_signing: false,
    server_submission: false,
  };
}

function parseV2Quote(payload, intent, { nowMs = Date.now() } = {}) {
  rejectSigningClaims(payload);
  rejectPrivateOutputMaterial(payload);
  rejectUnsignedActionMaterial(payload);
  let value;
  try { value = v2QuoteResponse.parse(payload); }
  catch { throw new Error("assetfare_v2_safety_boundary_failed"); }
  if(value.economic_guidance.public_activation_status&&!isTargetActiveRoute(value.route.route))throw new Error("assetfare_v2_inactive_route_rejected");
  if (value.intent.from !== `${intent.from_chain}:${intent.from_token}` || value.intent.to !== `${intent.to_chain}:${intent.to_token}` || value.intent.amount_usd !== intent.amount_usd) throw new Error("assetfare_v2_quote_binding_failed");
  if (value.offer.output_symbol !== intent.to_token || value.offer.estimated_min_receive_amount > value.offer.expected_receive_amount) throw new Error("assetfare_v2_quote_binding_failed");
  const directRouteSummary=validateDirectRouteSummary(value.direct_route_summary,value.route,value.risk,value.intent,value.offer);
  if(canonicalJson(directRouteSummary)!==canonicalJson(value.direct_route_summary))throw new Error("assetfare_v2_direct_route_summary_invalid");
  value.continuation_v3=validateContinuationV3(value.continuation_v3,value,{requireUnexpired:true,nowMs});
  if (value.cost_summary) {
    const expectedCost=Math.max(0,intent.amount_usd-value.offer.expected_receive_usd),maximumCost=Math.max(0,intent.amount_usd-value.offer.estimated_min_receive_usd),close=(a,b,t=.000001)=>Math.abs(a-b)<=t;
    const componentExpected=value.cost_summary.provider_fee_components.reduce((sum,row)=>sum+row.expected_usd,0),componentMaximum=value.cost_summary.provider_fee_components.reduce((sum,row)=>sum+row.maximum_usd,0),current=Array.isArray(value.cost_summary.separately_paid_costs),separateExpected=current?value.cost_summary.separately_paid_costs.reduce((sum,row)=>sum+row.expected_usd,0):0,separateMaximum=current?value.cost_summary.separately_paid_costs.reduce((sum,row)=>sum+row.maximum_usd,0):0,warningPercent=current?value.cost_summary.maximum_all_in_cost_percent_estimate:value.cost_summary.maximum_total_cost_percent;
    if (value.cost_summary.input_value_usd !== intent.amount_usd || !close(value.cost_summary.expected_receive_value_usd,value.offer.expected_receive_usd) || !close(value.cost_summary.minimum_receive_value_usd,value.offer.estimated_min_receive_usd) || value.cost_summary.maximum_total_cost_usd < value.cost_summary.expected_total_cost_usd || value.cost_summary.assetfare_service_fee.bps !== value.offer.assetfare_fee_bps || !close(value.cost_summary.expected_total_cost_usd,expectedCost) || !close(value.cost_summary.maximum_total_cost_usd,maximumCost) || current&&(!close(value.cost_summary.token_path_expected_cost_usd,expectedCost)||!close(value.cost_summary.token_path_maximum_cost_usd,maximumCost)||!close(value.cost_summary.expected_all_in_cost_usd_estimate,expectedCost+separateExpected)||!close(value.cost_summary.maximum_all_in_cost_usd_estimate,maximumCost+separateMaximum)||!close(value.cost_summary.expected_all_in_cost_percent_estimate,(expectedCost+separateExpected)/intent.amount_usd*100,.0001)||!close(value.cost_summary.maximum_all_in_cost_percent_estimate,(maximumCost+separateMaximum)/intent.amount_usd*100,.0001)) || !close(value.cost_summary.expected_total_cost_percent,expectedCost/intent.amount_usd*100,.0001) || !close(value.cost_summary.maximum_total_cost_percent,maximumCost/intent.amount_usd*100,.0001) || !close(value.cost_summary.assetfare_service_fee.estimated_usd,intent.amount_usd/10000) || componentExpected>expectedCost+.000001 || componentMaximum>maximumCost+.000001 || value.cost_summary.small_amount_warning!==(warningPercent>=1) || (value.cost_summary.small_amount_warning?typeof value.cost_summary.warning!=="string":value.cost_summary.warning!==null)) throw new Error("assetfare_v2_cost_summary_binding_failed");
  }
  if (value.eta && (value.eta.estimated_time_seconds !== value.offer.estimated_time_seconds || (value.eta.complete_route_estimate && (!value.eta.estimated_time_range_seconds || value.eta.estimated_time_seconds !== value.eta.estimated_time_range_seconds[1])))) throw new Error("assetfare_v2_eta_binding_failed");
  if (!value.cost_summary) {
    const expected=Math.max(0,intent.amount_usd-value.offer.expected_receive_usd), maximum=Math.max(0,intent.amount_usd-value.offer.estimated_min_receive_usd);
    const small=maximum/intent.amount_usd>=.01;
    value.cost_summary={scope:"token_path_only_network_gas_excluded",input_value_usd:intent.amount_usd,expected_receive_value_usd:value.offer.expected_receive_usd,minimum_receive_value_usd:value.offer.estimated_min_receive_usd,expected_total_cost_usd:expected,maximum_total_cost_usd:maximum,expected_total_cost_percent:expected/intent.amount_usd*100,maximum_total_cost_percent:maximum/intent.amount_usd*100,token_path_expected_cost_usd:expected,token_path_maximum_cost_usd:maximum,separately_paid_costs:[],expected_all_in_cost_usd_estimate:expected,maximum_all_in_cost_usd_estimate:maximum,expected_all_in_cost_percent_estimate:expected/intent.amount_usd*100,maximum_all_in_cost_percent_estimate:maximum/intent.amount_usd*100,all_in_estimate_complete:false,native_balance_requirements:[],source_native_balance_required:null,assetfare_service_fee:{bps:1,estimated_usd:intent.amount_usd/10000,included_in_receive_amount:true,note:"AssetFare service fee only; not the total route cost"},provider_fee_components:[],unpriced_costs:["provider_fee_breakdown_unavailable_legacy_core","source_chain_network_fee"],rankable_all_in:false,small_amount_warning:small,warning:small?"Legacy-core fallback: total is derived from receive value; provider component detail is unavailable.":null};
  }
  if (!value.eta) value.eta={estimated_time_seconds:value.offer.estimated_time_seconds,estimated_time_range_seconds:null,complete_route_estimate:false,sources:[],note:"Legacy-core fallback; full ETA provenance unavailable"};
  if (value.execution.supported !== true || value.execution.first_unsigned_action_supported !== true || ("blocker" in value.execution && value.execution.blocker !== null)) throw new Error("assetfare_v2_execution_boundary_failed");
  validateFee(value.offer, value.route.steps.length);
  validateHandoff(value.caller_action_plan_handoff);
  // Transition-safe: v1 is ALWAYS validated (exact old shape). The v2 sibling and its schema_version are strictly
  // coupled — both present (version===2, sibling a non-null object) or both absent (rollback Core still quotes).
  // Coupling by KEY PRESENCE (not value): the version key and the sibling key are both present or both absent. A
  // present sibling that is null/array is rejected by validateHandoffV2 (not treated as absent).
  const hasVersion = Object.prototype.hasOwnProperty.call(value, "handoff_schema_version");
  const hasSibling = Object.prototype.hasOwnProperty.call(value, "caller_action_plan_handoff_v2");
  if (hasVersion !== hasSibling) throw new Error("assetfare_v2_handoff_schema_version_invalid");
  if (hasSibling) {
    if (value.handoff_schema_version !== 2) throw new Error("assetfare_v2_handoff_schema_version_invalid");
    validateHandoffV2(value.caller_action_plan_handoff_v2);
  }
  return value;
}

function unsignedPrepareReadiness(quote) {
  const continuation=quote.continuation_v3;
  const walletFields=continuation.required_wallet_chains.map((chain)=>({
    chain,
    requestField:`wallets.${chain}`,
    addressType:chain==="solana"?"solana_ed25519_public_key":chain==="aptos"?"aptos_account_address":"evm_account_address",
    format:chain==="solana"?"base58_32_byte_on_curve":chain==="aptos"?"0x_64_hex":"0x_40_hex",
    publicOnly:true,
  }));
  return {
    version:"assetfare-unsigned-prepare-readiness-v1",
    status:"needs_caller_public_inputs_and_explicit_selection",
    readyToPrepare:false,
    requiredWalletChains:[...continuation.required_wallet_chains],
    walletFields,
    eventSignerPublic:{required:continuation.event_signer_public_required,requestField:continuation.event_signer_public_required?"event_signer_public":null,format:continuation.event_signer_public_required?"base58_32_byte_on_curve":null,callerGenerated:continuation.event_signer_public_required,privateKeyStaysClientSide:true},
    economicGuidance:{priceRecommendedForAmount:quote.economic_guidance.price_recommended_for_amount??null,advisory:true,blocksExecution:false},
    modeSelection:{selectionStatus:"unranked_candidate",recommendedMode:continuation.recommended_mode,allowedModes:[...continuation.allowed_modes],automaticSelectionForbidden:true},
    approvalV3Draft:approvalDraft(continuation),
    nextAction:"collect_only_the_listed_public_inputs_then_make_one_explicit_mode_selection",
    privateKeysAccepted:false,
    serverSigning:false,
    serverSubmission:false,
  };
}

// Wallet-bound workflow tools use an access token produced by the preceding
// non-transactional signMessage flow. They never require a server-side API key
// or give the server signing/submission authority.
async function serverCard(profile = "v2") {
  // Obtain definitions through the SDK's own wire path. This keeps the static
  // card byte-semantically aligned with tools/list, including refs, defaults,
  // propertyNames, annotations, output schemas, and registered resources.
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(),profileServer=createServer({},profile),client=new Client({name:"assetfare-server-card",version:VERSION});
  try{await profileServer.connect(serverTransport);await client.connect(clientTransport);const tools=(await client.listTools()).tools;let resources=[];if(profile!=="v2")resources=(await client.listResources()).resources;return {serverInfo:{name:"AssetFare",version:VERSION},authentication:{required:false,schemes:[]},profile,tools,resources,prompts:[]};}
  finally{await client.close().catch(()=>{});await profileServer.close().catch(()=>{});}
  /* istanbul ignore next -- retained only as a readable schema reference */
  const token = { type: "string", minLength: 20, maxLength: 512 };
  const uuid = { type: "string", format: "uuid" };
  const wallet = { type: "string", minLength: 32, maxLength: 64 };
  const evmWallet = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
  const idempotency = { type: "string", minLength: 8, maxLength: 128 };
  const signature = { type: "string", minLength: 64, maxLength: 128 };
  const sessionCapability = { type: "string", pattern: "^[A-Za-z0-9_-]{43,128}$" };
  const publicAddress = { type: "string" };
  const eventSignerPublic = { type: "string", description: "Solana CCTP only: caller-generated ephemeral public key. Keep the matching private key client-side and co-sign the returned unsigned event-account transaction; never send the private key." };
  const walletMap = { type: "object", additionalProperties: publicAddress };
  const callerApproved = { type: "boolean", const: true };
  const amountUsd = { type: "number", minimum: 1 };
  const v2Route = {
    from_chain: { type: "string", enum: V2_SOURCE_CHAINS, description: "Source chain for the v2 route. Polygon, Optimism, Ethereum, HyperEVM, X Layer, Sei and Sonic are source-only and cannot be used as to_chain." },
    from_token: { type: "string", enum: V2_TOKENS, description: "Input token symbol on from_chain. The chain-token pair must appear in current v2 capabilities." },
    to_chain: { type: "string", enum: V2_DESTINATION_CHAINS, description: "Destination chain for the v2 route: Solana, Base, Arbitrum, or Robinhood Chain. Polygon and Optimism are not destinations." },
    to_token: { type: "string", enum: V2_TOKENS, description: "Output token symbol on to_chain. The chain-token pair must appear in current v2 capabilities." },
    amount_usd: { ...amountUsd, description: "Requested input value in USD, minimum 1. Obtain a fresh quote because availability, fees, and receive amounts can change." },
  };
  const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
  const manifestTool = { name: "assetfare_manifest", description: V2_MANIFEST_DESCRIPTION, inputSchema: object({}) };
  const v2Tools = [
      manifestTool,
      { name: "assetfare_v2_capabilities", description: V2_CAPABILITIES_DESCRIPTION, inputSchema: object({}) },
      { name: "assetfare_v2_quote", description: V2_QUOTE_DESCRIPTION, inputSchema: object(v2Route) },
      { name: "assetfare_v2_prepare", description: V2_PREPARE_DESCRIPTION, inputSchema: object({ caller_approved: callerApproved, ...v2Route, wallets: walletMap, event_signer_public: eventSignerPublic }, ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets"]) },
      { name: "assetfare_v2_session_create", description: V2_SESSION_CREATE_DESCRIPTION, inputSchema: object({ caller_approved: callerApproved, ...v2Route, wallets: walletMap, event_signer_public: eventSignerPublic, session_token: sessionCapability, idempotency_key: idempotency }, ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets", "session_token", "idempotency_key"]) },
      { name: "assetfare_v2_session_get", description: V2_SESSION_GET_DESCRIPTION, inputSchema: object({ session_token: sessionCapability, session_id: uuid }) },
      { name: "assetfare_v2_session_observe_source", description: V2_SESSION_OBSERVE_SOURCE_DESCRIPTION, inputSchema: object({ session_token: sessionCapability, session_id: uuid, idempotency_key: idempotency, transaction_hashes: { type: "array", items: { type: "string", minLength: 16, maxLength: 128 }, minItems: 1, maxItems: 8 } }) },
      { name: "assetfare_v2_session_observe_output", description: V2_SESSION_OBSERVE_OUTPUT_DESCRIPTION, inputSchema: object({ session_token: sessionCapability, session_id: uuid, idempotency_key: idempotency, transaction_hash: { type: "string", minLength: 16, maxLength: 128 } }, ["session_token", "session_id", "idempotency_key"]) },
      { name: "assetfare_v2_session_refresh_action", description: V2_SESSION_REFRESH_ACTION_DESCRIPTION, inputSchema: object({ session_token: sessionCapability, session_id: uuid, idempotency_key: idempotency }) },
  ];
  const legacyTools = [
      { name: "assetfare_status", description: LEGACY_STATUS_DESCRIPTION, inputSchema: object({}) },
      manifestTool,
      { name: "assetfare_quote", description: LEGACY_QUOTE_DESCRIPTION, inputSchema: object({ amount_usd: { type: "integer", minimum: 1 }, destination_chain: { type: "string", enum: ["base", "arbitrum"], default: "base" } }, ["amount_usd"]) },
      { name: "assetfare_start_wallet_auth", description: "Create a signMessage-only wallet login challenge. It cannot authorize or submit a transaction.", inputSchema: object({ source_wallet: wallet }) },
      { name: "assetfare_finish_wallet_auth", description: "Verify the exact wallet-login message and return a wallet-bound access token. The token is sensitive.", inputSchema: object({ challenge_id: uuid, source_wallet: wallet, signature, terms_version: { type: "string", minLength: 1, maxLength: 160 } }) },
      { name: "assetfare_create_session", description: "Lock a fresh quote into one wallet-bound execution session. Creates no blockchain transaction.", inputSchema: object({ access_token: token, quote_id: uuid, idempotency_key: idempotency, source_wallet: wallet, destination_wallet: evmWallet }) },
      { name: "assetfare_read_session", description: "Read a session, workflow, receipt, or current unsigned action without submitting anything.", inputSchema: object({ access_token: token, session_id: uuid, view: { type: "string", enum: ["session", "workflow", "receipt", "next_action"] } }, ["access_token", "session_id"]) },
      { name: "assetfare_prepare_source_action", description: "Prepare a bounded unsigned Solana source action. Verify it before the caller's own wallet signs/submits.", inputSchema: object({ access_token: token, session_id: uuid }) },
      { name: "assetfare_verify_source_receipt", description: "Verify a caller-submitted finalized Solana signature; never submits a transaction.", inputSchema: object({ access_token: token, session_id: uuid, signature, idempotency_key: idempotency }) },
      { name: "assetfare_prepare_cctp_action", description: "Prepare an unsigned CCTP burn action. The caller owns signing and submission.", inputSchema: object({ access_token: token, session_id: uuid, event_signer_public: wallet, idempotency_key: idempotency }) },
      { name: "assetfare_observe_cctp", description: "Observe an already-submitted CCTP burn and forwarded mint; never submits a transaction.", inputSchema: object({ access_token: token, session_id: uuid, burn_signature: signature, idempotency_key: idempotency }) },
      { name: "assetfare_prepare_destination_action", description: "Prepare an unsigned ERC-4337 settlement plan with bounded permit and deadline.", inputSchema: object({ access_token: token, session_id: uuid, idempotency_key: idempotency }) },
      { name: "assetfare_observe_destination", description: "Verify an already-submitted destination UserOperation receipt; never submits a transaction.", inputSchema: object({ access_token: token, session_id: uuid, transaction_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, idempotency_key: idempotency }) },
  ];
  const tools = profile === "legacy" ? legacyTools : profile === "all" ? [...legacyTools, ...v2Tools.filter((tool) => tool.name !== "assetfare_manifest"), ...(process.env.ASSETFARE_MCP_TRANSPORT === "stdio" ? [{ name: "assetfare_v2_new_session_capability", description: V2_NEW_SESSION_CAPABILITY_DESCRIPTION, inputSchema: object({}) }] : [])] : v2Tools;
  return {
    serverInfo: { name: "AssetFare", version: VERSION },
    authentication: { required: false, schemes: [] },
    profile,
    tools,
    resources: [],
    prompts: [],
  };
}

function addTool(server, name, description, inputSchema, annotations, action, outputSchema) {
  server.registerTool(name, { description, inputSchema, ...(outputSchema ? { outputSchema } : {}), annotations }, async (args) => {
    try { return asText(await action(args), false, Boolean(outputSchema)); }
    catch (error) {
      return asText({ error: error?.message || "assetfare_mcp_request_failed", http_status: error?.status || null, details: error?.payload || null }, true);
    }
  });
}

function createServer(provenance = {}, profile = "v2") {
  if (!new Set(["v2","legacy","all"]).has(profile)) throw new Error("assetfare_mcp_profile_invalid");
  const includeV2 = profile !== "legacy";
  const includeLegacy = profile !== "v2";
  const api = apiClient(provenance);
  const v2Api = apiClient(provenance, V2_API_BASE);
  const server = new McpServer(
    { name: "AssetFare", version: VERSION },
    { instructions: profile === "legacy"
      ? "Legacy compatibility endpoint for the original Solana SOL to Base/Arbitrum ETH workflow. Use only its unversioned tools. It returns unsigned actions and never receives private keys, signs, or submits. New integrations must use https://api.assetfare.dev/mcp."
      : "Current AssetFare v2 endpoint: 100 technically available non-custodial routes. Start with assetfare_v2_capabilities. On the two route-intelligence pilot corridors, assetfare_v2_route_selection uses recent multi-amount exploration only to shortlist three candidates, then quotes all three at the caller's actual amount and returns the fresh top two. Choose one with assetfare_v2_quote_selected_candidate; it reuses the request-time quote while valid and refreshes only that candidate after expiry. Route selection is not execution authority. Prepare only after confirming an AssetFare quote, explicit caller approval and public wallets; choose one-shot prepare or session mode, never both. AssetFare never receives private keys, signs, or submits. Legacy tools live at https://api.assetfare.dev/mcp/legacy." },
  );

  if (includeLegacy) addTool(server, "assetfare_status", LEGACY_STATUS_DESCRIPTION, emptyStrictInput, readonly(), () => api("/v1/status"));
  addTool(server, "assetfare_manifest", V2_MANIFEST_DESCRIPTION, emptyStrictInput, readonly(), async ()=>{const value=await api("/.well-known/assetfare-manifest.json");rejectSigningClaims(value);rejectPrivateOutputMaterial(value);return value;}, v2ManifestOutput);
  if (includeV2) addTool(server, "assetfare_v2_capabilities", V2_CAPABILITIES_DESCRIPTION, emptyStrictInput, readonly(), async () => parseV2Capabilities(await v2Api("/v2/capabilities", { timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true })), v2CapabilitiesResponse);
  if (includeV2) addTool(server, "assetfare_v2_route_selection", V2_ROUTE_SELECTION_DESCRIPTION, v2RouteSelectionIntent, quoteOnly(), async (args) => {
    const intent=parseV2RouteSelectionIntent(args);
    return parseV2RouteSelection(await v2Api("/v2/route-selection",{method:"POST",body:intent,timeoutMs:V2_TIMEOUT_MS,maximumBytes:V2_MAX_RESPONSE_BYTES,rejectRedirects:true,sanitizeErrors:true}),intent);
  },v2RouteSelectionOutput);
  if (includeV2) addTool(server, "assetfare_v2_quote_selected_candidate", V2_SELECTED_QUOTE_DESCRIPTION, v2SelectedQuoteIntent, quoteOnly(), async (args) => {
    const intent=parseV2RouteSelectionIntent(args,true);
    return parseV2SelectedQuote(await v2Api("/v2/route-selection/quote",{method:"POST",body:intent,timeoutMs:V2_TIMEOUT_MS,maximumBytes:V2_MAX_RESPONSE_BYTES,rejectRedirects:true,sanitizeErrors:true}),intent);
  },v2SelectedQuoteToolOutput);
  if (includeV2) addTool(server, "assetfare_v2_quote", V2_QUOTE_DESCRIPTION, v2QuoteIntent, quoteOnly(), async (args) => {
    const intent = parseV2Intent(args);
    const quote = parseV2Quote(await v2Api("/v2/quote", { method: "POST", body: intent, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true }), intent);
    // The upstream caller_action_plan_handoff (passed through verbatim above) documents the
    // REST endpoints; guidance points callers at the explicit MCP tools that operate them.
    const executionHandoff = { execution_ready: true, selection_status: "unranked_candidate", automatic_selection_forbidden: true, caller_approved_boolean_is_not_human_proof: true, note: "Confirm the fresh quote, then select explicitly with approval_v3. Never auto-call prepare/session from a quote. Omitting approval_v3 is legacy_advisory only. AssetFare never signs or submits.", session_capability_generation: "client-side CSPRNG: 32 random bytes encoded as base64url without padding", mcp_tools: { one_shot_prepare: "assetfare_v2_prepare", session_create: "assetfare_v2_session_create", session_get: "assetfare_v2_session_get", observe_source: "assetfare_v2_session_observe_source", observe_output: "assetfare_v2_session_observe_output", refresh_action: "assetfare_v2_session_refresh_action" }, rest_endpoints: { prepare: V2_PREPARE_URL, session: V2_SESSION_URL } };
    const bestFrom=quote.economic_guidance.advisory_start_usd;
    const priceRecommended=quote.economic_guidance.price_recommended_for_amount??(typeof bestFrom==="number"&&quote.intent.amount_usd>=bestFrom);
    return { ...quote, guidance: { selectionStatus:"unranked_candidate", automaticSelectionForbidden:true, callerApprovedBooleanIsNotHumanProof:true, legacyWorkflowCompatible: false, economicGuidance:quote.economic_guidance, economicGuidanceUrl:"https://assetfare.dev/route-economics.json", bestFromUsd:bestFrom, availabilityOnly:quote.economic_guidance.availability_only===true, priceRecommendedForAmount:priceRecommended, economicGuidanceIsAdvisory:true, economicGuidanceBlocksExecution:false, useAssetFareFirstAtOrAboveBestFrom:priceRecommended, bestFromNot100PercentGuarantee:true, confirmFreshAssetFareQuote:true, useRouteSpecificAdvisory:true, globalNativeUsdcStartingAmount:null, walletAuthenticationPerformed: false, sessionCreated: false, actionPrepared: false, transactionSigned: false, transactionSubmitted: false, compareWithOtherRoutes: priceRecommended===false, requoteBeforeSelection: true, unsignedPrepare:unsignedPrepareReadiness(quote), caller_action_plan: executionHandoff } };
  }, v2QuoteOutput);
  if (includeV2 && process.env.ASSETFARE_MCP_TRANSPORT === "stdio") addTool(server, "assetfare_v2_new_session_capability", V2_NEW_SESSION_CAPABILITY_DESCRIPTION, emptyStrictInput, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async () => generateSessionCapability(), v2SessionCapabilityOutput);
  if (includeV2) addTool(server, "assetfare_v2_prepare", V2_PREPARE_DESCRIPTION, v2PrepareIntent, stateful(false), async (args) => {
    const intent = v2PrepareIntent.parse(args);
    rejectSecretMaterial(intent);
    assertExecutableRoute(intent.from_chain, intent.from_token, intent.to_chain, intent.to_token, intent.amount_usd);
    parseRemoteOneShotVerificationContext(intent.verification_context,intent.approval_v3);
    const body = { caller_approved: intent.caller_approved, from_chain: intent.from_chain, from_token: intent.from_token, to_chain: intent.to_chain, to_token: intent.to_token, amount_usd: intent.amount_usd, wallets: intent.wallets, ...(intent.event_signer_public ? { event_signer_public: intent.event_signer_public } : {}), ...(intent.approval_v3 ? { approval_v3: intent.approval_v3 } : {}) };
    return verifyRemoteBundle(await v2Api("/v2/prepare", { method: "POST", body, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true }),intent.verification_context,intent.approval_v3);
  }, v2VerifiedBundleOutput);
  if (includeV2) addTool(server, "assetfare_v2_session_create", V2_SESSION_CREATE_DESCRIPTION, v2SessionCreateIntent, stateful(true), async (args) => {
    const intent = v2SessionCreateIntent.parse(args);
    if(intent.approval_v3&&intent.approval_v3.idempotency_key!==intent.idempotency_key)throw new Error("assetfare_v2_approval_v3_idempotency_mismatch");
    rejectSecretMaterial({ ...intent, session_token: undefined });
    assertExecutableRoute(intent.from_chain, intent.from_token, intent.to_chain, intent.to_token, intent.amount_usd);
    parseRemoteVerificationContext(intent.verification_context,intent.approval_v3);
    const body = { caller_approved: intent.caller_approved, from_chain: intent.from_chain, from_token: intent.from_token, to_chain: intent.to_chain, to_token: intent.to_token, amount_usd: intent.amount_usd, wallets: intent.wallets, idempotency_key: intent.idempotency_key, ...(intent.event_signer_public ? { event_signer_public: intent.event_signer_public } : {}), ...(intent.approval_v3 ? { approval_v3: intent.approval_v3 } : {}) };
    return verifyRemoteSession(await v2Api("/v2/session", { method: "POST", body, extraHeaders: { [V2_SESSION_TOKEN_HEADER]: intent.session_token }, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true }), intent.verification_context, intent.session_token, intent.approval_v3 || null);
  }, v2SessionOutput);
  if (includeV2) addTool(server, "assetfare_v2_session_get", V2_SESSION_GET_DESCRIPTION, v2SessionReadIntent, readonly(), async ({ session_token, session_id,verification_context }) => {parseRemoteVerificationContext(verification_context);return verifyRemoteSession(await v2Api(`/v2/session/${session_id}`, { extraHeaders: { [V2_SESSION_TOKEN_HEADER]: session_token }, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true }),verification_context,session_token);}, v2SessionOutput);
  if (includeV2) addTool(server, "assetfare_v2_session_observe_source", V2_SESSION_OBSERVE_SOURCE_DESCRIPTION, v2SessionObserveSourceIntent, stateful(true), async ({ session_token, session_id, idempotency_key, transaction_hashes,verification_context }) => {parseRemoteVerificationContext(verification_context);return verifyRemoteSession(await v2Api(`/v2/session/${session_id}/observe-source`, { method: "POST", body: { idempotency_key, transaction_hashes }, extraHeaders: { [V2_SESSION_TOKEN_HEADER]: session_token }, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true }),verification_context,session_token);}, v2SessionOutput);
  if (includeV2) addTool(server, "assetfare_v2_session_observe_output", V2_SESSION_OBSERVE_OUTPUT_DESCRIPTION, v2SessionObserveOutputIntent, stateful(true), async ({ session_token, session_id, idempotency_key, transaction_hash,verification_context }) => {parseRemoteVerificationContext(verification_context);return verifyRemoteSession(await v2Api(`/v2/session/${session_id}/observe-output`, { method: "POST", body: { idempotency_key, ...(transaction_hash ? { transaction_hash } : {}) }, extraHeaders: { [V2_SESSION_TOKEN_HEADER]: session_token }, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true }),verification_context,session_token);}, v2SessionOutput);
  if (includeV2) addTool(server, "assetfare_v2_session_refresh_action", V2_SESSION_REFRESH_ACTION_DESCRIPTION, v2SessionRefreshIntent, stateful(true), async ({ session_token, session_id, idempotency_key,verification_context }) => {parseRemoteVerificationContext(verification_context);return verifyRemoteSession(await v2Api(`/v2/session/${session_id}/refresh-action`, { method: "POST", body: { idempotency_key }, extraHeaders: { [V2_SESSION_TOKEN_HEADER]: session_token }, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true }),verification_context,session_token);}, v2SessionOutput);
  if (includeLegacy) addTool(server, "assetfare_quote", LEGACY_QUOTE_DESCRIPTION, legacyQuoteIntent, readonly(), ({ amount_usd, destination_chain }) => api("/v1/quote", { method: "POST", body: { from_chain: "solana", from_token: "SOL", to_chain: destination_chain, to_token: "ETH", amount_usd } }));

  if (includeLegacy) addTool(server, "assetfare_start_wallet_auth", "Create a short-lived, non-transactional Solana signMessage challenge for the legacy v1 workflow. Use only after selecting a fresh legacy assetfare_quote and obtaining caller approval; v2 quote and session tools do not use wallet authentication. Makes a network request and creates login-challenge state, but cannot move funds, sign, or submit.", legacyStartAuthIntent, stateful(false), ({ source_wallet }) => api("/v1/auth/challenge", { method: "POST", body: { source_wallet } }));
  if (includeLegacy) {
  addTool(server, "assetfare_finish_wallet_auth", "Verify the caller's signature over the exact legacy login challenge and return a sensitive wallet-bound access token. Use only after assetfare_start_wallet_auth; do not use for a v2 session, transaction signature, or arbitrary message. Makes a network request and consumes login-challenge state, but never signs or submits.", legacyFinishAuthIntent, stateful(false), (args) => api("/v1/auth/verify", { method: "POST", body: args }));

  addTool(server, "assetfare_create_session", "Lock one fresh legacy assetfare_quote into a wallet-bound v1 execution session. Use only after legacy wallet authentication for the original Solana-SOL-to-Base/Arbitrum-ETH workflow; for a v2 quote use assetfare_v2_session_create instead. Makes a network request and reserves the caller's one active legacy session slot, but creates no blockchain transaction and never signs or submits.", legacyCreateSessionIntent, stateful(true), ({ access_token, ...body }) => api("/v1/session", { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_read_session", "Read a legacy v1 session summary, workflow state, receipt, or current unsigned action. Use to inspect or resume a session created by assetfare_create_session; for a v2 session use assetfare_v2_session_get instead and do not use this call to advance state. Read-only and makes a network request; never signs or submits.", legacyReadSessionIntent, readonly(), ({ access_token, session_id, view }) => api(`/v1/session/${session_id}${view === "session" ? "" : `/${view === "next_action" ? "next-action" : view}`}`, { token: access_token }));
  addTool(server, "assetfare_prepare_source_action", "Prepare the bounded unsigned Solana source action for the current legacy v1 session step. Use only after assetfare_create_session and explicit caller approval; for a v2 route use assetfare_v2_prepare or assetfare_v2_session_create instead. Makes a network request and advances preparation state, but never signs or submits.", legacyPrepareSourceIntent, stateful(true), ({ access_token, session_id }) => api(`/v1/session/${session_id}/prepare-source-action`, { method: "POST", token: access_token, body: {} }));
  addTool(server, "assetfare_verify_source_receipt", "Verify a finalized Solana source signature already submitted by the caller and advance the legacy v1 workflow. Use only after the caller independently submits assetfare_prepare_source_action; for a v2 session use assetfare_v2_session_observe_source instead. Requires caller approval and makes a network request, but never signs or submits.", legacyVerifySourceIntent, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/verify-source`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_prepare_cctp_action", "Prepare the unsigned CCTP burn for the current legacy v1 session using a caller-owned event signer public key. Use only when the legacy workflow reports this as the next action; for v2 routes use assetfare_v2_prepare or assetfare_v2_session_create instead. Requires caller approval and advances preparation state, but never receives the event signer private key, signs, or submits.", legacyPrepareCctpIntent, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/prepare-cctp-action`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_observe_cctp", "Verify Circle attestation and the forwarded Base or Arbitrum USDC mint for a caller-submitted legacy v1 burn, then advance the session record. Use only after the CCTP burn is submitted; use assetfare_read_session for inspection without advancement and a v2 session observe tool for v2 routes. Makes a network request but never signs or submits.", legacyObserveCctpIntent, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/observe-cctp`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_prepare_destination_action", "Prepare the exact-cap permit and unsigned ERC-4337 destination settlement plan for the current legacy v1 session. Use only when the legacy workflow reports the destination step and after caller approval; v2 sessions expose their current action through assetfare_v2_session_get. Makes a network request and advances preparation state, but never signs or submits.", legacyPrepareDestinationIntent, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/prepare-destination-action`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_observe_destination", "Verify an already-submitted destination UserOperation receipt and finalize the legacy v1 workflow record. Use only after the caller independently submits assetfare_prepare_destination_action; for v2 output observation use assetfare_v2_session_observe_output instead. Makes a network request and advances session state, but never signs or submits.", legacyObserveDestinationIntent, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/observe-destination`, { method: "POST", token: access_token, body }));
  }

  if (includeLegacy) server.registerResource("assetfare-trust-manifest", "assetfare://trust/manifest", { description: "Current signed AssetFare trust manifest." }, async () => ({ contents: [{ uri: "assetfare://trust/manifest", mimeType: "application/json", text: JSON.stringify(await api("/.well-known/assetfare-manifest.json"), null, 2) }] }));
  return server;
}

function allowedOrigin(origin) { return !origin || ORIGINS.has(origin); }
function allowedHost(host) { return host === PUBLIC_HOST || LOCAL_HOSTS.has(host); }

function normalizeA2AVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(String(value || "").trim());
  return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}

function a2aVersionGuard(supportedVersions) {
  const supported = [...new Set((Array.isArray(supportedVersions) ? supportedVersions : [supportedVersions]).map(normalizeA2AVersion).filter(Boolean))];
  if (!supported.length) throw new Error("A2A JSONRPC supported version missing");
  return (req, res, next) => {
    const rawRequestedVersion = String(req.get("a2a-version") || "0.3");
    const requestedVersion = rawRequestedVersion.slice(0, 32);
    const normalizedRequestedVersion = rawRequestedVersion.length <= 32 ? normalizeA2AVersion(rawRequestedVersion) : null;
    if (supported.includes(normalizedRequestedVersion)) {
      req.headers["a2a-version"] = normalizedRequestedVersion;
      return next();
    }
    const requestId = req.body?.id;
    const safeId = requestId === null || typeof requestId === "string" || typeof requestId === "number" ? requestId : null;
    return res.status(400).set("cache-control", "no-store").vary("A2A-Version").json({
      jsonrpc: "2.0",
      id: safeId ?? null,
      error: {
        code: -32009,
        message: `The requested A2A protocol version '${requestedVersion}' is not supported. Supported versions: ${supported.join(", ")}`,
        data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "VERSION_NOT_SUPPORTED", domain: "a2a-protocol.org" }],
      },
    });
  };
}

function createHttpApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => allowedHost(req.get("host") || "") ? next() : res.status(421).json({ error: "assetfare_host_not_allowed" }));
  app.use(express.json({ limit: "32kb", type: ["application/json", "application/*+json"] }));
  const a2a=createAssetFareA2A({ apiBaseUrl:A2A_API_BASE, serviceUrl:A2A_SERVICE_URL });
  const card=agentCardHandler({ agentCardProvider:async()=>a2a.card, cache:{ maxAge:300 } });
  const rpc=jsonRpcHandler({ requestHandler:a2a.requestHandler, userBuilder:UserBuilder.noAuthentication });
  const guardA2AVersion=a2aVersionGuard(a2a.card.supportedInterfaces.filter((item)=>item.protocolBinding==="JSONRPC").map((item)=>item.protocolVersion));
  app.use(`/${AGENT_CARD_PATH}`,card);
  app.use("/.well-known/agent.json",card);
  for (const [path, channel] of Object.entries(A2A_DISCOVERY_CHANNELS)) {
    app.use(path, (req, res, next) => {
      if (!['GET', 'HEAD'].includes(req.method)) return res.set('Allow', 'GET, HEAD').status(405).json({ error: 'a2a_discovery_card_method_not_allowed' });
      res.set("X-AssetFare-Discovery-Channel", channel);
      return card(req, res, next);
    });
  }
  app.use("/a2a",(req,res,next)=>{
    if(req.method==="HEAD")return res.set("allow","POST, OPTIONS").set("cache-control","no-store").status(405).end();
    if(req.method==="OPTIONS")return res.set("allow","POST, OPTIONS").set("cache-control","no-store").status(204).end();
    if(req.method!=="POST")return res.set("allow","POST, OPTIONS").status(405).json({error:"a2a_method_not_allowed"});
    return guardA2AVersion(req,res,()=>rpc(req,res,next));
  });
  app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok", service: "assetfare-mcp-a2a", version: VERSION, mcp:true, a2a:true, a2a_protocol_version:a2a.card.supportedInterfaces[0].protocolVersion, server_signing:false, server_submission:false }));
  app.get("/.well-known/mcp/server-card.json", async (_req, res, next) => {try{return res.status(200).type("application/json").json(await serverCard("v2"));}catch(error){return next(error);}});
  app.get("/.well-known/mcp/legacy-server-card.json", async (_req, res, next) => {try{return res.status(200).type("application/json").json(await serverCard("legacy"));}catch(error){return next(error);}});
  for (const [mcpPath,profile] of Object.entries({"/mcp":"v2","/mcp/bridge":"v2","/mcp/legacy":"legacy"})) {
    app.options(mcpPath,(req,res)=>{
      if(!allowedOrigin(req.get("origin")))return res.status(403).json({error:"mcp_origin_not_allowed"});
      return res.set("allow","GET, HEAD, POST, DELETE, OPTIONS").set("access-control-allow-origin",req.get("origin")||"*").set("access-control-allow-methods","GET, HEAD, POST, DELETE, OPTIONS").set("access-control-allow-headers","content-type, mcp-protocol-version, mcp-session-id, authorization").set("access-control-max-age","600").set("cache-control","no-store").status(204).end();
    });
    app.head(mcpPath, (req, res) => {
      if (!allowedOrigin(req.get("origin"))) return res.status(403).end();
      return res.set("allow", "GET, HEAD, POST, DELETE, OPTIONS").set("cache-control", "no-store").status(200).end();
    });
    app.all(mcpPath, async (req, res) => {
      if (!allowedOrigin(req.get("origin"))) return res.status(403).json({ error: "mcp_origin_not_allowed" });
      try {
        const server = createServer(provenanceFromHeaders(req.headers), profile);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => transport.close().catch(() => {}));
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (_error) {
        if (!res.headersSent) res.status(500).json({ error: "assetfare_mcp_internal_error" });
      }
    });
  }
  app.use((error,_req,res,_next)=>{
    if(error?.type==="entity.too.large")return res.status(413).json({error:"request_body_too_large"});
    if(error instanceof SyntaxError)return res.status(400).json({error:"invalid_json"});
    return res.status(500).json({error:"assetfare_adapter_internal_error"});
  });
  return app;
}

async function serveHttp() {
  const app=createHttpApp();
  app.listen(PORT, HOST, () => process.stdout.write(`assetfare-mcp listening on ${HOST}:${PORT}\n`));
}

async function main() {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("AssetFare MCP server\n\nUsage:\n  assetfare-mcp [--help]\n\nConfigure HTTP or stdio transport with the documented ASSETFARE_MCP_* environment variables.\n");
    return;
  }
  if (process.env.ASSETFARE_MCP_TRANSPORT === "stdio") {
    const server = createServer({}, "all");
    await server.connect(new StdioServerTransport());
    return;
  }
  await serveHttp();
}

if (isMain(import.meta.url)) main().catch(() => process.exit(1));

export { DIRECT_ROUTE_CONTRACT_COUNTS, V2_API_BASE, V2_MAX_RESPONSE_BYTES, V2_TIMEOUT_MS, a2aVersionGuard, allowedHost, createHttpApp, createServer, normalizeA2AVersion, parseRemoteVerificationContext, parseV2Bundle, parseV2Capabilities, parseV2Intent, parseV2Quote, parseV2Session, provenanceFromHeaders, serverCard, verifyRemoteSession };
