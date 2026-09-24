import { createHash } from "node:crypto";
import { z } from "zod";

export const CONTINUATION_V3_VERSION = "assetfare-quote-bound-continuation-v3";
export const APPROVAL_V3_VERSION = "assetfare-quote-bound-approval-v3";
export const QUOTE_FINGERPRINT_SPEC = "sha256(UTF-8 sorted-key compact JSON of quote_fingerprint_claim; every numeric claim is a non-exponent decimal string)";
export const QUOTE_PAYLOAD_SHA256_SPEC = "sha256(AssetFare typed-canonical-v1 bytes of the quote without continuation_v3 after exact base-unit substitution: n=null; t/f=boolean; d=<IEEE-754 binary64 big-endian 16 lowercase hex> for each finite JSON number; s=<UTF-8 byte length>:<Unicode scalar text with lone surrogates forbidden>; a=<count>:[items]; o=<count>:{UTF-8-byte-sorted string-key/value pairs}; every non-substituted integral JSON number must be within +/-9007199254740991; substituted paths are intent.estimated_input_base, route.input_base, route.expected_output_base, route.minimum_output_base, and every route.steps[i].expected_input_base/floor_input_base/expected_output_base/minimum_output_base from direct_route_summary exact decimal strings)";
export const APPROVAL_V3_KEYS = Object.freeze([
  "direct_route_summary_sha256",
  "idempotency_key",
  "maximum_input_base",
  "minimum_output_base",
  "quote_fingerprint",
  "quote_id",
  "selected_mode",
  "selection_status",
  "version",
]);

const HASH = /^[0-9a-f]{64}$/;
const POSITIVE_DECIMAL = /^[1-9][0-9]*$/;
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,128}$/;
const EXACT_BASE_UNITS = /^[1-9][0-9]*$/;
const CHAINS = ["arbitrum", "base", "optimism", "polygon", "robinhood", "solana"];
const MODES = ["one_shot", "session"];
const hash = z.string().regex(HASH);
const positiveDecimal = z.string().regex(POSITIVE_DECIMAL);
const uuid = z.string().uuid();
const dateTime = z.string().datetime({ offset: true });
const chain = z.enum(CHAINS);

const continuationIntentSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  amount_usd: z.number().finite(),
  estimated_input_base: z.number().int().positive(),
}).passthrough();

export const quoteFingerprintClaimSchema = z.object({
  version: z.literal(CONTINUATION_V3_VERSION),
  quote_id: uuid,
  issued_at: dateTime,
  expires_at: dateTime,
  ttl_seconds: positiveDecimal,
  intent: z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    amount_usd_decimal: z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    estimated_input_base: positiveDecimal,
  }).strict(),
  direct_route_summary_sha256: hash,
  quote_payload_sha256: hash,
  quote_payload_sha256_spec: z.literal(QUOTE_PAYLOAD_SHA256_SPEC),
  input_base_bounds: z.object({ minimum: positiveDecimal, maximum: positiveDecimal }).strict(),
  minimum_output_base: positiveDecimal,
  required_wallet_chains: z.array(chain).min(1).max(6),
  event_signer_public_required: z.boolean(),
  step_count: positiveDecimal,
  allowed_modes: z.array(z.enum(MODES)).min(1).max(2),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).strict();

export const continuationV3Schema = z.object({
  version: z.literal(CONTINUATION_V3_VERSION),
  enforcement: z.literal("server_enforced_quote_binding"),
  selection_status: z.literal("unranked_candidate"),
  automatic_selection_forbidden: z.literal(true),
  caller_approved_boolean_is_not_human_proof: z.literal(true),
  quote_id: uuid,
  quote_fingerprint: hash,
  quote_fingerprint_spec: z.literal(QUOTE_FINGERPRINT_SPEC),
  quote_fingerprint_claim: quoteFingerprintClaimSchema,
  issued_at: dateTime,
  expires_at: dateTime,
  ttl_seconds: z.number().int().min(1).max(60),
  intent: continuationIntentSchema,
  direct_route_summary_sha256: hash,
  quote_payload_sha256: hash,
  quote_payload_sha256_spec: z.literal(QUOTE_PAYLOAD_SHA256_SPEC),
  input_base_bounds: z.object({ minimum: positiveDecimal, maximum: positiveDecimal }).strict(),
  minimum_output_base: positiveDecimal,
  required_wallet_chains: z.array(chain).min(1).max(6),
  event_signer_public_required: z.boolean(),
  step_count: z.number().int().min(1).max(8),
  recommended_mode: z.enum(["session", "one_shot_or_session"]),
  allowed_modes: z.array(z.enum(MODES)).min(1).max(2),
  session_header: z.object({
    name: z.literal("X-AssetFare-Session-Token"),
    required_for: z.literal("session"),
    caller_generated: z.literal(true),
    minimum_entropy_bits: z.literal(256),
    server_returns_raw_value: z.literal(false),
  }).strict(),
  idempotency: z.object({
    required: z.literal(true),
    field: z.literal("idempotency_key"),
    pattern: z.literal("^[A-Za-z0-9._:-]{8,128}$"),
    scope: z.literal("quote_and_selected_mode"),
  }).strict(),
  approval_v3_required_fields: z.tuple(APPROVAL_V3_KEYS.map((value) => z.literal(value))),
  legacy_handoff_enforcement: z.literal("legacy_advisory"),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).strict();

export const approvalV3Schema = z.object({
  version: z.literal(APPROVAL_V3_VERSION),
  quote_id: uuid,
  quote_fingerprint: hash,
  selection_status: z.literal("selected"),
  selected_mode: z.enum(MODES),
  maximum_input_base: positiveDecimal,
  minimum_output_base: positiveDecimal,
  direct_route_summary_sha256: hash,
  idempotency_key: z.string().regex(IDEMPOTENCY),
}).strict();

export const continuationV3CapabilitySchema = z.object({
  version: z.literal(CONTINUATION_V3_VERSION),
  required_on_every_quote: z.literal(true),
  enforcement: z.literal("server_enforced_quote_binding"),
  selection_status: z.literal("unranked_candidate"),
  automatic_selection_forbidden: z.literal(true),
  caller_approved_boolean_is_not_human_proof: z.literal(true),
  cache_scope: z.literal("bounded_process_local_ttl_restart_fails_closed"),
  maximum_ttl_seconds: z.literal(60),
  maximum_cache_records: z.literal(2048),
  multistep_allowed_modes: z.tuple([z.literal("session")]),
  one_step_allowed_modes: z.tuple([z.literal("one_shot"), z.literal("session")]),
  session_owner_binding: z.literal("sha256_of_caller_generated_session_token_raw_token_never_stored"),
  whole_session_path_and_bounds_enforced: z.literal(true),
  future_actions_requote_and_enforce_original_step_minimums: z.literal(true),
  quote_payload_sha256_spec: z.literal(QUOTE_PAYLOAD_SHA256_SPEC),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).strict();

export const reapprovalV3Schema = z.object({
  error: z.enum(["reapproval_required", "approval_v3_invalid"]),
  reason: z.string().regex(/^[a-z0-9_]{1,96}$/),
  action_created: z.literal(false),
  fresh_read_only_quote_required: z.boolean(),
  new_quote_is_not_action_authority: z.literal(true),
  do_not_repeat_confirmed_steps: z.boolean(),
  do_not_start_new_session: z.boolean(),
  recover_current_session: z.boolean(),
  recovery_operation: z.enum(["obtain_new_quote_and_make_new_selection", "refresh_current_session_only_when_original_approved_bounds_are_satisfied"]),
  replacement_approval_endpoint_available: z.boolean(),
  selection_status: z.literal("unranked_candidate"),
  automatic_selection_forbidden: z.literal(true),
  caller_approved_boolean_is_not_human_proof: z.literal(true),
  required_wallet_chains: z.array(chain).max(6),
  event_signer_public_required: z.boolean(),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).strict();

export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

export function sha256Canonical(value) {
  return createHash("sha256").update(Buffer.from(canonical(value), "utf8")).digest("hex");
}

function exactArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

function decimalString(value) {
  if (typeof value === "boolean" || !["number", "string"].includes(typeof value)) throw new Error("assetfare_v2_continuation_numeric_claim_invalid");
  const source = String(value);
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(source)) throw new Error("assetfare_v2_continuation_numeric_claim_invalid");
  const [coefficient, exponentText] = source.toLowerCase().split("e");
  const negative = coefficient.startsWith("-");
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const [whole, fraction = ""] = unsigned.split(".");
  const exponent = Number(exponentText || 0);
  let digits = `${whole}${fraction}`;
  let point = whole.length + exponent;
  if (point <= 0) digits = `${"0".repeat(-point)}${digits}`, point = 0;
  if (point >= digits.length) digits = `${digits}${"0".repeat(point - digits.length)}`;
  let rendered = point === 0 ? `0.${digits}` : point === digits.length ? digits : `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (rendered.includes(".")) rendered = rendered.replace(/0+$/, "").replace(/\.$/, "");
  rendered = rendered.replace(/^0+(?=\d)/, "") || "0";
  if (rendered.startsWith(".")) rendered = `0${rendered}`;
  if (/^0(?:\.0*)?$/.test(rendered)) return "0";
  return negative ? `-${rendered}` : rendered;
}

function requiredWalletChains(summary) {
  const chains = new Set();
  for (const step of summary.steps) {
    chains.add(String(step.from).split(":", 1)[0]);
    chains.add(String(step.to).split(":", 1)[0]);
  }
  return [...chains].sort();
}

function eventSignerRequired(summary) {
  return summary.steps.some((step) => step.provider === "circle_cctp" && step.from.startsWith("solana:"));
}

function quoteWithoutContinuation(quote) {
  const value = structuredClone(quote);
  delete value.continuation_v3;
  return value;
}

// Cross-language hash projection. direct_route_summary owns the exact base-unit
// decimal strings; duplicated raw JS numbers may already have rounded above
// 2^53, so replace only those explicitly named paths before typed encoding.
export function quotePayloadV3Projection(quote) {
  const value = quoteWithoutContinuation(quote);
  const summarySteps = value?.direct_route_summary?.steps;
  const rawSteps = value?.route?.steps;
  if (!value?.intent || !value?.route || !Array.isArray(summarySteps) || !summarySteps.length || !Array.isArray(rawSteps) || rawSteps.length !== summarySteps.length) throw new Error("assetfare_v2_continuation_v3_quote_invalid");
  const exactKeys = ["expected_input_base", "minimum_input_base", "expected_output_base", "minimum_output_base"];
  if (summarySteps.some((step) => !step || typeof step !== "object" || Array.isArray(step) || exactKeys.some((key) => typeof step[key] !== "string" || !EXACT_BASE_UNITS.test(step[key])))) throw new Error("assetfare_v2_continuation_v3_quote_invalid");
  const first = summarySteps[0], last = summarySteps.at(-1);
  value.intent.estimated_input_base = first.expected_input_base;
  value.route.input_base = first.expected_input_base;
  value.route.expected_output_base = last.expected_output_base;
  value.route.minimum_output_base = last.minimum_output_base;
  for (let index = 0; index < summarySteps.length; index += 1) {
    const exact = summarySteps[index], raw = rawSteps[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("assetfare_v2_continuation_v3_quote_invalid");
    raw.expected_input_base = exact.expected_input_base;
    raw.floor_input_base = exact.minimum_input_base;
    raw.expected_output_base = exact.expected_output_base;
    raw.minimum_output_base = exact.minimum_output_base;
  }
  return value;
}

function ascii(value) { return Buffer.from(value, "ascii"); }
function concat(parts) { return Buffer.concat(parts); }
function utf8Strict(value) {
  for(let index=0;index<value.length;index+=1){const unit=value.charCodeAt(index);if(unit>=0xD800&&unit<=0xDBFF){const next=value.charCodeAt(index+1);if(!(next>=0xDC00&&next<=0xDFFF))throw new Error("assetfare_v2_quote_payload_string_invalid");index+=1;}else if(unit>=0xDC00&&unit<=0xDFFF)throw new Error("assetfare_v2_quote_payload_string_invalid");}
  return Buffer.from(value,"utf8");
}

// AssetFare typed-canonical-v1. This preserves JSON type, differentiates -0
// from +0, and rejects every non-substituted unsafe integral Number.
export function typedCanonicalV1(value) {
  if (value === null) return ascii("n");
  if (value === true) return ascii("t");
  if (value === false) return ascii("f");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("assetfare_v2_quote_payload_nonfinite_number");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error("assetfare_v2_quote_payload_unsafe_integer");
    const raw=Buffer.allocUnsafe(8);raw.writeDoubleBE(value,0);return concat([ascii("d"),ascii(raw.toString("hex"))]);
  }
  if (typeof value === "string") { const raw=utf8Strict(value);return concat([ascii(`s${raw.length}:`),raw]); }
  if (Array.isArray(value)) {
    const keys=Object.keys(value),own=Reflect.ownKeys(value),descriptors=Object.getOwnPropertyDescriptors(value);
    if(keys.length!==value.length||keys.some((key,index)=>key!==String(index))||own.length!==value.length+1||own.some((key)=>typeof key!=="string"||(key!=="length"&&!/^(0|[1-9][0-9]*)$/.test(key)))||Object.entries(descriptors).some(([key,descriptor])=>key!=="length"&&!("value" in descriptor)))throw new Error("assetfare_v2_quote_payload_value_invalid");
    return concat([ascii(`a${value.length}:[`),...value.map(typedCanonicalV1),ascii("]")]);
  }
  if (value && typeof value === "object") {
    const prototype=Object.getPrototypeOf(value),keys=Object.keys(value),own=Reflect.ownKeys(value);
    const descriptors=Object.getOwnPropertyDescriptors(value);
    if((prototype!==Object.prototype&&prototype!==null)||own.length!==keys.length||own.some((key)=>typeof key!=="string")||Object.values(descriptors).some((descriptor)=>!("value" in descriptor)))throw new Error("assetfare_v2_quote_payload_value_invalid");
    const entries=Object.entries(value).map(([key,child])=>[key,child,utf8Strict(key)]).sort((left,right)=>Buffer.compare(left[2],right[2]));
    return concat([ascii(`o${entries.length}:{`),...entries.flatMap(([key,child])=>[typedCanonicalV1(key),typedCanonicalV1(child)]),ascii("}")]);
  }
  throw new Error("assetfare_v2_quote_payload_value_invalid");
}

export function quotePayloadSha256(quote) {
  return createHash("sha256").update(typedCanonicalV1(quotePayloadV3Projection(quote))).digest("hex");
}

export function validateContinuationV3(continuationInput, quote, { requireUnexpired = false, nowMs = Date.now() } = {}) {
  let continuation;
  try { continuation = continuationV3Schema.parse(continuationInput); }
  catch { throw new Error("assetfare_v2_continuation_v3_shape_invalid"); }
  const summary = quote?.direct_route_summary;
  const route = quote?.route;
  const intent = quote?.intent;
  if (!summary || !route || !intent) throw new Error("assetfare_v2_continuation_v3_quote_invalid");
  const summaryHash = sha256Canonical(summary);
  let payloadHash;
  try { payloadHash=quotePayloadSha256(quote); }
  catch (error) { if (String(error?.message||"").startsWith("assetfare_v2_quote_payload_")) throw error; throw new Error("assetfare_v2_continuation_v3_quote_invalid"); }
  const fingerprintHash = sha256Canonical(continuation.quote_fingerprint_claim);
  if (summaryHash !== continuation.direct_route_summary_sha256 || payloadHash !== continuation.quote_payload_sha256 || fingerprintHash !== continuation.quote_fingerprint) throw new Error("assetfare_v2_continuation_v3_hash_mismatch");
  const issued = Date.parse(continuation.issued_at);
  const expires = Date.parse(continuation.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || continuation.ttl_seconds !== quote.ttl_seconds || expires - issued !== continuation.ttl_seconds * 1000 || (requireUnexpired && (nowMs < issued || nowMs >= expires))) throw new Error("assetfare_v2_continuation_v3_ttl_invalid");
  const requiredChains = requiredWalletChains(summary);
  const signerRequired = eventSignerRequired(summary);
  const allowedModes = summary.step_count > 1 ? ["session"] : ["one_shot", "session"];
  const recommendedMode = summary.step_count > 1 ? "session" : "one_shot_or_session";
  const input = summary.steps[0].expected_input_base;
  const minimumOutput = summary.steps.at(-1).minimum_output_base;
  if (continuation.quote_id !== quote.quote_id || canonical(continuation.intent) !== canonical(intent) || continuation.step_count !== summary.step_count || continuation.recommended_mode !== recommendedMode || !exactArray(continuation.allowed_modes, allowedModes) || !exactArray(continuation.required_wallet_chains, requiredChains) || continuation.event_signer_public_required !== signerRequired || continuation.input_base_bounds.minimum !== input || continuation.input_base_bounds.maximum !== input || continuation.minimum_output_base !== minimumOutput) throw new Error("assetfare_v2_continuation_v3_binding_invalid");
  const expectedClaim = {
    version: CONTINUATION_V3_VERSION,
    quote_id: quote.quote_id,
    issued_at: continuation.issued_at,
    expires_at: continuation.expires_at,
    ttl_seconds: String(continuation.ttl_seconds),
    intent: { from: intent.from, to: intent.to, amount_usd_decimal: decimalString(intent.amount_usd), estimated_input_base: input },
    direct_route_summary_sha256: summaryHash,
    quote_payload_sha256: payloadHash,
    quote_payload_sha256_spec: QUOTE_PAYLOAD_SHA256_SPEC,
    input_base_bounds: { minimum: input, maximum: input },
    minimum_output_base: minimumOutput,
    required_wallet_chains: requiredChains,
    event_signer_public_required: signerRequired,
    step_count: String(summary.step_count),
    allowed_modes: allowedModes,
    server_signing: false,
    server_submission: false,
  };
  if (canonical(continuation.quote_fingerprint_claim) !== canonical(expectedClaim) || continuation.quote_fingerprint_claim.quote_payload_sha256 !== continuation.quote_payload_sha256 || continuation.quote_fingerprint_claim.direct_route_summary_sha256 !== continuation.direct_route_summary_sha256) throw new Error("assetfare_v2_continuation_v3_fingerprint_claim_invalid");
  return continuation;
}

export function validateApprovalV3(approvalInput, continuation, { mode, requireUnexpired = false, nowMs = Date.now() } = {}) {
  let approval;
  try { approval = approvalV3Schema.parse(approvalInput); }
  catch { throw new Error("assetfare_v2_approval_v3_shape_invalid"); }
  if (mode && approval.selected_mode !== mode) throw new Error("assetfare_v2_approval_v3_mode_mismatch");
  if (!continuation.allowed_modes.includes(approval.selected_mode)) throw new Error("assetfare_v2_approval_v3_mode_not_allowed");
  if (approval.quote_id !== continuation.quote_id || approval.quote_fingerprint !== continuation.quote_fingerprint || approval.direct_route_summary_sha256 !== continuation.direct_route_summary_sha256) throw new Error("assetfare_v2_approval_v3_quote_binding_failed");
  if (BigInt(approval.maximum_input_base) > BigInt(continuation.input_base_bounds.maximum) || BigInt(approval.minimum_output_base) < BigInt(continuation.minimum_output_base)) throw new Error("assetfare_v2_approval_v3_bounds_weaken_quote");
  if (requireUnexpired && nowMs >= Date.parse(continuation.expires_at)) throw new Error("assetfare_v2_approval_v3_quote_expired");
  return approval;
}

export function approvalDraft(continuation) {
  return {
    version: APPROVAL_V3_VERSION,
    quote_id: continuation.quote_id,
    quote_fingerprint: continuation.quote_fingerprint,
    selection_status: "unranked_candidate",
    selected_mode: null,
    maximum_input_base: continuation.input_base_bounds.maximum,
    minimum_output_base: continuation.minimum_output_base,
    direct_route_summary_sha256: continuation.direct_route_summary_sha256,
    idempotency_key: null,
    allowed_modes: [...continuation.allowed_modes],
    automatic_selection_forbidden: true,
    caller_approved_boolean_is_not_human_proof: true,
    executable: false,
    server_signing: false,
    server_submission: false,
  };
}
