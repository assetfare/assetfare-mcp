#!/usr/bin/env node
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, linkSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { QUOTE_PAYLOAD_SHA256_SPEC, approvalDraft, validateContinuationV3 } from "../src/continuation-v3.js";
import { validateDirectRouteSummary } from "../src/direct-route-summary.js";
import { isMain } from "../src/is-main.js";
import { parseV2Quote } from "../src/server.js";
import {
  ASSETFARE_MANIFEST_KEY_ID,
  ASSETFARE_MANIFEST_PUBLIC_KEY,
  ASSETFARE_MANIFEST_PUBLIC_KEY_URL,
} from "../src/trust-root.js";

const DEFAULTS = {
  amount: 1000,
  fromChain: "solana",
  fromToken: "USDC",
  toChain: "base",
  toToken: "USDC",
};
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PUBLIC_KEY_BYTES = 4_096;

function usage() {
  return `AssetFare read-only route evaluator

Usage:
  npm run route-eval -- [options]
  node scripts/route-eval.mjs [options]

Options:
  --amount <USD>          Finite whole or decimal USD amount of at least 1
  --from-chain <chain>    solana | base | arbitrum | robinhood | polygon | optimism
  --from-token <token>    SOL | ETH | USDC | USDG
  --to-chain <chain>      solana | base | arbitrum | robinhood
  --to-token <token>      SOL | ETH | USDC | USDG
  --quote-output <path>   Write the exact validated quote to a new mode-0600 file
  --assetfare-only        Skip eligible Relay and Mayan comparison snapshots
  --compact               Emit compact JSON
  --help                  Show this message

Defaults: $1,000 solana:USDC -> base:USDC. USD 1 is reachability/schema smoke
only. A USD 50 competitive bucket was observed only for the dated 2026-09-23
Solana USDC -> Base USDC evidence; do not generalize it to another corridor.
SOL-input routes include a swap. USD 1,000 is the primary representative
comparison amount; always compare at the actual intended amount.

The default USDC path returns one AssetFare candidate, not a cross-provider
market comparison. Output includes a fail-closed direct_route_summary with the
ordered provider/from/to path, base-unit bounds, fee step, and direct versus
Across external-intent classification. route_aggregator_used=false applies to
AssetFare's engine only. It also returns selection_status=unranked_candidate and
a non-executable approval draft; it never selects without an explicit later
assetfare-select operation. The evaluator never authenticates a wallet, creates
a session, prepares an action, signs, or submits a transaction.`;
}

export function writeQuoteOutput(path, quote) {
  const absolute = resolve(path);
  const temporary = `${absolute}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(quote, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(descriptor);
    chmodSync(temporary, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, absolute);
    unlinkSync(temporary);
  } catch (error) {
    if (descriptor !== undefined) { closeSync(descriptor); descriptor = undefined; }
    try { unlinkSync(temporary); } catch {}
    throw new Error(error?.code === "EEXIST" ? "quote output already exists" : "quote output is invalid");
  }
  return absolute;
}

export function economicFit({ amountUsd, fromChain, fromToken, toChain, toToken }) {
  const evidenceRoute = fromChain === "solana" && fromToken === "USDC" && toChain === "base" && toToken === "USDC";
  const belowObservedBucket = evidenceRoute && amountUsd < 50;
  return {
    classification: amountUsd === 1
      ? "reachability_smoke_only"
      : belowObservedBucket
        ? "below_observed_corridor_economic_bucket"
        : "fresh_comparison_required",
    evidence_route: "solana:USDC->base:USDC",
    evidence_applies_to_requested_route: evidenceRoute,
    observed_competitive_bucket_usd: evidenceRoute ? 50 : null,
    economic_comparison_recommended: amountUsd !== 1 && !belowObservedBucket,
    aggregate_refill_or_transfer_preferred: true,
    single_micropayment_top_up_recommended: false,
    note: belowObservedBucket
      ? "Below the dated USD 50 observed bucket for Solana USDC -> Base USDC; aggregate demand before comparing this corridor."
      : evidenceRoute
        ? "Compare fresh executable candidates at the caller's actual intended amount; the dated USD 50 observation is not a cheapest guarantee."
        : "No corridor-specific competitive threshold is claimed; compare fresh executable candidates at the caller's actual intended amount.",
  };
}

export function parseRouteEvalArgs(argv) {
  const values = new Set(["amount", "from-chain", "from-token", "to-chain", "to-token", "quote-output"]);
  const flags = new Set(["assetfare-only", "compact"]);
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--help" || raw === "-h") {
      if (argv.length !== 1) throw new Error("route evaluator help cannot be combined with other arguments");
      return { help: true };
    }
    if (!raw.startsWith("--")) throw new Error("route evaluator argument is invalid");
    const equal = raw.indexOf("=");
    const key = raw.slice(2, equal < 0 ? undefined : equal);
    if (!values.has(key) && !flags.has(key)) throw new Error(`unknown option --${key}`);
    if (Object.hasOwn(out, key)) throw new Error(`duplicate option --${key}`);
    if (flags.has(key)) {
      if (equal >= 0) throw new Error(`--${key} does not accept a value`);
      out[key] = true;
      continue;
    }
    const value = equal >= 0 ? raw.slice(equal + 1) : argv[++index];
    if (typeof value !== "string" || !value || value.startsWith("--")) throw new Error(`--${key} requires a value`);
    out[key] = value;
  }
  return out;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function responseText(response, maximumBytes = MAX_RESPONSE_BYTES) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("response too large");
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maximumBytes) throw new Error("response too large");
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
      throw new Error("response too large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function jsonRequest(url, options = {}, label = "request") {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      "user-agent": "AssetFareAgentRouteEval/1",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
  });
  const mediaType = String(response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
  const text = await responseText(response);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const message = body.error || body.message || body.msg || JSON.stringify(body);
    throw new Error(`${label} failed: HTTP ${response.status} ${message}`);
  }
  return body;
}

export async function verifyManifest(apiBase, publicKeyUrlOverride) {
  const manifest = await jsonRequest(`${apiBase}/.well-known/assetfare-manifest.json`, {}, "manifest");
  const signature = manifest.signature;
  if (signature?.algorithm !== "Ed25519" || !signature.value) {
    throw new Error("manifest has no supported Ed25519 signature");
  }
  let pem;
  if (publicKeyUrlOverride) {
    const apiUrl = new URL(apiBase);
    const keyUrl = new URL(publicKeyUrlOverride);
    if (!(["127.0.0.1", "localhost"].includes(apiUrl.hostname) && ["127.0.0.1", "localhost"].includes(keyUrl.hostname))) {
      throw new Error("manifest public key override is local-test-only");
    }
    const response = await fetch(keyUrl, {
      headers: { "user-agent": "AssetFareAgentRouteEval/1" },
      redirect: "error",
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`manifest public key failed: HTTP ${response.status}`);
    pem = await responseText(response, MAX_PUBLIC_KEY_BYTES);
  } else {
    if (signature.key_id !== ASSETFARE_MANIFEST_KEY_ID || signature.public_key_url !== ASSETFARE_MANIFEST_PUBLIC_KEY_URL) {
      throw new Error("manifest trust root mismatch");
    }
    pem = ASSETFARE_MANIFEST_PUBLIC_KEY;
  }
  const unsigned = structuredClone(manifest);
  delete unsigned.signature;
  const valid = verify(null, Buffer.from(canonical(unsigned)), createPublicKey(pem), Buffer.from(signature.value, "base64"));
  if (!valid) throw new Error("manifest signature verification failed");
  const validUntil = Date.parse(manifest.valid_until);
  if (!Number.isFinite(validUntil) || validUntil <= Date.now()) throw new Error("manifest is expired");
  return {
    valid: true,
    key_id: signature.key_id,
    release_commit: manifest.release_commit,
    valid_until: manifest.valid_until,
    multichain_release: manifest.execution?.multichain_v2?.release_status,
  };
}

export function parseAmountUsd(value) {
  const text = String(value);
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(text);
  if (!match) throw new Error("amount must be a plain USD decimal with at most 6 fractional digits");
  const fraction = match[2] || "";
  const scale = 10n ** BigInt(fraction.length);
  const scaled = BigInt(match[1]) * scale + BigInt(fraction || "0");
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount exceeds exact JavaScript decimal range");
  const amount = Number(scaled) / Number(scale);
  if (!Number.isFinite(amount) || amount < 1 || Math.round(amount * Number(scale)) !== Number(scaled)) {
    throw new Error("amount cannot be represented exactly by this client");
  }
  return amount;
}

function decimalUnits(rawValue, decimals) {
  const raw = BigInt(rawValue);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function relayQuote(inputLamports, relayUrl) {
  const quote = await jsonRequest(relayUrl, {
    method: "POST",
    body: JSON.stringify({
      user: "11111111111111111111111111111111",
      originChainId: 792703809,
      destinationChainId: 8453,
      originCurrency: "11111111111111111111111111111111",
      destinationCurrency: "0x0000000000000000000000000000000000000000",
      amount: String(inputLamports),
      tradeType: "EXACT_INPUT",
      recipient: "0x0000000000000000000000000000000000000001",
    }),
  }, "Relay quote");
  const output = quote.details?.currencyOut;
  if (!output) throw new Error("Relay response has no output amount");
  return {
    provider: "relay",
    expected_receive_amount: Number(output.amountFormatted),
    minimum_receive_amount: Number(decimalUnits(output.minimumAmount, output.currency.decimals)),
    output_symbol: output.currency.symbol || "ETH",
    estimated_time_seconds: Number(quote.details?.timeEstimate) || null,
    notes: "Placeholder public addresses; comparison snapshot only",
  };
}

async function mayanQuote(inputLamports, mayanUrl) {
  const inputSol = decimalUnits(inputLamports, 9);
  const query = new URLSearchParams({
    amountIn: inputSol,
    fromToken: "So11111111111111111111111111111111111111112",
    fromChain: "solana",
    toToken: "0x0000000000000000000000000000000000000000",
    toChain: "base",
    slippageBps: "200",
    gasDrop: "0",
    swift: "true",
    mctp: "true",
    fastMctp: "true",
    wormhole: "true",
    fullList: "true",
    sdkVersion: "15_2_2",
  });
  const payload = await jsonRequest(`${mayanUrl}?${query}`, {}, "Mayan quote");
  const quotes = Array.isArray(payload.quotes) ? payload.quotes : [];
  const quote = quotes.sort((left, right) => Number(right.expectedAmountOut) - Number(left.expectedAmountOut))[0];
  if (!quote) throw new Error("Mayan returned no route");
  return {
    provider: "mayan",
    expected_receive_amount: Number(quote.expectedAmountOut),
    minimum_receive_amount: Number(quote.minAmountOut),
    output_symbol: "ETH",
    estimated_time_seconds: Number(quote.etaSeconds) || null,
    notes: `${quote.type || "route"}; placeholder public addresses; comparison snapshot only`,
  };
}

function settled(result) {
  if (result.status === "fulfilled") return { status: "available", ...result.value };
  return { status: "unavailable", error: result.reason instanceof Error ? result.reason.message : "request failed" };
}

const PREPARE_URL = "https://api.assetfare.dev/v2/prepare";
const SESSION_URL = "https://api.assetfare.dev/v2/session";
const HANDOFF_REQUEST_FIELDS = ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets", "event_signer_public"];

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function exactArray(value, expected) {
  return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]);
}

export function parseContinuation(quote) {
  const handoff = quote?.caller_action_plan_handoff_v2;
  const prepare = handoff?.options?.[0];
  const session = handoff?.options?.[1];
  const lifecycle = session?.lifecycle_urls;
  const topKeys = ["kind", "url", "method", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "request_fields", "assetfare_server_signing", "assetfare_server_submission", "caller_must_verify_sign_and_submit", "requires_fresh_requote", "automatic_prepare_call_forbidden", "schema_version", "selection", "mutually_exclusive", "do_not_call_both", "selection_before_signing", "once_any_action_submitted_do_not_start_other_mode", "enforcement", "options", "note", "available"];
  const prepareKeys = ["kind", "method", "url", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "assetfare_never_signs_submits_or_auto_calls", "preview_or_manual_first_action_only", "not_a_session", "do_not_start_session_after_submission", "note"];
  const sessionKeys = ["kind", "method", "url", "lifecycle_urls", "requires_explicit_caller_approval", "requires_public_wallet_addresses", "assetfare_never_signs_submits_or_auto_calls", "recommended_for_multistep", "note"];
  const lifecycleExpected = [
    ["create", "POST", SESSION_URL],
    ["read", "GET", `${SESSION_URL}/{session_id}`],
    ["observe_source", "POST", `${SESSION_URL}/{session_id}/observe-source`],
    ["observe_output", "POST", `${SESSION_URL}/{session_id}/observe-output`],
    ["refresh_action", "POST", `${SESSION_URL}/{session_id}/refresh-action`],
  ];
  const valid = quote?.handoff_schema_version === 2
    && exactKeys(handoff, topKeys)
    && handoff?.schema_version === 2
    && handoff?.kind === "caller_operated_rest_prepare"
    && handoff?.method === "POST"
    && handoff?.url === PREPARE_URL
    && exactArray(handoff?.request_fields, HANDOFF_REQUEST_FIELDS)
    && handoff?.selection === "choose_exactly_one"
    && handoff?.mutually_exclusive === true
    && handoff?.do_not_call_both === true
    && handoff?.selection_before_signing === true
    && handoff?.once_any_action_submitted_do_not_start_other_mode === true
    && handoff?.enforcement === "advisory_caller_side"
    && handoff?.requires_explicit_caller_approval === true
    && handoff?.requires_public_wallet_addresses === true
    && handoff?.assetfare_server_signing === false
    && handoff?.assetfare_server_submission === false
    && handoff?.caller_must_verify_sign_and_submit === true
    && handoff?.requires_fresh_requote === true
    && handoff?.automatic_prepare_call_forbidden === true
    && handoff?.available === true
    && typeof handoff?.note === "string"
    && handoff.note.length > 0
    && Array.isArray(handoff?.options)
    && handoff.options.length === 2
    && exactKeys(prepare, prepareKeys)
    && prepare?.kind === "one_shot_first_unsigned_bundle"
    && prepare?.method === "POST"
    && prepare?.url === PREPARE_URL
    && prepare?.requires_explicit_caller_approval === true
    && prepare?.requires_public_wallet_addresses === true
    && prepare?.assetfare_never_signs_submits_or_auto_calls === true
    && prepare?.preview_or_manual_first_action_only === true
    && prepare?.not_a_session === true
    && prepare?.do_not_start_session_after_submission === true
    && typeof prepare?.note === "string"
    && prepare.note.length > 0
    && exactKeys(session, sessionKeys)
    && session?.kind === "caller_approved_full_workflow_session"
    && session?.method === "POST"
    && session?.url === SESSION_URL
    && session?.requires_explicit_caller_approval === true
    && session?.requires_public_wallet_addresses === true
    && session?.assetfare_never_signs_submits_or_auto_calls === true
    && session?.recommended_for_multistep === true
    && typeof session?.note === "string"
    && session.note.length > 0
    && exactKeys(lifecycle, lifecycleExpected.map(([name]) => name))
    && lifecycleExpected.every(([name, method, url]) => exactKeys(lifecycle[name], ["method", "url"])
      && lifecycle[name].method === method && lifecycle[name].url === url);
  if (!valid) throw new Error("AssetFare quote has no valid caller-approved continuation");
  const safeHandoff = {
    kind: "caller_operated_rest_prepare",
    url: PREPARE_URL,
    method: "POST",
    requires_explicit_caller_approval: true,
    requires_public_wallet_addresses: true,
    request_fields: [...HANDOFF_REQUEST_FIELDS],
    assetfare_server_signing: false,
    assetfare_server_submission: false,
    caller_must_verify_sign_and_submit: true,
    requires_fresh_requote: true,
    automatic_prepare_call_forbidden: true,
    schema_version: 2,
    selection: "choose_exactly_one",
    mutually_exclusive: true,
    do_not_call_both: true,
    selection_before_signing: true,
    once_any_action_submitted_do_not_start_other_mode: true,
    enforcement: "advisory_caller_side",
    options: [
      {
        kind: "one_shot_first_unsigned_bundle", method: "POST", url: PREPARE_URL,
        requires_explicit_caller_approval: true, requires_public_wallet_addresses: true,
        assetfare_never_signs_submits_or_auto_calls: true, preview_or_manual_first_action_only: true,
        not_a_session: true, do_not_start_session_after_submission: true,
        note: "Caller-approved one-shot preview of the first unsigned action; never sign or submit automatically.",
      },
      {
        kind: "caller_approved_full_workflow_session", method: "POST", url: SESSION_URL,
        lifecycle_urls: Object.fromEntries(lifecycleExpected.map(([name, method, url]) => [name, { method, url }])),
        requires_explicit_caller_approval: true, requires_public_wallet_addresses: true,
        assetfare_never_signs_submits_or_auto_calls: true, recommended_for_multistep: true,
        note: "Caller-approved receipt-driven session for multi-step routes; the caller verifies, signs, and submits.",
      },
    ],
    note: "Choose exactly one caller-operated mode after explicit approval. AssetFare never signs or submits.",
    available: true,
  };
  return {
    decision_required: "explicit_caller_approval",
    quote_authorizes_execution: false,
    choose_exactly_one_mode: true,
    automatic_prepare_forbidden: true,
    full_openapi_url: "https://api.assetfare.dev/v2/openapi.json",
    server_signing: false,
    server_submission: false,
    caller_verifies_signs_and_submits: true,
    handoff_schema_version: 2,
    caller_action_plan_handoff_v2: safeHandoff,
  };
}

export function validateRequestedQuote(quote, requested) {
  if (quote?.intent?.from !== `${requested.from_chain}:${requested.from_token}` || quote?.intent?.to !== `${requested.to_chain}:${requested.to_token}` || quote?.intent?.amount_usd !== requested.amount_usd || quote?.offer?.output_symbol !== requested.to_token) {
    throw new Error("AssetFare quote does not match the requested intent");
  }
}

async function main() {
  const args = parseRouteEvalArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const amountUsd = parseAmountUsd(args.amount ?? DEFAULTS.amount);
  const fromChain = String(args["from-chain"] ?? DEFAULTS.fromChain).toLowerCase();
  const fromToken = String(args["from-token"] ?? DEFAULTS.fromToken).toUpperCase();
  const toChain = String(args["to-chain"] ?? DEFAULTS.toChain).toLowerCase();
  const toToken = String(args["to-token"] ?? DEFAULTS.toToken).toUpperCase();
  const quoteOutput = args["quote-output"] ?? null;
  if (fromChain === toChain && fromToken === toToken) throw new Error("identity route does not require a quote");

  const apiBase = process.env.ASSETFARE_API_BASE || "https://api.assetfare.dev";
  const publicKeyUrl = process.env.ASSETFARE_MANIFEST_PUBLIC_KEY_URL;
  const [manifest, capabilities, status] = await Promise.all([
    verifyManifest(apiBase, publicKeyUrl),
    jsonRequest(`${apiBase}/v2/capabilities`, {}, "capabilities"),
    jsonRequest(`${apiBase}/v2/status`, {}, "status"),
  ]);
  if (capabilities.public_api_enabled !== true || capabilities.server_signing !== false || capabilities.server_submission !== false) {
    throw new Error("public capability safety boundary is unavailable");
  }
  const routeContract=capabilities.direct_route_summary;
  if(routeContract?.version!=="assetfare-direct-route-summary-v1"||routeContract?.required_on_every_quote!==true||routeContract?.route_count!==76||routeContract?.step_count!==168||routeContract?.ordered_provider_path!==true||routeContract?.normalized_chain_asset_endpoints!==true||routeContract?.base_unit_amounts_are_decimal_strings!==true||routeContract?.assetfare_fee_step_bound!==true||JSON.stringify(routeContract?.classification_values)!==JSON.stringify(["direct_protocol_only","external_intent"])||routeContract?.route_aggregator_used_scope!=="assetfare_engine_only"||routeContract?.external_intent!=="Across only for Robinhood ingress; provider-internal liquidity sourcing or aggregation remains possible"||routeContract?.server_signing!==false||routeContract?.server_submission!==false)throw new Error("public direct route summary contract is unavailable");
  const continuationContract=capabilities.continuation_v3;
  if(continuationContract?.version!=="assetfare-quote-bound-continuation-v3"||continuationContract?.required_on_every_quote!==true||continuationContract?.enforcement!=="server_enforced_quote_binding"||continuationContract?.selection_status!=="unranked_candidate"||continuationContract?.automatic_selection_forbidden!==true||continuationContract?.caller_approved_boolean_is_not_human_proof!==true||continuationContract?.whole_session_path_and_bounds_enforced!==true||continuationContract?.quote_payload_sha256_spec!==QUOTE_PAYLOAD_SHA256_SPEC||continuationContract?.server_signing!==false||continuationContract?.server_submission!==false)throw new Error("public continuation_v3 contract is unavailable");
  if (status.status !== "capped_public_agent_release" || status.server_signing !== false || status.server_submission !== false) {
    throw new Error("public provider status is not ready");
  }
  const endpointSet = new Set((capabilities.asset_endpoints || []).map((item) => `${item.chain}:${item.token}`));
  if (!endpointSet.has(`${fromChain}:${fromToken}`) || !endpointSet.has(`${toChain}:${toToken}`)) {
    throw new Error("requested chain/token endpoint is unsupported");
  }

  const requestedIntent = { from_chain: fromChain, from_token: fromToken, to_chain: toChain, to_token: toToken, amount_usd: amountUsd };
  const quote = await jsonRequest(`${apiBase}/v2/quote`, {
    method: "POST",
    body: JSON.stringify({
      from_chain: fromChain,
      from_token: fromToken,
      to_chain: toChain,
      to_token: toToken,
      amount_usd: amountUsd,
    }),
  }, "AssetFare quote");
  parseV2Quote(quote, requestedIntent);
  if (quote.status !== "capped_public_agent_release" || quote.execution?.supported !== true) {
    throw new Error("AssetFare quote is not executable under the current public release");
  }
  validateRequestedQuote(quote, requestedIntent);
  const continuation = parseContinuation(quote);
  const directRouteSummary = validateDirectRouteSummary(quote.direct_route_summary, quote.route, quote.risk, quote.intent, quote.offer);
  const continuationV3=validateContinuationV3(quote.continuation_v3,quote,{requireUnexpired:true});
  const expiresAt = continuationV3.expires_at;
  const quoteOutputPath = quoteOutput ? writeQuoteOutput(quoteOutput, quote) : null;
  const output = {
    status: "pass",
    evaluation_kind: "read_only_assetfare_candidate_quote",
    selection_status: "unranked_candidate",
    selected_provider: null,
    automatic_selection_forbidden: true,
    caller_approved_boolean_is_not_human_proof: true,
    requested_intent: { from_chain: fromChain, from_token: fromToken, to_chain: toChain, to_token: toToken, amount_usd: amountUsd },
    economic_evaluation: {
      api_minimum_usd: 1,
      one_dollar_purpose: "reachability_and_schema_smoke_only",
      observed_competitive_bucket_usd: 50,
      observed_evidence_route: "solana:USDC->base:USDC",
      evidence_applies_to_requested_route: fromChain === "solana" && fromToken === "USDC" && toChain === "base" && toToken === "USDC",
      evidence_as_of: "2026-09-23",
      cheapest_guaranteed: false,
      sol_input_includes_swap: fromToken === "SOL",
      representative_comparison_amount_usd: 1000,
      always_compare_at_intended_amount: true,
      use_case_fit: economicFit({ amountUsd, fromChain, fromToken, toChain, toToken }),
    },
    manifest,
    assetfare: {
      quote_id: quote.quote_id,
      as_of: quote.as_of,
      expires_at: expiresAt,
      expected_receive_amount: quote.offer?.expected_receive_amount,
      minimum_receive_amount: quote.offer?.estimated_min_receive_amount,
      output_symbol: quote.offer?.output_symbol,
      expected_receive_usd: quote.offer?.expected_receive_usd,
      minimum_receive_usd: quote.offer?.estimated_min_receive_usd,
      estimated_time_seconds: quote.offer?.estimated_time_seconds,
      assetfare_fee_bps: quote.offer?.assetfare_fee_bps,
      step_count: quote.route?.steps?.length,
      non_atomic: quote.risk?.non_atomic,
      server_signing: quote.risk?.server_signing,
      server_submission: quote.risk?.server_submission,
    },
    alternatives: {
      status: "not_requested",
      selection_status: "unranked_candidate",
      selected_provider: null,
      reason: toToken === "USDC"
        ? "This USDC path returns one AssetFare candidate, not a cross-provider market comparison. Compare fresh executable alternatives at the intended amount."
        : "same-input Relay/Mayan comparison is currently implemented only for solana:SOL -> base:ETH",
    },
    direct_route_summary: directRouteSummary,
    continuation_v3: continuationV3,
    approval_v3_draft: approvalDraft(continuationV3),
    quote_output: {
      persisted: quoteOutputPath !== null,
      output_path: quoteOutputPath,
      file_mode: quoteOutputPath === null ? null : "0600",
      contains_private_key_or_signature: false,
    },
    continuation,
    safety: {
      wallet_authentication_performed: false,
      session_created: false,
      action_prepared: false,
      transaction_signed: false,
      transaction_submitted: false,
      requote_before_execution: true,
      quote_authorizes_execution: false,
      approval_draft_executable: false,
      plan_minimum_remaining_seconds: 15,
      begin_plan_before: new Date(Date.parse(expiresAt) - 15_000).toISOString(),
    },
  };

  const comparable = fromChain === "solana" && fromToken === "SOL" && toChain === "base" && toToken === "ETH";
  if (comparable && !args["assetfare-only"]) {
    const inputLamports = quote.intent?.estimated_input_base;
    if (!Number.isInteger(inputLamports) || inputLamports <= 0) throw new Error("AssetFare quote has no valid SOL input amount");
    const [relay, mayan] = await Promise.allSettled([
      relayQuote(inputLamports, process.env.ASSETFARE_RELAY_QUOTE_URL || "https://api.relay.link/quote"),
      mayanQuote(inputLamports, process.env.ASSETFARE_MAYAN_QUOTE_URL || "https://price-api.mayan.finance/v3/quote"),
    ]);
    const alternatives = [settled(relay), settled(mayan)];
    const candidates = [
      { provider: "assetfare", expected_receive_amount: Number(quote.offer.expected_receive_amount), output_symbol: quote.offer.output_symbol },
      ...alternatives.filter((item) => item.status === "available"),
    ].filter((item) => Number.isFinite(item.expected_receive_amount));
    candidates.sort((left, right) => right.expected_receive_amount - left.expected_receive_amount);
    output.alternatives = {
      status: "same_input_snapshot",
      input_lamports: inputLamports,
      providers: alternatives,
      highest_expected_receive_snapshot: candidates[0]?.provider || null,
      selected_provider: null,
      selection_status: "unranked_candidate",
      warning: "Comparison uses placeholder public addresses and is not an executable order. Requote every provider with the caller's real addresses before selection or signing.",
    };
  }

  console.log(JSON.stringify(output, null, args.compact ? 0 : 2));
}

if (isMain(import.meta.url)) main().catch((error) => {
  console.error(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : "unknown error" }));
  process.exitCode = 1;
});
