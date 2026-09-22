// Read-only A2A v1 quote adapter. It never authenticates a wallet, creates an
// AssetFare session, prepares an action, signs, approves, funds, or submits.

import { isIP } from "node:net";
import { randomBytes } from "node:crypto";
import {
  A2A_CONTENT_TYPE,
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  canonicalizeAgentCard,
  Role,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { z } from "zod";

const MAX_BYTES = 1_048_576;
const FETCH_TIMEOUT_MS = 45_000;
const TOKENS_BY_CHAIN = {
  solana: ["SOL", "USDC", "USDG"],
  base: ["ETH", "USDC"],
  arbitrum: ["ETH", "USDC"],
  robinhood: ["ETH", "USDG"],
  polygon: ["USDC"],
  optimism: ["USDC"],
};
const ENDPOINTS = new Set(Object.entries(TOKENS_BY_CHAIN).flatMap(([chain,tokens]) => tokens.map((token) => `${chain}:${token}`)));
const SOURCE_ONLY_CHAINS = new Set(["polygon", "optimism"]);
const PREPARE_URL = "https://api.assetfare.dev/v2/prepare";
const SESSION_URL = "https://api.assetfare.dev/v2/session";
const HANDOFF_REQUEST_FIELDS = ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets", "event_signer_public"];
const FEE_COLLECTION_CONST = "only_on_eligible_successful_executor_step";
const SESSION_TOKEN_HEADER = "x-assetfare-session-token";

const SourceChain = z.enum(["solana", "base", "arbitrum", "robinhood", "polygon", "optimism"]);
const DestinationChain = z.enum(["solana", "base", "arbitrum", "robinhood"]);
const Token = z.enum(["SOL", "ETH", "USDC", "USDG"]);
const SessionToken = z.string().regex(/^[A-Za-z0-9_-]{43,128}$/);
const PublicAddress = z.string().refine((value) => /^0x[0-9a-fA-F]{40}$/.test(value) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value), "not a public address");
const WalletMap = z.record(SourceChain, PublicAddress);
const IdempotencyKey = z.string().min(8).max(128);
const SessionId = z.string().uuid();
const QuoteIntent = z.object({
  fromChain: SourceChain,
  fromToken: Token,
  toChain: DestinationChain,
  toToken: Token,
  amountUsd: z.number().finite().min(1).max(1000),
}).strict().superRefine((value, context) => {
  if (!TOKENS_BY_CHAIN[value.fromChain].includes(value.fromToken)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["fromToken"], message: "unsupported source token" });
  if (!TOKENS_BY_CHAIN[value.toChain].includes(value.toToken)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toToken"], message: "unsupported destination token" });
  if (value.fromChain === value.toChain && value.fromToken === value.toToken) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toToken"], message: "identity route" });
  if (SOURCE_ONLY_CHAINS.has(value.fromChain) && !(value.fromToken === "USDC" && ["base", "arbitrum"].includes(value.toChain) && value.toToken === "USDC")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toChain"], message: "unsupported source-only route" });
});

const PrepareIntent = z.object({
  callerApproved: z.literal(true),
  fromChain: SourceChain,
  fromToken: Token,
  toChain: DestinationChain,
  toToken: Token,
  amountUsd: z.number().finite().min(1).max(1000),
  wallets: WalletMap,
  eventSignerPublic: PublicAddress.optional(),
}).strict();
const SessionCreateIntent = PrepareIntent.extend({ sessionToken: SessionToken, idempotencyKey: IdempotencyKey }).strict();
const SessionReadIntent = z.object({ sessionToken: SessionToken, sessionId: SessionId }).strict();
const ObserveSourceIntent = z.object({ sessionToken: SessionToken, sessionId: SessionId, idempotencyKey: IdempotencyKey, transactionHashes: z.array(z.string().min(16).max(128)).min(1).max(8) }).strict();
const ObserveOutputIntent = z.object({ sessionToken: SessionToken, sessionId: SessionId, idempotencyKey: IdempotencyKey, transactionHash: z.string().min(16).max(128).optional() }).strict();
const RefreshActionIntent = z.object({ sessionToken: SessionToken, sessionId: SessionId, idempotencyKey: IdempotencyKey }).strict();

const Capabilities = z.object({ status: z.literal("capped_public_agent_release"), public_api_enabled: z.literal(true), chains: z.array(SourceChain).length(6), asset_endpoints: z.array(z.object({chain:SourceChain,token:Token}).passthrough()).length(11),source_only_asset_endpoints:z.array(z.object({chain:z.enum(["polygon","optimism"]),token:z.literal("USDC")}).passthrough()).length(2),source_only_routes:z.array(z.enum(["polygon:USDC->base:USDC","polygon:USDC->arbitrum:USDC","optimism:USDC->base:USDC","optimism:USDC->arbitrum:USDC"])).length(4), directed_conversion_routes:z.literal(76), unsigned_route_plans_ready:z.literal(76), execution_ready_routes:z.literal(76), execution_implemented_routes:z.literal(76).optional(), currently_prepare_ready_routes:z.number().int().min(0).max(76).optional(), temporarily_unavailable_routes:z.array(z.string().min(1)).max(76).optional(), temporarily_unavailable_route_count:z.number().int().min(0).max(76).optional(), execution_availability:z.object({status:z.enum(["available","degraded","unknown"]),provider:z.literal("circle_iris"),guarantees_future_availability:z.literal(false)}).passthrough().optional(), phase_b_blocked_routes:z.literal(0), blocked_source_only_routes:z.array(z.never()).length(0), server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough();
const Status = z.object({ status: z.literal("capped_public_agent_release"), server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough();
const Quote = z.object({
  status: z.literal("capped_public_agent_release"),
  intent: z.object({from:z.string(),to:z.string(),amount_usd:z.number().finite(),estimated_input_base:z.number().int().positive()}).passthrough(),
  execution: z.object({ supported: z.boolean(), first_unsigned_action_supported: z.boolean() }).passthrough(),
  risk: z.object({ server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough(),
  offer: z.object({expected_receive_amount:z.number().finite().positive(),estimated_min_receive_amount:z.number().finite().positive(),expected_receive_usd:z.number().finite().nonnegative(),estimated_min_receive_usd:z.number().finite().nonnegative(),output_symbol:Token,estimated_time_seconds:z.number().int().positive().nullable(),assetfare_fee_bps:z.literal(1),fee_modeled_bps:z.literal(1),fee_collectible_now:z.literal(true),fee_collection_steps:z.array(z.number().int().nonnegative()).length(1),fee_collection:z.literal(FEE_COLLECTION_CONST)}).passthrough(),
  cost_summary:z.object({scope:z.literal("token_path_only_network_gas_excluded"),input_value_usd:z.number().finite().nonnegative(),expected_receive_value_usd:z.number().finite().nonnegative(),minimum_receive_value_usd:z.number().finite().nonnegative(),expected_total_cost_usd:z.number().finite().nonnegative(),maximum_total_cost_usd:z.number().finite().nonnegative(),assetfare_service_fee:z.object({bps:z.literal(1)}).passthrough(),rankable_all_in:z.literal(false),small_amount_warning:z.boolean()}).passthrough().optional(),
  eta:z.object({estimated_time_seconds:z.number().int().positive().nullable(),complete_route_estimate:z.boolean()}).passthrough().optional(),
  route:z.object({route:z.string(),steps:z.array(z.record(z.unknown())).min(1),server_signing:z.literal(false),server_submission:z.literal(false)}).passthrough(),
  caller_action_plan_handoff:z.object({}).passthrough(),
}).passthrough();

const Bundle = z.object({ unsigned_action: z.object({}).passthrough(), server_signing: z.literal(false), server_submission: z.literal(false), signed: z.literal(false), submitted: z.literal(false) }).passthrough();
const Session = z.object({ session_id: z.string().min(1), server_signing: z.literal(false), server_submission: z.literal(false), signed: z.literal(false), submitted: z.literal(false) }).passthrough();

function deepEqualArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((item, index) => item === expected[index]);
}

// EXACT key-set equality: rejects BOTH missing and extra keys.
function exactKeys(object, keys) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return false;
  return Object.keys(object).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(object, key));
}

// Fail-closed passthrough of the upstream caller_action_plan_handoff (no local fallback).
function validateHandoff(handoff) {
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) throw new Error("assetfare_safety_boundary_failed");
  if (handoff.kind !== "caller_operated_rest_prepare" || handoff.method !== "POST") throw new Error("assetfare_safety_boundary_failed");
  if (!deepEqualArray(handoff.request_fields, HANDOFF_REQUEST_FIELDS)) throw new Error("assetfare_safety_boundary_failed");
  if (handoff.requires_explicit_caller_approval !== true || handoff.requires_public_wallet_addresses !== true || handoff.assetfare_server_signing !== false || handoff.assetfare_server_submission !== false || handoff.caller_must_verify_sign_and_submit !== true || handoff.requires_fresh_requote !== true || handoff.automatic_prepare_call_forbidden !== true) throw new Error("assetfare_safety_boundary_failed");
  if (typeof handoff.note !== "string" || !handoff.note.length) throw new Error("assetfare_safety_boundary_failed");
  // v1 stays the UNCHANGED old exact allow-list (backward compatible). Machine contract is the v2 sibling below.
  const allowed = new Set(["kind", "url", "method", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "request_fields", "assetfare_server_signing", "assetfare_server_submission", "caller_must_verify_sign_and_submit", "requires_fresh_requote", "automatic_prepare_call_forbidden", "options", "note", "available", "blocker"]);
  for (const key of Object.keys(handoff)) if (!allowed.has(key)) throw new Error("assetfare_safety_boundary_failed");
  if (handoff.available !== true || handoff.url !== PREPARE_URL || !Array.isArray(handoff.options) || handoff.options.length !== 2) throw new Error("assetfare_safety_boundary_failed");
  const [prepareOption, sessionOption] = handoff.options;
  if (!prepareOption || prepareOption.kind !== "one_shot_first_unsigned_bundle" || prepareOption.url !== PREPARE_URL || prepareOption.requires_explicit_caller_approval !== true || prepareOption.assetfare_never_signs_submits_or_auto_calls !== true) throw new Error("assetfare_safety_boundary_failed");
  if (!sessionOption || sessionOption.kind !== "caller_approved_full_workflow_session" || sessionOption.url !== SESSION_URL || sessionOption.requires_explicit_caller_approval !== true || sessionOption.assetfare_never_signs_submits_or_auto_calls !== true) throw new Error("assetfare_safety_boundary_failed");
  const lifecycle = sessionOption.lifecycle_urls;
  if (!lifecycle || lifecycle.create?.url !== SESSION_URL || lifecycle.read?.url !== `${SESSION_URL}/{session_id}` || lifecycle.observe_source?.url !== `${SESSION_URL}/{session_id}/observe-source` || lifecycle.observe_output?.url !== `${SESSION_URL}/{session_id}/observe-output` || lifecycle.refresh_action?.url !== `${SESSION_URL}/{session_id}/refresh-action`) throw new Error("assetfare_safety_boundary_failed");
  return handoff;
}

// Optional versioned SIBLING: validated EXACTLY when present. Advisory machine contract with per-kind exact option keys.
function validateHandoffV2(handoff) {
  // Called ONLY when the sibling key is present; a present-but-null/array sibling is rejected.
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) throw new Error("assetfare_safety_boundary_failed");
  if (!deepEqualArray(handoff.request_fields, HANDOFF_REQUEST_FIELDS)) throw new Error("assetfare_safety_boundary_failed");
  const scalars = [["schema_version", 2], ["kind", "caller_operated_rest_prepare"], ["method", "POST"], ["requires_explicit_caller_approval", true], ["requires_public_wallet_addresses", true], ["assetfare_server_signing", false], ["assetfare_server_submission", false], ["caller_must_verify_sign_and_submit", true], ["requires_fresh_requote", true], ["automatic_prepare_call_forbidden", true], ["selection", "choose_exactly_one"], ["mutually_exclusive", true], ["do_not_call_both", true], ["selection_before_signing", true], ["once_any_action_submitted_do_not_start_other_mode", true], ["enforcement", "advisory_caller_side"], ["available", true], ["url", PREPARE_URL]];
  for (const [k, v] of scalars) if (handoff[k] !== v) throw new Error("assetfare_safety_boundary_failed");
  if (typeof handoff.note !== "string" || !handoff.note.length) throw new Error("assetfare_safety_boundary_failed");
  // v2 is ALWAYS the available=true machine contract: EXACT key set (no blocker) — reject missing AND extra.
  const topRequired = ["kind", "url", "method", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "request_fields", "assetfare_server_signing", "assetfare_server_submission", "caller_must_verify_sign_and_submit", "requires_fresh_requote", "automatic_prepare_call_forbidden", "schema_version", "selection", "mutually_exclusive", "do_not_call_both", "selection_before_signing", "once_any_action_submitted_do_not_start_other_mode", "enforcement", "options", "note", "available"];
  if (!exactKeys(handoff, topRequired)) throw new Error("assetfare_safety_boundary_failed");
  if (!Array.isArray(handoff.options) || handoff.options.length !== 2) throw new Error("assetfare_safety_boundary_failed");
  const [prepareOption, sessionOption] = handoff.options;
  const prepKeys = ["kind", "method", "url", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "assetfare_never_signs_submits_or_auto_calls", "preview_or_manual_first_action_only", "not_a_session", "do_not_start_session_after_submission", "note"];
  if (!exactKeys(prepareOption, prepKeys) || prepareOption.kind !== "one_shot_first_unsigned_bundle" || prepareOption.method !== "POST" || prepareOption.url !== PREPARE_URL || prepareOption.requires_explicit_caller_approval !== true || prepareOption.requires_public_wallet_addresses !== true || prepareOption.assetfare_never_signs_submits_or_auto_calls !== true || prepareOption.preview_or_manual_first_action_only !== true || prepareOption.not_a_session !== true || prepareOption.do_not_start_session_after_submission !== true || typeof prepareOption.note !== "string" || !prepareOption.note.length) throw new Error("assetfare_safety_boundary_failed");
  const sessKeys = ["kind", "method", "url", "lifecycle_urls", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "assetfare_never_signs_submits_or_auto_calls", "recommended_for_multistep", "note"];
  if (!exactKeys(sessionOption, sessKeys) || sessionOption.kind !== "caller_approved_full_workflow_session" || sessionOption.method !== "POST" || sessionOption.url !== SESSION_URL || sessionOption.requires_explicit_caller_approval !== true || sessionOption.requires_public_wallet_addresses !== true || sessionOption.assetfare_never_signs_submits_or_auto_calls !== true || sessionOption.recommended_for_multistep !== true || typeof sessionOption.note !== "string" || !sessionOption.note.length) throw new Error("assetfare_safety_boundary_failed");
  const lifecycle = sessionOption.lifecycle_urls;
  if (!exactKeys(lifecycle, ["create", "read", "observe_source", "observe_output", "refresh_action"])) throw new Error("assetfare_safety_boundary_failed");
  const expectedLifecycle = [["create", "POST", SESSION_URL], ["read", "GET", `${SESSION_URL}/{session_id}`], ["observe_source", "POST", `${SESSION_URL}/{session_id}/observe-source`], ["observe_output", "POST", `${SESSION_URL}/{session_id}/observe-output`], ["refresh_action", "POST", `${SESSION_URL}/{session_id}/refresh-action`]];
  for (const [name, method, url] of expectedLifecycle) { const entry = lifecycle[name]; if (!exactKeys(entry, ["method", "url"]) || entry.method !== method || entry.url !== url) throw new Error("assetfare_safety_boundary_failed"); }
  return handoff;
}

function validateFee(offer, stepCount) {
  if (offer.assetfare_fee_bps !== 1 || offer.fee_modeled_bps !== 1 || offer.fee_collectible_now !== true) throw new Error("assetfare_safety_boundary_failed");
  const steps = offer.fee_collection_steps;
  if (steps.some((index) => !Number.isInteger(index) || index < 0 || index >= stepCount) || new Set(steps).size !== steps.length) throw new Error("assetfare_safety_boundary_failed");
  if (steps.length !== 1) throw new Error("assetfare_safety_boundary_failed");
}

function rejectSecretMaterial(value) {
  const forbidden = new Set(["private_key", "privatekey", "privkey", "secret_key", "secretkey", "seed", "seed_phrase", "mnemonic", "keypair", "secret", "signature", "signed_transaction", "signed_tx", "raw_transaction", "signed", "password", "passphrase"]);
  const stack = [[value, 0]]; let seen = 0;
  while (stack.length) { const [node, depth] = stack.pop(); seen += 1; if (seen > 512 || depth > 12) throw new Error("assetfare_safety_boundary_failed"); if (Array.isArray(node)) { for (const child of node) stack.push([child, depth + 1]); continue; } if (node && typeof node === "object") { for (const key of Object.keys(node)) if (forbidden.has(String(key).toLowerCase())) throw new Error("assetfare_secret_material_rejected"); for (const child of Object.values(node)) stack.push([child, depth + 1]); } }
}

function validateCapabilities(payload) {
  rejectSigningClaims(payload);
  const value=Capabilities.parse(payload),chains=new Set(value.chains),endpoints=new Set(value.asset_endpoints.map((item)=>`${item.chain}:${item.token}`));
  if(chains.size!==6||Object.keys(TOKENS_BY_CHAIN).some((chain)=>!chains.has(chain))||endpoints.size!==ENDPOINTS.size||[...ENDPOINTS].some((endpoint)=>!endpoints.has(endpoint)))throw new Error("assetfare_safety_boundary_failed");
  if(new Set(value.source_only_routes).size!==4)throw new Error("assetfare_safety_boundary_failed");
  const availabilityKeys=["execution_implemented_routes","currently_prepare_ready_routes","temporarily_unavailable_routes","temporarily_unavailable_route_count","execution_availability"],present=availabilityKeys.filter((key)=>Object.prototype.hasOwnProperty.call(value,key));
  if(present.length!==0&&present.length!==availabilityKeys.length)throw new Error("assetfare_safety_boundary_failed");
  if(present.length===availabilityKeys.length&&(value.temporarily_unavailable_route_count!==value.temporarily_unavailable_routes.length||value.currently_prepare_ready_routes!==value.execution_implemented_routes-value.temporarily_unavailable_route_count))throw new Error("assetfare_safety_boundary_failed");
  return value;
}

function validateQuote(payload,intent) {
  rejectSigningClaims(payload);
  const value=Quote.parse(payload),source=`${intent.fromChain}:${intent.fromToken}`,destination=`${intent.toChain}:${intent.toToken}`;
  if(value.intent.from!==source||value.intent.to!==destination||value.intent.amount_usd!==intent.amountUsd||value.offer.output_symbol!==intent.toToken||value.offer.estimated_min_receive_amount>value.offer.expected_receive_amount||value.route.route!==`${source}->${destination}`)throw new Error("assetfare_safety_boundary_failed");
  if(value.cost_summary&&(value.cost_summary.input_value_usd!==intent.amountUsd||value.cost_summary.expected_receive_value_usd!==value.offer.expected_receive_usd||value.cost_summary.minimum_receive_value_usd!==value.offer.estimated_min_receive_usd||value.cost_summary.maximum_total_cost_usd<value.cost_summary.expected_total_cost_usd||value.cost_summary.assetfare_service_fee.bps!==1))throw new Error("assetfare_safety_boundary_failed");
  if(value.eta&&value.eta.estimated_time_seconds!==value.offer.estimated_time_seconds)throw new Error("assetfare_safety_boundary_failed");
  if(value.execution.supported!==true||value.execution.first_unsigned_action_supported!==true||("blocker" in value.execution&&value.execution.blocker!==null))throw new Error("assetfare_safety_boundary_failed");
  validateFee(value.offer,value.route.steps.length);
  validateHandoff(value.caller_action_plan_handoff);
  const hasVersion = Object.prototype.hasOwnProperty.call(value, "handoff_schema_version");
  const hasSibling = Object.prototype.hasOwnProperty.call(value, "caller_action_plan_handoff_v2");
  if (hasVersion !== hasSibling) throw new Error("assetfare_safety_boundary_failed");
  if (hasSibling) {
    if (value.handoff_schema_version !== 2) throw new Error("assetfare_safety_boundary_failed");
    validateHandoffV2(value.caller_action_plan_handoff_v2);
  }
  return value;
}

function validateBundle(payload) { rejectSigningClaims(payload); return Bundle.parse(payload); }
function validateSession(payload) { rejectSigningClaims(payload); return Session.parse(payload); }
function assertExecutableRoute(fromChain, fromToken, toChain, toToken) {
  const source = `${fromChain}:${fromToken}`, destination = `${toChain}:${toToken}`;
  if (!ENDPOINTS.has(source) || !ENDPOINTS.has(destination)) throw new Error("assetfare_route_unsupported");
  if (source === destination) throw new Error("assetfare_identity_route");
  if (SOURCE_ONLY_CHAINS.has(fromChain) && !(fromToken === "USDC" && ["base", "arbitrum"].includes(toChain) && toToken === "USDC")) throw new Error("assetfare_route_unsupported");
}
function newSessionCapability() {
  const token = randomBytes(32).toString("base64url");
  return { session_token: token, token_bits: 256, token_length: token.length, sensitivity: "sensitive_capability", is_private_key: false, usage: "Send as sessionToken to session_create and every session read/observe/refresh; delivered in the X-AssetFare-Session-Token header. The server stores only its hash. Never a private key.", server_signing: false, server_submission: false };
}

function rejectSigningClaims(value) {
  const stack=[[value,0]];let seen=0;
  while(stack.length){const [node,depth]=stack.pop();seen+=1;if(seen>512||depth>12)throw new Error("assetfare_safety_boundary_failed");if(Array.isArray(node)){for(const child of node)stack.push([child,depth+1]);continue;}if(node&&typeof node==="object"){for(const key of ["server_signing","server_submission"])if(key in node&&node[key]!==false)throw new Error("assetfare_safety_boundary_failed");for(const child of Object.values(node))stack.push([child,depth+1]);}}
}

function provenance(headers = {}) {
  const raw = headers["x-forwarded-for"];
  const forwarded = Array.isArray(raw) ? "" : String(raw || "").trim();
  const userRaw = headers["user-agent"];
  const userAgent = (Array.isArray(userRaw) ? userRaw[0] : String(userRaw || "")).slice(0, 512);
  return { requestIdentity: forwarded && !forwarded.includes(",") && isIP(forwarded) ? forwarded : "", userAgent };
}

function requester(config, headers) {
  const apiBaseUrl = (config.apiBaseUrl || "https://api.assetfare.dev").replace(/\/$/, "");
  const fetchFn = config.fetch || fetch;
  const source = provenance(headers);
  return async (path, init = {}) => {
    const requestHeaders = new Headers(init.headers || {});
    requestHeaders.set("accept", "application/json");
    requestHeaders.set("x-assetfare-channel", "a2a");
    if (init.body) requestHeaders.set("content-type", "application/json");
    if (source.requestIdentity) requestHeaders.set("x-forwarded-for", source.requestIdentity);
    if (source.userAgent) requestHeaders.set("user-agent", source.userAgent);
    let response;
    try {
      response = await fetchFn(apiBaseUrl + path, { ...init, headers: requestHeaders, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      throw new Error("assetfare_upstream_unavailable");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("assetfare_response_too_large");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("assetfare_response_too_large");
    let body;
    try {
      body = JSON.parse(text);
      if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("shape");
    } catch {
      throw new Error("assetfare_response_invalid");
    }
    if (!response.ok) throw new Error("assetfare_upstream_status_error");
    return body;
  };
}

export function assetFareAgentCard(serviceUrl = "https://api.assetfare.dev/a2a") {
  if (!serviceUrl.startsWith("https://")) throw new Error("A2A service url must be https");
  const card = {
    name: "AssetFare Route Quotes",
    description: "AssetFare is a non-custodial, agent-native cross-chain route service: six chains, eleven source endpoints, 76 directed bridge and cross-chain swap routes. AssetFare service fee 1bp; Circle/provider/network fees additional; each quote exposes total token-path cost and live availability. Solana SOL to Base USDC, Solana USDC to Base USDC, and Optimism USDC to Base USDC are explicitly supported. Get a quote and, only after caller approval, an unsigned action the caller signs; the server never signs or submits. MCP, A2A, and OpenAPI are available.",
    supportedInterfaces: [{ url: serviceUrl, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "AssetFare", url: "https://assetfare.dev" },
    version: "0.1.5",
    documentationUrl: "https://assetfare.dev/llms-full.txt",
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{
      id: "quote-cross-chain-route",
      name: "Quote a cross-chain route",
      description: "Return one fresh quote for eleven source endpoints and 76 routes from USD 1 through 1,000, with total token-path cost and live availability (AssetFare service fee 1bp; Circle/provider/network fees additional). Explicit examples include Solana SOL to Base USDC and Optimism USDC to Base USDC. Polygon and Optimism are native-USDC source-only origins to Base or Arbitrum. Stop before authentication, preparation, signing, or submission; the quote only passes through the caller-approved unsigned-action handoff.",
      tags: ["cross-chain", "bridge", "swap", "crypto", "quote", "solana", "base", "arbitrum", "robinhood", "polygon", "optimism", "non-custodial"],
      examples: ['{"fromChain":"solana","fromToken":"SOL","toChain":"base","toToken":"USDC","amountUsd":1}', '{"fromChain":"optimism","fromToken":"USDC","toChain":"base","toToken":"USDC","amountUsd":10}', '{"fromChain":"polygon","fromToken":"USDC","toChain":"arbitrum","toToken":"USDC","amountUsd":10}'],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      securityRequirements: [],
    }, {
      id: "new-session-capability",
      name: "Generate a session capability token",
      description: "Locally generate one caller-owned high-entropy session capability token (>=256-bit CSPRNG, url-safe). No network call. Send {\"operation\":\"new_session_capability\"}. The token is a SENSITIVE capability credential (never a private key); store it and pass it as sessionToken to session_create and every session read/observe/refresh.",
      tags: ["session", "capability-token", "non-custodial", "security"],
      examples: ['{"operation":"new_session_capability"}'],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      securityRequirements: [],
    }, {
      id: "prepare-first-unsigned-action",
      name: "Prepare the first unsigned action (caller-approved)",
      description: "Caller-approved one-shot POST /v2/prepare for any supported route: returns the fresh re-quoted bounded first unsigned action bundle. Send {\"operation\":\"prepare\",\"callerApproved\":true, fromChain, fromToken, toChain, toToken, amountUsd, wallets:{chain:publicAddress}, eventSignerPublic?}. Requires an explicit callerApproved:true; rejects any private key/seed/signed transaction. Never auto-called from a quote. AssetFare never signs or submits.",
      tags: ["prepare", "unsigned-action", "cross-chain", "non-custodial", "caller-approved"],
      examples: ['{"operation":"prepare","callerApproved":true,"fromChain":"base","fromToken":"USDC","toChain":"arbitrum","toToken":"USDC","amountUsd":25,"wallets":{"base":"0x1111111111111111111111111111111111111111","arbitrum":"0x2222222222222222222222222222222222222222"}}'],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      securityRequirements: [],
    }, {
      id: "session-lifecycle",
      name: "Run the caller-approved session lifecycle",
      description: "Full receipt-driven /v2/session lifecycle for a route the live quote reports available. Requires callerApproved:true on create and the caller's session capability token (X-AssetFare-Session-Token) on every call. Operations: session_create (+wallets, idempotencyKey), session_get, observe_source (caller-submitted transactionHashes), observe_output, refresh_action. Never auto-chains, signs, or submits; only the caller's submitted tx hashes are observed.",
      tags: ["session", "lifecycle", "observe", "receipts", "non-custodial", "caller-approved"],
      examples: ['{"operation":"session_create","callerApproved":true,"fromChain":"base","fromToken":"USDC","toChain":"arbitrum","toToken":"USDC","amountUsd":25,"wallets":{"base":"0x1111111111111111111111111111111111111111","arbitrum":"0x2222222222222222222222222222222222222222"},"sessionToken":"<capability>","idempotencyKey":"create-0001"}', '{"operation":"observe_source","sessionId":"00000000-0000-4000-8000-000000000001","sessionToken":"<capability>","idempotencyKey":"src-0001","transactionHashes":["<caller-submitted-hash>"]}'],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      securityRequirements: [],
    }],
    signatures: [],
  };
  canonicalizeAgentCard(card);
  return card;
}

function dataValue(parts) {
  const values = parts.filter((part) => part.content?.$case === "data");
  if (values.length !== 1) throw new Error("quote_intent_required");
  return values[0].content.value;
}

class QuoteExecutor {
  constructor(config) { this.config = config; }
  publish(context,bus,value) {
    bus.publish(AgentEvent.message({
      messageId: `assetfare-${Date.now()}`,
      contextId: context.contextId,
      taskId: "",
      role: Role.ROLE_AGENT,
      parts: [{ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    }));
    bus.finished();
  }
  async execute(context, bus) {
    let value;
    try { value = dataValue(context.userMessage.parts); }
    catch { this.publish(context,bus,{error:{code:"quote_intent_required"}});return; }
    // The operation selects the A2A skill. Absent/quote => the legacy read-only quote flow
    // (backward compatible). Prepare and the session lifecycle mirror the MCP tools exactly.
    const operation = value && typeof value === "object" && typeof value.operation === "string" ? value.operation : "quote";
    const headers = context.context.state.get("headers") || {};
    const request = requester(this.config, headers);
    const known = new Set(["assetfare_upstream_unavailable", "assetfare_response_too_large", "assetfare_response_invalid", "assetfare_upstream_status_error", "assetfare_secret_material_rejected", "assetfare_route_unsupported", "assetfare_identity_route"]);
    const fail = (error) => this.publish(context, bus, { error: { code: error instanceof Error && known.has(error.message) ? error.message : "assetfare_safety_boundary_failed" } });
    // Distinguish a caller-intent parse failure (intent_invalid) from an upstream-response
    // validation failure (safety_boundary_failed): only the former is the caller's fault.
    const withoutOp = (input) => { const { operation: _op, ...rest } = input || {}; return rest; };
    const parseIntent = (schema, input) => { try { return schema.parse(input); } catch { throw Object.assign(new Error("intent_invalid"), { intentInvalid: true }); } };
    try {
      if (operation === "new_session_capability") { this.publish(context, bus, { session_capability: newSessionCapability() }); return; }
      if (operation === "quote") {
        const intent = parseIntent(QuoteIntent, withoutOp(value));
        const [capabilitiesRaw, statusRaw] = await Promise.all([request("/v2/capabilities"), request("/v2/status")]);
        validateCapabilities(capabilitiesRaw); Status.parse(statusRaw);
        const quote = validateQuote(await request("/v2/quote", { method: "POST", body: JSON.stringify({ from_chain: intent.fromChain, from_token: intent.fromToken, to_chain: intent.toChain, to_token: intent.toToken, amount_usd: intent.amountUsd }) }), intent);
        this.publish(context, bus, { quote, guidance: { compareWithOtherRoutes: true, requoteBeforeSelection: true, walletAuthenticationPerformed: false, sessionCreated: false, actionPrepared: false, transactionSigned: false, transactionSubmitted: false } });
        return;
      }
      if (operation === "prepare") {
        const intent = parseIntent(PrepareIntent, withoutOp(value));
        rejectSecretMaterial({ ...intent, operation: undefined });
        assertExecutableRoute(intent.fromChain, intent.fromToken, intent.toChain, intent.toToken);
        const body = { caller_approved: true, from_chain: intent.fromChain, from_token: intent.fromToken, to_chain: intent.toChain, to_token: intent.toToken, amount_usd: intent.amountUsd, wallets: intent.wallets, ...(intent.eventSignerPublic ? { event_signer_public: intent.eventSignerPublic } : {}) };
        const bundle = validateBundle(await request("/v2/prepare", { method: "POST", body: JSON.stringify(body) }));
        this.publish(context, bus, { bundle, guidance: { freshRequoted: true, callerApprovalHonored: true, transactionSigned: false, transactionSubmitted: false, callerMustVerifySignAndSubmit: true } });
        return;
      }
      if (operation === "session_create") {
        const intent = parseIntent(SessionCreateIntent, withoutOp(value));
        rejectSecretMaterial({ ...intent, sessionToken: undefined, operation: undefined });
        assertExecutableRoute(intent.fromChain, intent.fromToken, intent.toChain, intent.toToken);
        const body = { caller_approved: true, from_chain: intent.fromChain, from_token: intent.fromToken, to_chain: intent.toChain, to_token: intent.toToken, amount_usd: intent.amountUsd, wallets: intent.wallets, idempotency_key: intent.idempotencyKey, ...(intent.eventSignerPublic ? { event_signer_public: intent.eventSignerPublic } : {}) };
        this.publish(context, bus, { session: validateSession(await request("/v2/session", { method: "POST", headers: { [SESSION_TOKEN_HEADER]: intent.sessionToken }, body: JSON.stringify(body) })) });
        return;
      }
      if (operation === "session_get") {
        const intent = parseIntent(SessionReadIntent, withoutOp(value));
        this.publish(context, bus, { session: validateSession(await request(`/v2/session/${intent.sessionId}`, { headers: { [SESSION_TOKEN_HEADER]: intent.sessionToken } })) });
        return;
      }
      if (operation === "observe_source") {
        const intent = parseIntent(ObserveSourceIntent, withoutOp(value));
        this.publish(context, bus, { session: validateSession(await request(`/v2/session/${intent.sessionId}/observe-source`, { method: "POST", headers: { [SESSION_TOKEN_HEADER]: intent.sessionToken }, body: JSON.stringify({ idempotency_key: intent.idempotencyKey, transaction_hashes: intent.transactionHashes }) })) });
        return;
      }
      if (operation === "observe_output") {
        const intent = parseIntent(ObserveOutputIntent, withoutOp(value));
        this.publish(context, bus, { session: validateSession(await request(`/v2/session/${intent.sessionId}/observe-output`, { method: "POST", headers: { [SESSION_TOKEN_HEADER]: intent.sessionToken }, body: JSON.stringify({ idempotency_key: intent.idempotencyKey, ...(intent.transactionHash ? { transaction_hash: intent.transactionHash } : {}) }) })) });
        return;
      }
      if (operation === "refresh_action") {
        const intent = parseIntent(RefreshActionIntent, withoutOp(value));
        this.publish(context, bus, { session: validateSession(await request(`/v2/session/${intent.sessionId}/refresh-action`, { method: "POST", headers: { [SESSION_TOKEN_HEADER]: intent.sessionToken }, body: JSON.stringify({ idempotency_key: intent.idempotencyKey }) })) });
        return;
      }
      this.publish(context, bus, { error: { code: "assetfare_operation_unsupported" } });
    } catch (error) {
      if (error?.intentInvalid) { this.publish(context, bus, { error: { code: `${operation}_intent_invalid` } }); return; }
      fail(error);
    }
  }
  async cancelTask(_taskId, bus) { bus.finished(); }
}

export function createAssetFareA2A(config = {}) {
  const card = assetFareAgentCard(config.serviceUrl);
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new QuoteExecutor(config));
  return { card, requestHandler };
}

export { A2A_CONTENT_TYPE, A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, MAX_BYTES };
