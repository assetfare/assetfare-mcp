#!/usr/bin/env node
import express from "express";
import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { agentCardHandler, jsonRpcHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { z } from "zod";
import { AGENT_CARD_PATH, createAssetFareA2A } from "./a2a.js";

const VERSION = "0.4.6";
const API_BASE = (process.env.ASSETFARE_API_BASE_URL || "https://api.assetfare.dev").replace(/\/$/, "");
// The legacy v1 API and the six-chain source v2 API run on separate local services
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
const V2_SOURCE_CHAINS = ["solana", "base", "arbitrum", "robinhood", "polygon", "optimism"];
const V2_DESTINATION_CHAINS = ["solana", "base", "arbitrum", "robinhood"];
const V2_SOURCE_ONLY_CHAINS = new Set(["polygon", "optimism"]);
const V2_TOKENS = ["SOL", "ETH", "USDC", "USDG"];
const V2_ENDPOINTS = new Set([
  "solana:SOL", "solana:USDC", "solana:USDG",
  "base:ETH", "base:USDC",
  "arbitrum:ETH", "arbitrum:USDC",
  "robinhood:ETH", "robinhood:USDG",
  "polygon:USDC",
  "optimism:USDC",
]);
// Canonical caller_action_plan_handoff shape (upstream is the authority; the adapter
// FAIL-CLOSES if it deviates). Fixed origin for the caller-operated prepare/session REST.
const V2_PREPARE_URL = "https://api.assetfare.dev/v2/prepare";
const V2_SESSION_URL = "https://api.assetfare.dev/v2/session";
const V2_HANDOFF_REQUEST_FIELDS = ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets", "event_signer_public"];
const V2_FEE_COLLECTION_CONST = "only_on_eligible_successful_executor_step";
const V2_SESSION_TOKEN_HEADER = "x-assetfare-session-token";
const LEGACY_STATUS_DESCRIPTION = "Read legacy v1 compatibility status and original-corridor safety gates. Use assetfare_v2_capabilities for the primary six-chain source quote and execution surface.";
const LEGACY_QUOTE_DESCRIPTION = "Legacy v1 original-corridor quote for Solana SOL to Base or Arbitrum ETH. Use only with the legacy wallet-auth/session workflow; prefer assetfare_v2_quote for new evaluations.";
const V2_CAPABILITIES_DESCRIPTION = "AssetFare supports Solana SOL to Base USDC and 75 other execution-ready routes: six chains, eleven source endpoints, flat 1bp, with Polygon/Optimism native-USDC source-only routes. Read the live matrix and no-sign/no-submit boundary before quoting.";
const V2_QUOTE_DESCRIPTION = "Get one fresh AssetFare quote for any of 76 execution-ready routes, including Solana SOL to Base USDC, Solana USDC to Base USDC, and Optimism USDC to Base USDC. Flat 1bp. Returns a caller-approved unsigned-action handoff; never signs, submits, authenticates, creates a session, or prepares an action from the quote call.";
const V2_NEW_SESSION_CAPABILITY_DESCRIPTION = "Local-only: generate one caller-owned high-entropy session capability token (>=256-bit CSPRNG, url-safe, 43-128 chars). Makes NO network call. Store it as a SENSITIVE capability (never a private key); pass it into assetfare_v2_session_create and every session read/observe/refresh.";
const V2_PREPARE_DESCRIPTION = "Explicit caller-approved one-shot: POST the fixed-origin /v2/prepare to obtain the fresh re-quoted bounded FIRST unsigned action bundle for any of the 76 execution-ready routes. Requires caller_approved:true and the route's exact public wallet map. Never auto-called from a quote; rejects any private key/seed/signed transaction. AssetFare never signs or submits.";
const V2_SESSION_CREATE_DESCRIPTION = "Explicit caller-approved: create one idempotent receipt-driven /v2/session for an execution-ready route and return its first unsigned action. Requires caller_approved:true, a caller-generated session capability token (X-AssetFare-Session-Token), and the route's exact public wallet map. Never auto-chains, signs, or submits.";
const V2_SESSION_GET_DESCRIPTION = "Read a v2 session's current workflow state and current unsigned action. Requires the caller's session capability token. Read-only; never signs or submits.";
const V2_SESSION_OBSERVE_SOURCE_DESCRIPTION = "Observe the caller's already-submitted source transaction hashes for a v2 session and advance the workflow. Requires the caller's session capability token. Never submits a transaction.";
const V2_SESSION_OBSERVE_OUTPUT_DESCRIPTION = "Observe the caller's already-produced bridge/destination output for a v2 session and advance the workflow. Requires the caller's session capability token. Never submits a transaction.";
const V2_SESSION_REFRESH_ACTION_DESCRIPTION = "Replace an expired unsubmitted v2 session action with a fresh quote-bound unsigned action. Requires the caller's session capability token. Never signs or submits.";

const accessToken = z.string().min(20).max(512);
const sessionId = z.string().uuid();
const idempotencyKey = z.string().min(8).max(128);
const sourceWallet = z.string().min(32).max(64);
const destinationWallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const v2QuoteFields = {
  from_chain: z.enum(V2_SOURCE_CHAINS),
  from_token: z.enum(V2_TOKENS),
  to_chain: z.enum(V2_DESTINATION_CHAINS),
  to_token: z.enum(V2_TOKENS),
  amount_usd: z.number().finite().min(1).max(1000),
};
const emptyStrictInput = z.object({}).strict();
const v2QuoteIntent = z.object(v2QuoteFields).strict();
// A caller-generated session capability token: high-entropy, url-safe, 43-128 chars.
// It is a SENSITIVE bearer capability, NOT a private key; the server stores only its hash.
const v2SessionToken = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
// Public wallet address: EVM 0x-40-hex or Solana base58 (32-44). Never a private key/seed.
const v2PublicAddress = z.string().refine((value) => /^0x[0-9a-fA-F]{40}$/.test(value) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value), "assetfare_v2_wallet_not_public_address");
const v2WalletMap = z.record(z.enum(V2_SOURCE_CHAINS), v2PublicAddress).refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 6, "assetfare_v2_wallets_out_of_range");
const v2PrepareFields = {
  caller_approved: z.literal(true),
  from_chain: z.enum(V2_SOURCE_CHAINS),
  from_token: z.enum(V2_TOKENS),
  to_chain: z.enum(V2_DESTINATION_CHAINS),
  to_token: z.enum(V2_TOKENS),
  amount_usd: z.number().finite().min(1).max(1000),
  wallets: v2WalletMap,
  event_signer_public: v2PublicAddress.optional(),
};
const v2PrepareIntent = z.object(v2PrepareFields).strict();
const v2SessionCreateIntent = z.object({ ...v2PrepareFields, session_token: v2SessionToken, idempotency_key: idempotencyKey }).strict();
const v2SessionReadIntent = z.object({ session_token: v2SessionToken, session_id: sessionId }).strict();
const v2SessionObserveSourceIntent = z.object({ session_token: v2SessionToken, session_id: sessionId, idempotency_key: idempotencyKey, transaction_hashes: z.array(z.string().min(16).max(128)).min(1).max(8) }).strict();
const v2SessionObserveOutputIntent = z.object({ session_token: v2SessionToken, session_id: sessionId, idempotency_key: idempotencyKey, transaction_hash: z.string().min(16).max(128).optional() }).strict();
const v2SessionRefreshIntent = z.object({ session_token: v2SessionToken, session_id: sessionId, idempotency_key: idempotencyKey }).strict();
const V2_SOURCE_ONLY_ENDPOINTS = ["optimism:USDC", "polygon:USDC"];
const V2_SOURCE_ONLY_ROUTES = ["optimism:USDC->arbitrum:USDC", "optimism:USDC->base:USDC", "polygon:USDC->arbitrum:USDC", "polygon:USDC->base:USDC"];
const v2CapabilitiesResponse = z.object({
  status: z.literal("capped_public_agent_release"),
  public_api_enabled: z.literal(true),
  asset_endpoints: z.array(z.object({ chain: z.enum(V2_SOURCE_CHAINS), token: z.enum(V2_TOKENS) }).strict()).length(11),
  source_only_asset_endpoints:z.array(z.object({chain:z.enum(["polygon","optimism"]),token:z.literal("USDC")}).strict()).length(2),
  source_only_routes:z.array(z.enum(["polygon:USDC->base:USDC","polygon:USDC->arbitrum:USDC","optimism:USDC->base:USDC","optimism:USDC->arbitrum:USDC"])).length(4),
  directed_conversion_routes: z.literal(76),
  unsigned_route_plans_ready: z.literal(76),
  execution_ready_routes: z.literal(76),
  phase_b_blocked_routes: z.literal(0),
  blocked_source_only_routes: z.array(z.never()).length(0),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).passthrough();
const v2QuoteResponse = z.object({
  quote_id: z.string().uuid(),
  status: z.literal("capped_public_agent_release"),
  as_of: z.string().min(1).max(64),
  ttl_seconds: z.number().int().positive().max(300),
  intent: z.object({ from: z.string(), to: z.string(), amount_usd: z.number().finite(), estimated_input_base: z.number().int().positive() }).passthrough(),
  offer: z.object({
    expected_receive_amount: z.number().finite().positive(),
    estimated_min_receive_amount: z.number().finite().positive(),
    output_symbol: z.enum(V2_TOKENS),
    estimated_time_seconds: z.number().int().nonnegative().nullable(),
    assetfare_fee_bps: z.literal(1),
    fee_modeled_bps: z.literal(1),
    fee_collectible_now: z.literal(true),
    fee_collection_steps: z.array(z.number().int().nonnegative()).length(1),
    fee_collection: z.literal(V2_FEE_COLLECTION_CONST),
  }).passthrough(),
  route: z.object({
    steps: z.array(z.record(z.unknown())).min(1).max(8),
    server_signing: z.literal(false),
    server_submission: z.literal(false),
  }).passthrough(),
  risk: z.object({ server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough(),
  execution: z.object({
    supported: z.boolean(),
    first_unsigned_action_supported: z.boolean(),
  }).passthrough(),
  caller_action_plan_handoff: z.object({}).passthrough(),
}).passthrough();

function asText(value, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
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
  if (V2_SOURCE_ONLY_CHAINS.has(intent.from_chain) && !(intent.from_token === "USDC" && ["base", "arbitrum"].includes(intent.to_chain) && intent.to_token === "USDC")) throw new Error("assetfare_v2_source_only_route_unsupported");
  return intent;
}

// Gate a prepare/session route BEFORE any network call: endpoints must be real, the route
// must not be an identity, and directional source-only chains may use only their audited
// native-USDC corridors to Base or Arbitrum USDC.
function assertExecutableRoute(fromChain, fromToken, toChain, toToken) {
  const source = `${fromChain}:${fromToken}`;
  const destination = `${toChain}:${toToken}`;
  if (!V2_ENDPOINTS.has(source)) throw new Error("assetfare_v2_source_endpoint_unsupported");
  if (!V2_ENDPOINTS.has(destination)) throw new Error("assetfare_v2_destination_endpoint_unsupported");
  if (source === destination) throw new Error("assetfare_v2_identity_route_not_required");
  if (V2_SOURCE_ONLY_CHAINS.has(fromChain) && !(fromToken === "USDC" && ["base", "arbitrum"].includes(toChain) && toToken === "USDC")) throw new Error("assetfare_v2_source_only_route_unsupported");
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
  while(stack.length){const [node,depth]=stack.pop();seen+=1;if(seen>512||depth>12)throw new Error("assetfare_v2_safety_boundary_failed");if(Array.isArray(node)){for(const child of node)stack.push([child,depth+1]);continue;}if(node&&typeof node==="object"){for(const key of ["server_signing","server_submission"])if(key in node&&node[key]!==false)throw new Error("assetfare_v2_safety_boundary_failed");for(const child of Object.values(node))stack.push([child,depth+1]);}}
}

function parseV2Capabilities(payload) {
  rejectSigningClaims(payload);
  let value;
  try { value = v2CapabilitiesResponse.parse(payload); }
  catch { throw new Error("assetfare_v2_safety_boundary_failed"); }
  const endpoints = new Set(value.asset_endpoints.map((item) => `${item.chain}:${item.token}`));
  if (endpoints.size !== V2_ENDPOINTS.size || [...V2_ENDPOINTS].some((item) => !endpoints.has(item))) throw new Error("assetfare_v2_safety_boundary_failed");
  if(new Set(value.source_only_routes).size!==4)throw new Error("assetfare_v2_safety_boundary_failed");
  if(value.blocked_source_only_routes.length!==0)throw new Error("assetfare_v2_safety_boundary_failed");
  return value;
}

// Validate the upstream bounded first unsigned action bundle returned by /v2/prepare and
// by /v2/session create. Fail-closed on any server signing/submission claim.
function parseV2Bundle(payload) {
  rejectSigningClaims(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("assetfare_v2_bundle_invalid");
  if (payload.server_signing !== false || payload.server_submission !== false || payload.signed !== false || payload.submitted !== false) throw new Error("assetfare_v2_bundle_unsafe");
  if (!payload.unsigned_action || typeof payload.unsigned_action !== "object") throw new Error("assetfare_v2_bundle_missing_action");
  return payload;
}

// Validate a v2 session workflow-state response. It must never assert signing/submission.
function parseV2Session(payload) {
  rejectSigningClaims(payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("assetfare_v2_session_invalid");
  if (typeof payload.session_id !== "string" || !payload.session_id) throw new Error("assetfare_v2_session_invalid");
  if (payload.server_signing !== false || payload.server_submission !== false || payload.signed !== false || payload.submitted !== false) throw new Error("assetfare_v2_session_unsafe");
  return payload;
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

function parseV2Quote(payload, intent) {
  rejectSigningClaims(payload);
  let value;
  try { value = v2QuoteResponse.parse(payload); }
  catch { throw new Error("assetfare_v2_safety_boundary_failed"); }
  if (value.intent.from !== `${intent.from_chain}:${intent.from_token}` || value.intent.to !== `${intent.to_chain}:${intent.to_token}` || value.intent.amount_usd !== intent.amount_usd) throw new Error("assetfare_v2_quote_binding_failed");
  if (value.offer.output_symbol !== intent.to_token || value.offer.estimated_min_receive_amount > value.offer.expected_receive_amount) throw new Error("assetfare_v2_quote_binding_failed");
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

// Wallet-bound workflow tools use an access token produced by the preceding
// non-transactional signMessage flow. They never require a server-side API key
// or give the server signing/submission authority.
function serverCard() {
  const token = { type: "string", minLength: 20, maxLength: 512 };
  const uuid = { type: "string", format: "uuid" };
  const wallet = { type: "string", minLength: 32, maxLength: 64 };
  const evmWallet = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
  const idempotency = { type: "string", minLength: 8, maxLength: 128 };
  const signature = { type: "string", minLength: 64, maxLength: 128 };
  const sessionCapability = { type: "string", pattern: "^[A-Za-z0-9_-]{43,128}$" };
  const publicAddress = { type: "string" };
  const walletMap = { type: "object", additionalProperties: publicAddress };
  const callerApproved = { type: "boolean", const: true };
  const amountUsd = { type: "number", minimum: 1, maximum: 1000 };
  const v2Route = { from_chain: { type: "string", enum: V2_SOURCE_CHAINS }, from_token: { type: "string", enum: V2_TOKENS }, to_chain: { type: "string", enum: V2_DESTINATION_CHAINS }, to_token: { type: "string", enum: V2_TOKENS }, amount_usd: amountUsd };
  const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
  return {
    serverInfo: { name: "AssetFare", version: VERSION },
    authentication: { required: false, schemes: [] },
    tools: [
      { name: "assetfare_status", description: LEGACY_STATUS_DESCRIPTION, inputSchema: object({}) },
      { name: "assetfare_manifest", description: "Read the signed release, contract, and mainnet-evidence manifest.", inputSchema: object({}) },
      { name: "assetfare_v2_capabilities", description: V2_CAPABILITIES_DESCRIPTION, inputSchema: object({}) },
      { name: "assetfare_v2_quote", description: V2_QUOTE_DESCRIPTION, inputSchema: object({ from_chain: { type: "string", enum: V2_SOURCE_CHAINS }, from_token: { type: "string", enum: V2_TOKENS }, to_chain: { type: "string", enum: V2_DESTINATION_CHAINS }, to_token: { type: "string", enum: V2_TOKENS }, amount_usd: { type: "number", minimum: 1, maximum: 1000 } }) },
      { name: "assetfare_quote", description: LEGACY_QUOTE_DESCRIPTION, inputSchema: object({ amount_usd: { type: "integer", minimum: 1, maximum: 1000 }, destination_chain: { type: "string", enum: ["base", "arbitrum"], default: "base" } }, ["amount_usd"]) },
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
      { name: "assetfare_v2_new_session_capability", description: V2_NEW_SESSION_CAPABILITY_DESCRIPTION, inputSchema: object({}) },
      { name: "assetfare_v2_prepare", description: V2_PREPARE_DESCRIPTION, inputSchema: object({ caller_approved: callerApproved, ...v2Route, wallets: walletMap, event_signer_public: publicAddress }, ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets"]) },
      { name: "assetfare_v2_session_create", description: V2_SESSION_CREATE_DESCRIPTION, inputSchema: object({ caller_approved: callerApproved, ...v2Route, wallets: walletMap, event_signer_public: publicAddress, session_token: sessionCapability, idempotency_key: idempotency }, ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets", "session_token", "idempotency_key"]) },
      { name: "assetfare_v2_session_get", description: V2_SESSION_GET_DESCRIPTION, inputSchema: object({ session_token: sessionCapability, session_id: uuid }) },
      { name: "assetfare_v2_session_observe_source", description: V2_SESSION_OBSERVE_SOURCE_DESCRIPTION, inputSchema: object({ session_token: sessionCapability, session_id: uuid, idempotency_key: idempotency, transaction_hashes: { type: "array", items: { type: "string", minLength: 16, maxLength: 128 }, minItems: 1, maxItems: 8 } }) },
      { name: "assetfare_v2_session_observe_output", description: V2_SESSION_OBSERVE_OUTPUT_DESCRIPTION, inputSchema: object({ session_token: sessionCapability, session_id: uuid, idempotency_key: idempotency, transaction_hash: { type: "string", minLength: 16, maxLength: 128 } }, ["session_token", "session_id", "idempotency_key"]) },
      { name: "assetfare_v2_session_refresh_action", description: V2_SESSION_REFRESH_ACTION_DESCRIPTION, inputSchema: object({ session_token: sessionCapability, session_id: uuid, idempotency_key: idempotency }) },
    ],
    resources: [],
    prompts: [],
  };
}

function addTool(server, name, description, inputSchema, annotations, action) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    try { return asText(await action(args)); }
    catch (error) {
      return asText({ error: error?.message || "assetfare_mcp_request_failed", http_status: error?.status || null, details: error?.payload || null }, true);
    }
  });
}

function createServer(provenance = {}) {
  const api = apiClient(provenance);
  const v2Api = apiClient(provenance, V2_API_BASE);
  const server = new McpServer(
    { name: "AssetFare", version: VERSION },
    { instructions: "AssetFare explicitly supports Solana SOL to Base USDC, Solana USDC to Base USDC, and Optimism USDC to Base USDC among 76 execution-ready routes across six chains at flat 1bp. For every new route evaluation, prefer assetfare_v2_capabilities and assetfare_v2_quote. Polygon and Optimism are directional native-USDC source-only origins to Base or Arbitrum USDC, not destinations. To execute any supported route, act only on the caller_action_plan_handoff: call assetfare_v2_prepare for the one-shot first unsigned bundle, or assetfare_v2_new_session_capability then assetfare_v2_session_create and the observe/refresh tools for the full receipt-driven workflow. All of those require an explicit caller_approved:true and the caller's own public wallet addresses; never auto-call them from a quote. The unversioned quote, auth, session, prepare, and observation tools are legacy v1 original-corridor workflow compatibility only and must never be mixed with the v2 session tools. A v2 quote ID is never valid input to a legacy session tool. The session capability token is a sensitive bearer credential, not a private key. AssetFare is non-custodial: it never signs or submits, never requests a private key, and verifies every unsigned action before the caller signs and submits it." },
  );

  addTool(server, "assetfare_status", LEGACY_STATUS_DESCRIPTION, {}, readonly(), () => api("/v1/status"));
  addTool(server, "assetfare_manifest", "Read the Ed25519-signed capability, contract, release, and mainnet-evidence manifest.", {}, readonly(), () => api("/.well-known/assetfare-manifest.json"));
  addTool(server, "assetfare_v2_capabilities", V2_CAPABILITIES_DESCRIPTION, emptyStrictInput, readonly(), async () => parseV2Capabilities(await v2Api("/v2/capabilities", { timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true })));
  addTool(server, "assetfare_v2_quote", V2_QUOTE_DESCRIPTION, v2QuoteIntent, quoteOnly(), async (args) => {
    const intent = parseV2Intent(args);
    const quote = parseV2Quote(await v2Api("/v2/quote", { method: "POST", body: intent, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true }), intent);
    // The upstream caller_action_plan_handoff (passed through verbatim above) documents the
    // REST endpoints; guidance points callers at the explicit MCP tools that operate them.
    const executionHandoff = { execution_ready: true, note: "AssetFare never signs or submits. Requires explicit caller_approved:true and the caller's public wallet addresses. Never auto-call these from a quote.", mcp_tools: { one_shot_prepare: "assetfare_v2_prepare", new_session_capability: "assetfare_v2_new_session_capability", session_create: "assetfare_v2_session_create", session_get: "assetfare_v2_session_get", observe_source: "assetfare_v2_session_observe_source", observe_output: "assetfare_v2_session_observe_output", refresh_action: "assetfare_v2_session_refresh_action" }, rest_endpoints: { prepare: V2_PREPARE_URL, session: V2_SESSION_URL } };
    return { ...quote, guidance: { legacyWorkflowCompatible: false, walletAuthenticationPerformed: false, sessionCreated: false, actionPrepared: false, transactionSigned: false, transactionSubmitted: false, compareWithOtherRoutes: true, requoteBeforeSelection: true, caller_action_plan: executionHandoff } };
  });
  addTool(server, "assetfare_v2_new_session_capability", V2_NEW_SESSION_CAPABILITY_DESCRIPTION, emptyStrictInput, { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false }, async () => generateSessionCapability());
  addTool(server, "assetfare_v2_prepare", V2_PREPARE_DESCRIPTION, v2PrepareFields, stateful(false), async (args) => {
    const intent = v2PrepareIntent.parse(args);
    rejectSecretMaterial(intent);
    assertExecutableRoute(intent.from_chain, intent.from_token, intent.to_chain, intent.to_token);
    const body = { caller_approved: true, from_chain: intent.from_chain, from_token: intent.from_token, to_chain: intent.to_chain, to_token: intent.to_token, amount_usd: intent.amount_usd, wallets: intent.wallets, ...(intent.event_signer_public ? { event_signer_public: intent.event_signer_public } : {}) };
    const bundle = parseV2Bundle(await v2Api("/v2/prepare", { method: "POST", body, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true }));
    return { ...bundle, guidance: { freshRequoted: true, callerApprovalHonored: true, actionPrepared: true, transactionSigned: false, transactionSubmitted: false, callerMustVerifySignAndSubmit: true } };
  });
  addTool(server, "assetfare_v2_session_create", V2_SESSION_CREATE_DESCRIPTION, { ...v2PrepareFields, session_token: v2SessionToken, idempotency_key: idempotencyKey }, stateful(true), async (args) => {
    const intent = v2SessionCreateIntent.parse(args);
    rejectSecretMaterial({ ...intent, session_token: undefined });
    assertExecutableRoute(intent.from_chain, intent.from_token, intent.to_chain, intent.to_token);
    const body = { caller_approved: true, from_chain: intent.from_chain, from_token: intent.from_token, to_chain: intent.to_chain, to_token: intent.to_token, amount_usd: intent.amount_usd, wallets: intent.wallets, idempotency_key: intent.idempotency_key, ...(intent.event_signer_public ? { event_signer_public: intent.event_signer_public } : {}) };
    return parseV2Session(await v2Api("/v2/session", { method: "POST", body, extraHeaders: { [V2_SESSION_TOKEN_HEADER]: intent.session_token }, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true }));
  });
  addTool(server, "assetfare_v2_session_get", V2_SESSION_GET_DESCRIPTION, { session_token: v2SessionToken, session_id: sessionId }, readonly(), async ({ session_token, session_id }) => parseV2Session(await v2Api(`/v2/session/${session_id}`, { extraHeaders: { [V2_SESSION_TOKEN_HEADER]: session_token }, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true })));
  addTool(server, "assetfare_v2_session_observe_source", V2_SESSION_OBSERVE_SOURCE_DESCRIPTION, { session_token: v2SessionToken, session_id: sessionId, idempotency_key: idempotencyKey, transaction_hashes: z.array(z.string().min(16).max(128)).min(1).max(8) }, stateful(true), async ({ session_token, session_id, idempotency_key, transaction_hashes }) => parseV2Session(await v2Api(`/v2/session/${session_id}/observe-source`, { method: "POST", body: { idempotency_key, transaction_hashes }, extraHeaders: { [V2_SESSION_TOKEN_HEADER]: session_token }, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true })));
  addTool(server, "assetfare_v2_session_observe_output", V2_SESSION_OBSERVE_OUTPUT_DESCRIPTION, { session_token: v2SessionToken, session_id: sessionId, idempotency_key: idempotencyKey, transaction_hash: z.string().min(16).max(128).optional() }, stateful(true), async ({ session_token, session_id, idempotency_key, transaction_hash }) => parseV2Session(await v2Api(`/v2/session/${session_id}/observe-output`, { method: "POST", body: { idempotency_key, ...(transaction_hash ? { transaction_hash } : {}) }, extraHeaders: { [V2_SESSION_TOKEN_HEADER]: session_token }, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true })));
  addTool(server, "assetfare_v2_session_refresh_action", V2_SESSION_REFRESH_ACTION_DESCRIPTION, { session_token: v2SessionToken, session_id: sessionId, idempotency_key: idempotencyKey }, stateful(true), async ({ session_token, session_id, idempotency_key }) => parseV2Session(await v2Api(`/v2/session/${session_id}/refresh-action`, { method: "POST", body: { idempotency_key }, extraHeaders: { [V2_SESSION_TOKEN_HEADER]: session_token }, timeoutMs: V2_TIMEOUT_MS, maximumBytes: V2_MAX_RESPONSE_BYTES, rejectRedirects: true, sanitizeErrors: true })));
  addTool(server, "assetfare_quote", LEGACY_QUOTE_DESCRIPTION, { amount_usd: z.number().int().min(1).max(1000), destination_chain: z.enum(["base", "arbitrum"]).default("base") }, readonly(), ({ amount_usd, destination_chain }) => api("/v1/quote", { method: "POST", body: { from_chain: "solana", from_token: "SOL", to_chain: destination_chain, to_token: "ETH", amount_usd } }));

  addTool(server, "assetfare_start_wallet_auth", "Create a non-transactional Solana signMessage challenge. Requires caller approval because it creates a short-lived login challenge; it cannot move funds.", { source_wallet: sourceWallet }, stateful(false), ({ source_wallet }) => api("/v1/auth/challenge", { method: "POST", body: { source_wallet } }));
  addTool(server, "assetfare_finish_wallet_auth", "Verify a wallet signature over the exact challenge message and return a wallet-bound access token. Requires caller approval; the returned token is sensitive.", { challenge_id: z.string().uuid(), source_wallet: sourceWallet, signature: z.string().min(64).max(128), terms_version: z.string().min(1).max(160) }, stateful(false), (args) => api("/v1/auth/verify", { method: "POST", body: args }));

  addTool(server, "assetfare_create_session", "Lock a fresh quote into a wallet-bound execution session. This creates no transaction, but reserves the caller's one active session slot.", { access_token: accessToken, quote_id: z.string().uuid(), idempotency_key: idempotencyKey, source_wallet: sourceWallet, destination_wallet: destinationWallet }, stateful(true), ({ access_token, ...body }) => api("/v1/session", { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_read_session", "Read a wallet-bound session, workflow, receipt, or current unsigned action. Read-only.", { access_token: accessToken, session_id: sessionId, view: z.enum(["session", "workflow", "receipt", "next_action"]).default("session") }, readonly(), ({ access_token, session_id, view }) => api(`/v1/session/${session_id}${view === "session" ? "" : `/${view === "next_action" ? "next-action" : view}`}`, { token: access_token }));
  addTool(server, "assetfare_prepare_source_action", "Prepare a bounded unsigned Solana source action. Requires caller approval; it never signs or submits.", { access_token: accessToken, session_id: sessionId }, stateful(true), ({ access_token, session_id }) => api(`/v1/session/${session_id}/prepare-source-action`, { method: "POST", token: access_token, body: {} }));
  addTool(server, "assetfare_verify_source_receipt", "Verify a caller-submitted finalized Solana source signature and advance the workflow. Requires caller approval; it never submits a transaction.", { access_token: accessToken, session_id: sessionId, signature: z.string().min(64).max(128), idempotency_key: idempotencyKey }, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/verify-source`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_prepare_cctp_action", "Prepare an unsigned CCTP burn action using a caller-generated event signer public key. Requires caller approval; it never signs or submits.", { access_token: accessToken, session_id: sessionId, event_signer_public: sourceWallet, idempotency_key: idempotencyKey }, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/prepare-cctp-action`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_observe_cctp", "Verify Circle attestation and the forwarded Base or Arbitrum USDC mint for an already-submitted burn. Read-only on chain, but advances the session record.", { access_token: accessToken, session_id: sessionId, burn_signature: z.string().min(64).max(128), idempotency_key: idempotencyKey }, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/observe-cctp`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_prepare_destination_action", "Prepare the exact-cap permit and unsigned ERC-4337 destination settlement plan. Requires caller approval; it never signs or submits.", { access_token: accessToken, session_id: sessionId, idempotency_key: idempotencyKey }, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/prepare-destination-action`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_observe_destination", "Verify an already-submitted destination UserOperation receipt and finalize the workflow. Requires caller approval; it never submits a transaction.", { access_token: accessToken, session_id: sessionId, transaction_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), idempotency_key: idempotencyKey }, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/observe-destination`, { method: "POST", token: access_token, body }));

  server.registerResource("assetfare-trust-manifest", "assetfare://trust/manifest", { description: "Current signed AssetFare trust manifest." }, async () => ({ contents: [{ uri: "assetfare://trust/manifest", mimeType: "application/json", text: JSON.stringify(await api("/.well-known/assetfare-manifest.json"), null, 2) }] }));
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
  app.get("/.well-known/mcp/server-card.json", (_req, res) => res.status(200).type("application/json").json(serverCard()));
  app.head("/mcp", (req, res) => {
    if (!allowedOrigin(req.get("origin"))) return res.status(403).end();
    return res.set("allow", "GET, HEAD, POST, OPTIONS").set("cache-control", "no-store").status(200).end();
  });
  app.all("/mcp", async (req, res) => {
    if (!allowedOrigin(req.get("origin"))) return res.status(403).json({ error: "mcp_origin_not_allowed" });
    try {
      const server = createServer(provenanceFromHeaders(req.headers));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => transport.close().catch(() => {}));
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (_error) {
      if (!res.headersSent) res.status(500).json({ error: "assetfare_mcp_internal_error" });
    }
  });
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
  if (process.env.ASSETFARE_MCP_TRANSPORT === "stdio") {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    return;
  }
  await serveHttp();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => process.exit(1));

export { V2_API_BASE, V2_MAX_RESPONSE_BYTES, V2_TIMEOUT_MS, a2aVersionGuard, allowedHost, createHttpApp, createServer, normalizeA2AVersion, provenanceFromHeaders, serverCard };
