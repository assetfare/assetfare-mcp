#!/usr/bin/env node
import { createPublicKey, verify } from "node:crypto";
import { isMain } from "../src/is-main.js";

const DEFAULTS = {
  amount: 1000,
  fromChain: "solana",
  fromToken: "USDC",
  toChain: "base",
  toToken: "USDC",
};

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
  --assetfare-only        Skip eligible Relay and Mayan comparison snapshots
  --compact               Emit compact JSON
  --help                  Show this message

Defaults: $1,000 solana:USDC -> base:USDC. USD 1 is reachability/schema smoke
only. For native-USDC economic comparison, start at USD 50 based on dated
2026-09-23 evidence; this does not guarantee AssetFare is cheapest. SOL-input
routes include a swap. USD 1,000 is the primary representative comparison
amount for either route type; always compare at the actual intended amount.

The default USDC path returns one AssetFare candidate, not a cross-provider
market comparison. The evaluator never authenticates a wallet, creates a
session, prepares an action, signs, or submits a transaction.`;
}

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return argv[index + 1];
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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
    signal: AbortSignal.timeout(45_000),
  });
  const text = await response.text();
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

async function verifyManifest(apiBase, publicKeyUrlOverride) {
  const manifest = await jsonRequest(`${apiBase}/.well-known/assetfare-manifest.json`, {}, "manifest");
  const signature = manifest.signature;
  if (signature?.algorithm !== "Ed25519" || !signature.value) {
    throw new Error("manifest has no supported Ed25519 signature");
  }
  const publicKeyUrl = publicKeyUrlOverride || signature.public_key_url;
  if (!publicKeyUrl) throw new Error("manifest has no public key URL");
  const response = await fetch(publicKeyUrl, {
    headers: { "user-agent": "AssetFareAgentRouteEval/1" },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`manifest public key failed: HTTP ${response.status}`);
  const pem = await response.text();
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

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const amountUsd = Number(option(argv, "--amount", DEFAULTS.amount));
  const fromChain = String(option(argv, "--from-chain", DEFAULTS.fromChain)).toLowerCase();
  const fromToken = String(option(argv, "--from-token", DEFAULTS.fromToken)).toUpperCase();
  const toChain = String(option(argv, "--to-chain", DEFAULTS.toChain)).toLowerCase();
  const toToken = String(option(argv, "--to-token", DEFAULTS.toToken)).toUpperCase();
  if (!Number.isFinite(amountUsd) || amountUsd < 1) {
    throw new Error("amount must be a finite USD number of at least 1");
  }
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
  if (status.status !== "capped_public_agent_release" || status.server_signing !== false || status.server_submission !== false) {
    throw new Error("public provider status is not ready");
  }
  const endpointSet = new Set((capabilities.asset_endpoints || []).map((item) => `${item.chain}:${item.token}`));
  if (!endpointSet.has(`${fromChain}:${fromToken}`) || !endpointSet.has(`${toChain}:${toToken}`)) {
    throw new Error("requested chain/token endpoint is unsupported");
  }

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
  if (quote.status !== "capped_public_agent_release" || quote.execution?.supported !== true) {
    throw new Error("AssetFare quote is not executable under the current public release");
  }
  const continuation = parseContinuation(quote);
  const expiresAt = new Date(Date.parse(quote.as_of) + Number(quote.ttl_seconds) * 1000).toISOString();
  const output = {
    status: "pass",
    evaluation_kind: "read_only_assetfare_candidate_quote",
    requested_intent: { from_chain: fromChain, from_token: fromToken, to_chain: toChain, to_token: toToken, amount_usd: amountUsd },
    economic_evaluation: {
      api_minimum_usd: 1,
      one_dollar_purpose: "reachability_and_schema_smoke_only",
      native_usdc_comparison_start_usd: 50,
      evidence_as_of: "2026-09-23",
      cheapest_guaranteed: false,
      sol_input_includes_swap: fromToken === "SOL",
      representative_comparison_amount_usd: 1000,
      always_compare_at_intended_amount: true,
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
      reason: toToken === "USDC"
        ? "This USDC path returns one AssetFare candidate, not a cross-provider market comparison. Compare fresh executable alternatives at the intended amount."
        : "same-input Relay/Mayan comparison is currently implemented only for solana:SOL -> base:ETH",
    },
    continuation,
    safety: {
      wallet_authentication_performed: false,
      session_created: false,
      action_prepared: false,
      transaction_signed: false,
      transaction_submitted: false,
      requote_before_execution: true,
    },
  };

  const comparable = fromChain === "solana" && fromToken === "SOL" && toChain === "base" && toToken === "ETH";
  if (comparable && !argv.includes("--assetfare-only")) {
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
      warning: "Comparison uses placeholder public addresses and is not an executable order. Requote every provider with the caller's real addresses before selection or signing.",
    };
  }

  console.log(JSON.stringify(output, null, argv.includes("--compact") ? 0 : 2));
}

if (isMain(import.meta.url)) main().catch((error) => {
  console.error(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : "unknown error" }));
  process.exitCode = 1;
});
