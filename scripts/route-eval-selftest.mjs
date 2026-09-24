#!/usr/bin/env node
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { parseContinuation } from "./route-eval.mjs";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const observed = [];
let origin;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin);
  const rawBody = await readBody(request);
  observed.push({ method: request.method, path: url.pathname, body: rawBody, query: Object.fromEntries(url.searchParams) });
  const send = (status, value, contentType = "application/json") => {
    response.writeHead(status, { "content-type": contentType });
    response.end(contentType === "application/json" ? JSON.stringify(value) : value);
  };
  if (url.pathname === "/manifest.pub") return send(200, publicPem, "text/plain");
  if (url.pathname === "/.well-known/assetfare-manifest.json") {
    const manifest = {
      service: "AssetFare",
      release_commit: "selftest",
      valid_until: new Date(Date.now() + 60_000).toISOString(),
      execution: { multichain_v2: { release_status: "capped_public_agent_release" } },
    };
    const signature = sign(null, Buffer.from(canonical(manifest)), privateKey).toString("base64");
    return send(200, { ...manifest, signature: { algorithm: "Ed25519", key_id: "selftest", public_key_url: `${origin}/manifest.pub`, value: signature } });
  }
  if (url.pathname === "/v2/capabilities") return send(200, {
    public_api_enabled: true,
    server_signing: false,
    server_submission: false,
    asset_endpoints: [{ chain: "solana", token: "SOL" }, { chain: "solana", token: "USDC" }, { chain: "base", token: "USDC" }],
  });
  if (url.pathname === "/v2/status") return send(200, { status: "capped_public_agent_release", server_signing: false, server_submission: false });
  if (url.pathname === "/v2/quote") {
    const intent = JSON.parse(rawBody);
    return send(200, {
      quote_id: "quote-selftest",
      status: "capped_public_agent_release",
      as_of: new Date().toISOString(),
      ttl_seconds: 20,
      intent: { from: `${intent.from_chain}:${intent.from_token}`, to: `${intent.to_chain}:${intent.to_token}`, amount_usd: intent.amount_usd, estimated_input_base: 10000000 },
      offer: { expected_receive_amount: intent.amount_usd - 0.0001, estimated_min_receive_amount: intent.amount_usd - 0.0051, output_symbol: "USDC", expected_receive_usd: intent.amount_usd - 0.0001, estimated_min_receive_usd: intent.amount_usd - 0.0051, estimated_time_seconds: 21, assetfare_fee_bps: 1 },
      route: { steps: [{ provider: "selftest" }] },
      risk: { non_atomic: true, server_signing: false, server_submission: false },
      execution: { supported: true },
      handoff_schema_version: 2,
      caller_action_plan_handoff_v2: {
        kind: "caller_operated_rest_prepare",
        method: "POST",
        url: "https://api.assetfare.dev/v2/prepare",
        schema_version: 2,
        selection: "choose_exactly_one",
        mutually_exclusive: true,
        do_not_call_both: true,
        selection_before_signing: true,
        once_any_action_submitted_do_not_start_other_mode: true,
        requires_explicit_caller_approval: true,
        requires_public_wallet_addresses: true,
        assetfare_server_signing: false,
        assetfare_server_submission: false,
        caller_must_verify_sign_and_submit: true,
        requires_fresh_requote: true,
        automatic_prepare_call_forbidden: true,
        available: true,
        options: [
          {
            kind: "one_shot_first_unsigned_bundle",
            method: "POST",
            url: "https://api.assetfare.dev/v2/prepare",
            requires_explicit_caller_approval: true,
            requires_public_wallet_addresses: true,
            assetfare_never_signs_submits_or_auto_calls: true,
            preview_or_manual_first_action_only: true,
            not_a_session: true,
            do_not_start_session_after_submission: true,
          },
          {
            kind: "caller_approved_full_workflow_session",
            method: "POST",
            url: "https://api.assetfare.dev/v2/session",
            requires_explicit_caller_approval: true,
            requires_public_wallet_addresses: true,
            assetfare_never_signs_submits_or_auto_calls: true,
            recommended_for_multistep: true,
          },
        ],
      },
    });
  }
  if (url.pathname === "/relay") return send(200, { details: { currencyOut: { amountFormatted: "0.000335", minimumAmount: "325000000000000", currency: { decimals: 18, symbol: "ETH" } }, timeEstimate: 2 } });
  if (url.pathname === "/mayan") return send(200, { quotes: [{ expectedAmountOut: "0.000332", minAmountOut: "0.00032", etaSeconds: 3, type: "MCTP" }] });
  return send(404, { error: "not_found" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;

const child = spawn(process.execPath, [new URL("./route-eval.mjs", import.meta.url).pathname, "--compact"], {
  env: {
    ...process.env,
    ASSETFARE_API_BASE: origin,
    ASSETFARE_MANIFEST_PUBLIC_KEY_URL: `${origin}/manifest.pub`,
    ASSETFARE_RELAY_QUOTE_URL: `${origin}/relay`,
    ASSETFARE_MAYAN_QUOTE_URL: `${origin}/mayan`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve) => child.on("close", resolve));
server.close();

if (exitCode !== 0) throw new Error(`route evaluator exited ${exitCode}: ${stderr}`);
const result = JSON.parse(stdout);
const quoteRequest = observed.find((item) => item.path === "/v2/quote");
const relayRequest = observed.find((item) => item.path === "/relay");
const mayanRequest = observed.find((item) => item.path === "/mayan");
const checks = {
  status_pass: result.status === "pass",
  manifest_verified: result.manifest?.valid === true,
  quote_read_only: result.safety?.wallet_authentication_performed === false && result.safety?.session_created === false && result.safety?.action_prepared === false && result.safety?.transaction_signed === false && result.safety?.transaction_submitted === false,
  representative_default_posted: quoteRequest?.method === "POST" && JSON.parse(quoteRequest.body).from_token === "USDC" && JSON.parse(quoteRequest.body).to_token === "USDC" && JSON.parse(quoteRequest.body).amount_usd === 1000,
  usdc_default_is_single_assetfare_candidate: result.requested_intent?.from_token === "USDC" && result.requested_intent?.to_token === "USDC" && result.alternatives?.status === "not_requested" && /not a cross-provider market comparison/i.test(result.alternatives?.reason || ""),
  economic_guidance: result.economic_evaluation?.api_minimum_usd === 1 && result.economic_evaluation?.one_dollar_purpose === "reachability_and_schema_smoke_only" && result.economic_evaluation?.native_usdc_comparison_start_usd === 50 && result.economic_evaluation?.representative_comparison_amount_usd === 1000 && result.economic_evaluation?.cheapest_guaranteed === false && result.economic_evaluation?.always_compare_at_intended_amount === true,
  continuation_preserved: result.continuation?.decision_required === "explicit_caller_approval" && result.continuation?.quote_authorizes_execution === false && result.continuation?.choose_exactly_one_mode === true && result.continuation?.automatic_prepare_forbidden === true && result.continuation?.full_openapi_url === "https://api.assetfare.dev/v2/openapi.json" && result.continuation?.server_signing === false && result.continuation?.server_submission === false && result.continuation?.caller_action_plan_handoff_v2?.schema_version === 2,
  no_false_eth_comparison: relayRequest === undefined && mayanRequest === undefined,
};
const validQuote = {
  handoff_schema_version: 2,
  caller_action_plan_handoff_v2: result.continuation?.caller_action_plan_handoff_v2,
};
const hostileMutations = [
  (quote) => { quote.handoff_schema_version = 3; },
  (quote) => { quote.caller_action_plan_handoff_v2.assetfare_server_signing = true; },
  (quote) => { quote.caller_action_plan_handoff_v2.automatic_prepare_call_forbidden = false; },
  (quote) => { quote.caller_action_plan_handoff_v2.selection = "call_both"; },
  (quote) => { quote.caller_action_plan_handoff_v2.options[0].url = "https://evil.example/prepare"; },
  (quote) => { quote.caller_action_plan_handoff_v2.options[1].recommended_for_multistep = false; },
];
checks.hostile_continuations_rejected = hostileMutations.every((mutate) => {
  const hostile = structuredClone(validQuote);
  mutate(hostile);
  try {
    parseContinuation(hostile);
    return false;
  } catch {
    return true;
  }
});
if (!Object.values(checks).every(Boolean)) throw new Error(JSON.stringify({ checks, observed, result }, null, 2));
console.log(JSON.stringify({ status: "pass", checks }));
