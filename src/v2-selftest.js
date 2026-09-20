#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { V2_MAX_RESPONSE_BYTES, V2_TIMEOUT_MS, createServer, serverCard } from "./server.js";

const ENDPOINTS = [
  ["solana", "SOL"], ["solana", "USDC"], ["solana", "USDG"],
  ["base", "ETH"], ["base", "USDC"],
  ["arbitrum", "ETH"], ["arbitrum", "USDC"],
  ["robinhood", "ETH"], ["robinhood", "USDG"],
  ["polygon", "USDC"],
  ["optimism", "USDC"],
];
const SOURCE_ONLY = new Set(["polygon", "optimism"]);
const PREPARE_URL = "https://api.assetfare.dev/v2/prepare";
const SESSION_URL = "https://api.assetfare.dev/v2/session";
const REQUEST_FIELDS = ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets", "event_signer_public"];
const SOURCE_ONLY_ROUTES = ["optimism:USDC->arbitrum:USDC", "optimism:USDC->base:USDC", "polygon:USDC->arbitrum:USDC", "polygon:USDC->base:USDC"];
const EXPECTED_KEYWORDS = ["ai-agents", "route-quotes", "cross-chain", "bridge", "swap", "solana", "base", "arbitrum", "robinhood-chain", "polygon", "optimism", "mcp", "a2a", "openapi", "non-custodial"];
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lockMetadata = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const registryMetadata = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
assert.equal(packageMetadata.version, "0.4.3");
assert.equal(lockMetadata.version, "0.4.3");
assert.equal(lockMetadata.packages[""].version, "0.4.3");
assert.equal(registryMetadata.version, "0.4.3");
assert.deepEqual(packageMetadata.keywords, EXPECTED_KEYWORDS);
assert.ok(registryMetadata.description.length <= 100);
assert.match(registryMetadata.description, /Six-chain.*Polygon.*never signs or submits/i);
assert.doesNotMatch(registryMetadata.description, /best|leading|fastest|cheapest/i);

function importedV2Base(extraEnvironment) {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "import('./src/server.js').then((module) => process.stdout.write(module.V2_API_BASE))",
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      ASSETFARE_API_BASE_URL: "http://127.0.0.1:8788",
      ASSETFARE_A2A_API_BASE_URL: "http://127.0.0.1:8791",
      ...extraEnvironment,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

assert.equal(importedV2Base({ ASSETFARE_V2_API_BASE_URL: "" }), "http://127.0.0.1:8791");
assert.equal(importedV2Base({ ASSETFARE_V2_API_BASE_URL: "http://127.0.0.1:8792/" }), "http://127.0.0.1:8792");

function capabilities(overrides = {}) {
  return {
    version: "assetfare-multichain-api-v2",
    status: "capped_public_agent_release",
    public_api_enabled: true,
    chains: ["arbitrum", "base", "optimism", "polygon", "robinhood", "solana"],
    asset_endpoints: ENDPOINTS.map(([chain, token]) => ({ chain, token })),
    source_only_asset_endpoints: [{ chain: "optimism", token: "USDC" }, { chain: "polygon", token: "USDC" }],
    source_only_routes: [...SOURCE_ONLY_ROUTES],
    directed_conversion_routes: 76,
    unsigned_route_plans_ready: 76,
    execution_ready_routes: 76,
    phase_b_blocked_routes: 0,
    blocked_source_only_routes: [],
    server_signing: false,
    server_submission: false,
    ...overrides,
  };
}

const PREPARE_OPTION = { kind: "one_shot_first_unsigned_bundle", method: "POST", url: PREPARE_URL, requires_explicit_caller_approval: true, requires_public_wallet_addresses: true, assetfare_never_signs_submits_or_auto_calls: true, note: "Stateless: returns only the first unsigned bundle." };
const SESSION_OPTION = { kind: "caller_approved_full_workflow_session", method: "POST", url: SESSION_URL, lifecycle_urls: { create: { method: "POST", url: SESSION_URL }, read: { method: "GET", url: `${SESSION_URL}/{session_id}` }, observe_source: { method: "POST", url: `${SESSION_URL}/{session_id}/observe-source` }, observe_output: { method: "POST", url: `${SESSION_URL}/{session_id}/observe-output` }, refresh_action: { method: "POST", url: `${SESSION_URL}/{session_id}/refresh-action` } }, requires_explicit_caller_approval: true, requires_public_wallet_addresses: true, assetfare_never_signs_submits_or_auto_calls: true, note: "Idempotent multi-step lifecycle." };
function executableHandoff() { return { kind: "caller_operated_rest_prepare", url: PREPARE_URL, method: "POST", requires_explicit_caller_approval: true, requires_public_wallet_addresses: true, request_fields: [...REQUEST_FIELDS], assetfare_server_signing: false, assetfare_server_submission: false, caller_must_verify_sign_and_submit: true, requires_fresh_requote: true, automatic_prepare_call_forbidden: true, options: [structuredClone(PREPARE_OPTION), structuredClone(SESSION_OPTION)], note: "Guidance only.", available: true }; }
function quote(intent, overrides = {}) {
  const sourceOnly = SOURCE_ONLY.has(intent.from_chain);
  const fee = 1;
  return {
    quote_id: "00000000-0000-4000-8000-000000000001",
    status: "capped_public_agent_release",
    version: "assetfare-direct-multichain-api-quote-v2",
    as_of: "2026-09-19T00:00:00Z",
    ttl_seconds: 20,
    intent: { from: `${intent.from_chain}:${intent.from_token}`, to: `${intent.to_chain}:${intent.to_token}`, amount_usd: intent.amount_usd, estimated_input_base: 2_500_000 },
    offer: { expected_receive_amount: 2.49, estimated_min_receive_amount: 2.45, output_symbol: intent.to_token, estimated_time_seconds: 23, assetfare_fee_bps: fee, fee_modeled_bps: fee, fee_collectible_now: true, fee_blocker: null, fee_collection_steps: [0], fee_collection: "only_on_eligible_successful_executor_step" },
    route: { steps: [{ index: 0, provider: "fixture" }], server_signing: false, server_submission: false },
    risk: { non_atomic: true, server_signing: false, server_submission: false },
    execution: { supported: true, first_unsigned_action_supported: true, blocker: null },
    caller_action_plan_handoff: executableHandoff(),
    ...overrides,
  };
}

function parse(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "tool returned no text content");
  return JSON.parse(text);
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

function normalizedInputSchema(schema) {
  const value = structuredClone(schema);
  delete value.$schema;
  value.required ||= [];
  return value;
}

const originalFetch = globalThis.fetch;
const calls = [];
let mode = "success";
const validIntent = { from_chain: "robinhood", from_token: "USDG", to_chain: "solana", to_token: "USDC", amount_usd: 2.5 };

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (mode === "network") throw new Error("secret network detail");
  if (mode === "oversized") return new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": String(V2_MAX_RESPONSE_BYTES + 1) } });
  if (mode === "invalid-json") return new Response("<secret>", { status: 200, headers: { "content-type": "text/html" } });
  if (mode === "wrong-content-type") return new Response(JSON.stringify(quote(validIntent)), { status: 200, headers: { "content-type": "text/plain" } });
  if (mode === "unsafe-error") return new Response(JSON.stringify({ error: "SECRET leak\n", reason_class: "unsafe detail!", retry_after_seconds: 99999 }), { status: 502, headers: { "content-type": "application/json" } });
  if (String(url).endsWith("/v2/capabilities")) return Response.json(mode === "unsafe-capabilities" ? capabilities({ server_submission: true }) : mode === "wrong-source-only" ? capabilities({ source_only_routes: ["polygon:USDC->base:USDC", "polygon:USDC->arbitrum:USDC", "optimism:USDC->base:USDC"] }) : capabilities());
  if (String(url).endsWith("/v2/quote")) {
    const intent = JSON.parse(String(init.body));
    if (mode === "nested-signing") { const value = quote(intent); value.offer.server_submission = true; value.route.steps[0].server_signing = true; value.execution.server_submission = true; return Response.json(value); }
    if (mode === "missing-handoff") { const value = quote(intent); delete value.caller_action_plan_handoff; return Response.json(value); }
    if (mode === "null-handoff") return Response.json(quote(intent, { caller_action_plan_handoff: null }));
    if (mode === "array-handoff") return Response.json(quote(intent, { caller_action_plan_handoff: [] }));
    if (mode === "handoff-extra-field") { const value = quote(intent); value.caller_action_plan_handoff.private_key = "leak"; return Response.json(value); }
    if (mode === "handoff-request-fields-reordered") { const value = quote(intent); value.caller_action_plan_handoff.request_fields = ["from_chain", "caller_approved", "from_token", "to_chain", "to_token", "amount_usd", "wallets", "event_signer_public"]; return Response.json(value); }
    if (mode === "handoff-request-fields-short") { const value = quote(intent); value.caller_action_plan_handoff.request_fields = ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets"]; return Response.json(value); }
    if (mode === "handoff-approval-false") { const value = quote(intent); value.caller_action_plan_handoff.requires_explicit_caller_approval = false; return Response.json(value); }
    if (mode === "handoff-server-signs") { const value = quote(intent); value.caller_action_plan_handoff.assetfare_server_signing = true; return Response.json(value); }
    if (mode === "fee-8bp") { const value = quote(intent); value.offer.assetfare_fee_bps = 8; value.offer.fee_modeled_bps = 1; return Response.json(value); }
    if (mode === "fee-2-step") { const value = quote(intent); value.offer.assetfare_fee_bps = 1; value.offer.fee_collection_steps = [0, 0]; return Response.json(value); }
    if (mode === "fee-0-step-for-1bp") { const value = quote(intent); value.offer.assetfare_fee_bps = 1; value.offer.fee_collection_steps = []; return Response.json(value); }
    if (mode === "fee-step-out-of-range") { const value = quote(intent); value.offer.assetfare_fee_bps = 1; value.offer.fee_collection_steps = [7]; return Response.json(value); }
    if (mode === "execution-false-on-executable") { const value = quote(intent); value.execution = { supported: false, first_unsigned_action_supported: false, blocker: "execution_not_ready_phase_b" }; return Response.json(value); }
    if (mode === "source-only-fee-uncollectible") { const value = quote(intent); value.offer.fee_collectible_now = false; return Response.json(value); }
    return Response.json(mode === "unsafe-quote" ? quote(intent, { risk: { server_signing: true, server_submission: false } }) : quote(intent));
  }
  if (String(url).endsWith("/v2/prepare")) return Response.json({ status: "pass", version: "assetfare-direct-multichain-action-v2", workflow_id: "wf-source-only", step_index: 0, unsigned_action: { transaction: "0xUNSIGNED" }, server_signing: false, server_submission: false, signed: false, submitted: false });
  throw new Error(`unexpected upstream URL ${url}`);
};

const server = createServer({ requestIdentity: "203.0.113.10", userAgent: "v2-selftest/1" });
const client = new Client({ name: "assetfare-v2-selftest", version: "0.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const dynamicCapabilities = listed.tools.find((tool) => tool.name === "assetfare_v2_capabilities");
  const dynamicQuote = listed.tools.find((tool) => tool.name === "assetfare_v2_quote");
  const card = serverCard();
  const staticCapabilities = card.tools.find((tool) => tool.name === "assetfare_v2_capabilities");
  const staticQuote = card.tools.find((tool) => tool.name === "assetfare_v2_quote");
  assert.equal(listed.tools.length, 22);
  assert.equal(card.serverInfo.version, "0.4.3");
  assert.equal(card.tools.length, 22);
  // Every dynamic tool has a matching static server-card entry with the same description.
  const dynamicNames = new Set(listed.tools.map((tool) => tool.name));
  const staticNames = new Set(card.tools.map((tool) => tool.name));
  assert.equal(dynamicNames.size, 22);
  assert.deepEqual([...dynamicNames].sort(), [...staticNames].sort());
  const newTools = ["assetfare_v2_new_session_capability", "assetfare_v2_prepare", "assetfare_v2_session_create", "assetfare_v2_session_get", "assetfare_v2_session_observe_source", "assetfare_v2_session_observe_output", "assetfare_v2_session_refresh_action"];
  for (const name of newTools) assert.ok(dynamicNames.has(name), `missing new tool ${name}`);
  // The v2 tool descriptions must be identical between the live tool list and the static server card.
  for (const name of ["assetfare_v2_capabilities", "assetfare_v2_quote", ...newTools]) assert.equal(listed.tools.find((tool) => tool.name === name).description, card.tools.find((item) => item.name === name).description, `description drift for ${name}`);
  assert.equal(dynamicCapabilities.description, staticCapabilities.description);
  assert.equal(dynamicQuote.description, staticQuote.description);
  assert.deepEqual(normalizedInputSchema(dynamicCapabilities.inputSchema), normalizedInputSchema(staticCapabilities.inputSchema));
  assert.deepEqual(normalizedInputSchema(dynamicQuote.inputSchema), normalizedInputSchema(staticQuote.inputSchema));
  assert.deepEqual(dynamicQuote.inputSchema.properties.from_chain.enum, ["solana", "base", "arbitrum", "robinhood", "polygon", "optimism"]);
  assert.equal(dynamicQuote.inputSchema.additionalProperties, false);
  assert.equal(V2_TIMEOUT_MS, 45_000);
  assert.equal(V2_MAX_RESPONSE_BYTES, 1_048_576);
  // Quote/capabilities tools never take a wallet, token, or signature input.
  const forbidden = new Set(["wallets", "wallet", "access_token", "token", "idempotency_key", "session_id", "event_signer_public", "signature", "transaction_hash"]);
  for (const tool of [dynamicCapabilities, dynamicQuote]) {
    for (const key of Object.keys(tool.inputSchema.properties || {})) assert.ok(!forbidden.has(key), `forbidden v2 input ${key}`);
  }

  const invalidCapabilities = await call(client, "assetfare_v2_capabilities", { extra: "forbidden" });
  assert.equal(invalidCapabilities.isError, true);
  assert.equal(calls.length, 0, "invalid capabilities input reached upstream");
  const capabilityValue = parse(await call(client, "assetfare_v2_capabilities", {}));
  assert.equal(capabilityValue.asset_endpoints.length, 11);
  assert.equal(capabilityValue.directed_conversion_routes, 76);
  assert.equal(capabilityValue.execution_ready_routes, 76);
  assert.equal(capabilityValue.phase_b_blocked_routes, 0);
  assert.deepEqual(capabilityValue.blocked_source_only_routes, []);

  let quoteValue;
  let sourceOnlyQuoteValue;
  let routeCount = 0;
  let sourceOnlyCount = 0;
  const destinations = ENDPOINTS.filter(([chain]) => !SOURCE_ONLY.has(chain));
  for (const [from_chain, from_token] of ENDPOINTS) {
    for (const [to_chain, to_token] of destinations) {
      if (from_chain === to_chain && from_token === to_token) continue;
      if (SOURCE_ONLY.has(from_chain) && !(from_token === "USDC" && ["base", "arbitrum"].includes(to_chain) && to_token === "USDC")) continue;
      const intent = { from_chain, from_token, to_chain, to_token, amount_usd: 2.5 };
      const quoteResult = await call(client, "assetfare_v2_quote", intent);
      assert.equal(quoteResult.isError, false, `valid route rejected: ${JSON.stringify(intent)}`);
      const value = parse(quoteResult);
      assert.equal(value.intent.from, `${from_chain}:${from_token}`);
      assert.equal(value.intent.to, `${to_chain}:${to_token}`);
      // Every supported route has the same caller-approved non-custodial execution handoff.
      if (SOURCE_ONLY.has(from_chain)) {
        assert.equal(value.execution.supported, true);
        assert.equal(value.caller_action_plan_handoff.available, true);
        assert.equal(value.offer.assetfare_fee_bps, 1);
        assert.equal(value.offer.fee_collectible_now, true);
        sourceOnlyQuoteValue = value;
        sourceOnlyCount += 1;
      }
      assert.equal(value.execution.supported, true);
      assert.equal(value.execution.first_unsigned_action_supported, true);
      assert.equal(value.caller_action_plan_handoff.available, true);
      assert.equal(value.caller_action_plan_handoff.url, PREPARE_URL);
      assert.equal(value.caller_action_plan_handoff.options.length, 2);
      assert.deepEqual(value.caller_action_plan_handoff.request_fields, REQUEST_FIELDS);
      assert.equal(value.guidance.caller_action_plan.mcp_tools.one_shot_prepare, "assetfare_v2_prepare");
      assert.equal(value.guidance.caller_action_plan.rest_endpoints.prepare, PREPARE_URL);
      if (from_chain === validIntent.from_chain && from_token === validIntent.from_token && to_chain === validIntent.to_chain && to_token === validIntent.to_token) quoteValue = value;
      routeCount += 1;
    }
  }
  assert.equal(routeCount, 76);
  assert.equal(sourceOnlyCount, 4);
  assert.ok(quoteValue && sourceOnlyQuoteValue);
  assert.equal(quoteValue.guidance.transactionSigned, false);
  assert.equal(quoteValue.guidance.transactionSubmitted, false);

  assert.equal(calls.length, 77);
  assert.equal(calls[0].url, "https://api.assetfare.dev/v2/capabilities");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls.slice(1).filter((item) => item.url.endsWith("/v2/quote") && item.init.method === "POST").length, 76);
  for (const item of calls) {
    assert.equal(item.init.redirect, "error");
    assert.ok(item.init.signal instanceof AbortSignal);
    assert.equal(item.init.headers["x-assetfare-channel"], "mcp");
    assert.equal(item.init.headers["x-forwarded-for"], "203.0.113.10");
    assert.equal(item.init.headers.authorization, undefined);
  }

  const invalid = [
    { ...validIntent, from_chain: "base", from_token: "SOL" },
    { ...validIntent, to_chain: "robinhood", to_token: "USDC" },
    { ...validIntent, to_chain: "polygon", to_token: "USDC" },
    { ...validIntent, to_chain: "optimism", to_token: "USDC" },
    { ...validIntent, from_chain: "polygon", from_token: "USDC", to_chain: "solana", to_token: "USDC" },
    { ...validIntent, from_chain: "optimism", from_token: "USDC", to_chain: "solana", to_token: "USDC" },
    { ...validIntent, to_chain: "robinhood", to_token: "USDG", from_chain: "robinhood", from_token: "USDG" },
    { ...validIntent, amount_usd: true },
    { ...validIntent, amount_usd: Number.NaN },
    { ...validIntent, amount_usd: 0.99 },
    { ...validIntent, amount_usd: 1000.01 },
    { ...validIntent, extra: "forbidden" },
  ];
  const beforeInvalid = calls.length;
  for (const args of invalid) {
    const result = await call(client, "assetfare_v2_quote", args);
    assert.equal(result.isError, true, `invalid input accepted: ${JSON.stringify(args)}`);
  }
  assert.equal(calls.length, beforeInvalid, "invalid input reached upstream");

  // Fail-closed handoff / fee / execution hostiles (all on a valid executable route).
  const failClosed = ["missing-handoff", "null-handoff", "array-handoff", "handoff-extra-field", "handoff-request-fields-reordered", "handoff-request-fields-short", "handoff-approval-false", "handoff-server-signs", "fee-8bp", "fee-2-step", "fee-0-step-for-1bp", "fee-step-out-of-range", "execution-false-on-executable"];
  const executableIntent = { from_chain: "base", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 25 };
  for (const failureMode of failClosed) {
    mode = failureMode;
    const result = await call(client, "assetfare_v2_quote", executableIntent);
    assert.equal(result.isError, true, `${failureMode} did not fail closed`);
  }
  // An audited 1bp source-only route claiming the fee is not collectible must fail closed.
  mode = "source-only-fee-uncollectible";
  const feeReadiness = await call(client, "assetfare_v2_quote", { from_chain: "polygon", from_token: "USDC", to_chain: "base", to_token: "USDC", amount_usd: 25 });
  assert.equal(feeReadiness.isError, true, "source-only fee_collectible_now:false was not rejected");

  mode = "success";
  for (const failureMode of ["unsafe-capabilities", "wrong-source-only", "unsafe-quote", "nested-signing", "oversized", "invalid-json", "wrong-content-type", "unsafe-error", "network"]) {
    mode = failureMode;
    const capabilityFailure = ["unsafe-capabilities", "wrong-source-only"].includes(failureMode);
    const result = await call(client, capabilityFailure ? "assetfare_v2_capabilities" : "assetfare_v2_quote", capabilityFailure ? {} : validIntent);
    assert.equal(result.isError, true, `${failureMode} did not fail closed`);
    const value = parse(result);
    const serialized = JSON.stringify(value);
    assert.ok(serialized.length < 1024, `${failureMode} error was unbounded`);
    assert.ok(!serialized.includes("SECRET") && !serialized.includes("secret network detail") && !serialized.includes("unsafe detail"), `${failureMode} leaked upstream detail`);
  }
  mode = "success";

  // Source-only directional routes are execution-ready and reach the caller-approved prepare endpoint.
  const beforePrepare = calls.length;
  const sourceOnlyPrepare = await call(client, "assetfare_v2_prepare", { caller_approved: true, from_chain: "polygon", from_token: "USDC", to_chain: "base", to_token: "USDC", amount_usd: 25, wallets: { polygon: "0x1111111111111111111111111111111111111111", base: "0x2222222222222222222222222222222222222222" } });
  assert.equal(sourceOnlyPrepare.isError, false, "source-only prepare was rejected");
  assert.equal(parse(sourceOnlyPrepare).signed, false);
  assert.equal(calls.length, beforePrepare + 1, "source-only prepare did not reach the approved endpoint exactly once");

  // caller_approved gate: false / missing / string / number rejected BEFORE any network call.
  const badApproval = [
    { caller_approved: false, from_chain: "base", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 25, wallets: { base: "0x1111111111111111111111111111111111111111", arbitrum: "0x2222222222222222222222222222222222222222" } },
    { from_chain: "base", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 25, wallets: { base: "0x1111111111111111111111111111111111111111", arbitrum: "0x2222222222222222222222222222222222222222" } },
    { caller_approved: "true", from_chain: "base", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 25, wallets: { base: "0x1111111111111111111111111111111111111111", arbitrum: "0x2222222222222222222222222222222222222222" } },
    { caller_approved: 1, from_chain: "base", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 25, wallets: { base: "0x1111111111111111111111111111111111111111", arbitrum: "0x2222222222222222222222222222222222222222" } },
  ];
  const beforeApproval = calls.length;
  for (const args of badApproval) {
    const result = await call(client, "assetfare_v2_prepare", args);
    assert.equal(result.isError, true, `caller_approved gate accepted ${JSON.stringify(args.caller_approved)}`);
  }
  assert.equal(calls.length, beforeApproval, "caller_approved hostile reached upstream");

  // A private-key-shaped wallet value (64-hex secret, not a public address) is rejected before any network call.
  const beforeSecret = calls.length;
  const secretPrepare = await call(client, "assetfare_v2_prepare", { caller_approved: true, from_chain: "base", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 25, wallets: { base: "0x1111111111111111111111111111111111111111", arbitrum: "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" } });
  assert.equal(secretPrepare.isError, true, "prepare accepted a non-public-address (private-key-shaped) wallet value");
  assert.equal(calls.length, beforeSecret, "secret-material hostile reached upstream");

  // Local token generator makes no network call and returns a sensitive, non-private-key capability.
  const beforeToken = calls.length;
  const token = parse(await call(client, "assetfare_v2_new_session_capability", {}));
  assert.equal(calls.length, beforeToken, "token generation made a network call");
  assert.match(token.session_token, /^[A-Za-z0-9_-]{43,128}$/);
  assert.equal(token.is_private_key, false);
  assert.equal(token.sensitivity, "sensitive_capability");
  const token2 = parse(await call(client, "assetfare_v2_new_session_capability", {}));
  assert.notEqual(token.session_token, token2.session_token, "token generator must be non-deterministic");

  assert.ok(calls.every((item) => item.url.endsWith("/v2/capabilities") || item.url.endsWith("/v2/quote") || item.url.endsWith("/v2/prepare")), "v2 tools reached an unauthorized path");
  console.log(JSON.stringify({ status: "pass", version: packageMetadata.version, tool_count: listed.tools.length, valid_routes: routeCount, source_only_routes: sourceOnlyCount, upstream_calls_for_matrix: 77, fail_closed_hostiles: failClosed.length, caller_approved_hostiles: badApproval.length, signed: false, submitted: false }));
} finally {
  globalThis.fetch = originalFetch;
  await client.close();
  await server.close();
}
