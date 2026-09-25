#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DIRECT_ROUTE_CONTRACT_COUNTS, V2_MAX_RESPONSE_BYTES, V2_TIMEOUT_MS, createServer, serverCard } from "./server.js";
import { approvalFor, attachContinuation, continuationCapability } from "../test/continuation-fixture.mjs";

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
const EXPECTED_KEYWORDS = ["ai-agents", "agent-wallet-funding", "payment-wallet-funding", "x402-wallet-funding", "route-quotes", "cross-chain", "cross-chain-swap", "bridge", "usdc-bridge", "native-usdc", "solana-usdc", "base-usdc", "unsigned-transaction-plan", "caller-signed", "cctp", "solana-to-base", "usdc", "swap", "solana", "base", "arbitrum", "robinhood-chain", "polygon", "optimism", "mcp", "a2a", "openapi", "non-custodial"];
const BUNDLE_VERSION = "assetfare-direct-multichain-action-v2";
const BUNDLE_HASH_SPEC = "sha256(UTF-8 JSON with sorted keys and compact separators, excluding payload_sha256 itself)";
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function hashBundle(value) { return createHash("sha256").update(canonical(value), "utf8").digest("hex"); }
function prepareBundle() {
  const value = { status: "pass", version: BUNDLE_VERSION, workflow_id: "00000000-0000-4000-8000-000000000010", action_id:"00000000-0000-4000-8000-000000000011", step_index: 0, expires_at:"2099-01-01T00:00:00Z", payload_sha256_spec:BUNDLE_HASH_SPEC, unsigned_action: { transaction: "0xUNSIGNED", signed:false, submitted:false,safety_receipt:{schema:"https://assetfare.dev/schemas/action-safety-receipt-v1",schema_version:1,generation:"decoded_built_action_only",custody:{server_signing:false,server_submission:false},payload_binding:{action_sha256:"fixture",raw_payloads:[]}} }, server_signing: false, server_submission: false, signed: false, submitted: false };
  value.payload_sha256 = hashBundle(value);
  return value;
}
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lockUrl=new URL("../package-lock.json",import.meta.url),lockMetadata=existsSync(lockUrl)?JSON.parse(readFileSync(lockUrl,"utf8")):null;
const registryMetadata = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
const bridgeRegistryUrl=new URL("../server.bridge.json",import.meta.url),bridgeRegistryMetadata=existsSync(bridgeRegistryUrl)?JSON.parse(readFileSync(bridgeRegistryUrl,"utf8")):null;
const directRouteContract = JSON.parse(readFileSync(new URL("./direct-route-contract.json", import.meta.url), "utf8"));
const readmeMetadata = readFileSync(new URL("../README.md", import.meta.url), "utf8");
assert.equal(packageMetadata.version, "1.3.3");
if(lockMetadata){assert.equal(lockMetadata.version, "1.3.3");assert.equal(lockMetadata.packages[""].version, "1.3.3");}
assert.equal(registryMetadata.version, "1.3.3");
if(bridgeRegistryMetadata)assert.equal(bridgeRegistryMetadata.version, "1.3.3");
assert.deepEqual(DIRECT_ROUTE_CONTRACT_COUNTS, { routes:76, steps:168 });
assert.equal(directRouteContract.route_count,76);
assert.equal(directRouteContract.step_count,168);
assert.deepEqual(packageMetadata.keywords, EXPECTED_KEYWORDS);
assert.match(packageMetadata.description, /Solana USDC to Base USDC/i);
for (const keyword of ["native-usdc","solana-usdc","base-usdc","unsigned-transaction-plan","caller-signed"]) assert.ok(packageMetadata.keywords.includes(keyword));
assert.match(packageMetadata.description, /1bp service fee plus Circle\/provider\/network fees/i);
assert.doesNotMatch(packageMetadata.description, /flat[ -]?1 ?bp|execution-ready/i);
assert.match(packageMetadata.description, /never signs or submits/i);
assert.ok(registryMetadata.description.length <= 100);
assert.match(registryMetadata.description, /76-route USDC bridge.*quote-bound approval.*unsigned.*never signs or submits/i);
assert.doesNotMatch(registryMetadata.description, /flat[ -]?1 ?bp|execution-ready/i);
assert.doesNotMatch(registryMetadata.description, /best|leading|fastest|cheapest/i);
assert.match(readmeMetadata.slice(0, 2500), /Solana native USDC → Base native USDC/is);
assert.match(readmeMetadata.slice(0, 2500).replace(/\s+/g, " "), /AssetFare service fee 1bp; Circle\/provider\/network fees additional; quote exposes total token-path cost and live availability/i);
assert.doesNotMatch(readmeMetadata, /flat[ -]?1 ?bp|execution-ready/i);
assert.match(readmeMetadata, /--to-chain base --to-token USDC/);
assert.match(readmeMetadata, /assetfare-route-eval[\s\S]{0,500}--quote-output quote\.json[\s\S]{0,1200}assetfare-plan[\s\S]{0,400}--select-exact-quote-bounds/);
assert.match(readmeMetadata, /custom stricter bounds[\s\S]{0,300}assetfare-select[\s\S]{0,300}--approval approval\.json/);

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
    execution_implemented_routes: 76,
    currently_prepare_ready_routes: 76,
    temporarily_unavailable_routes: [],
    temporarily_unavailable_route_count: 0,
    execution_availability: {status:"available",provider:"circle_iris",provider_dependent_routes:50,recent_fee_snapshot_usable:true,guarantees_future_availability:false},
    direct_route_summary:{version:"assetfare-direct-route-summary-v1",required_on_every_quote:true,route_count:76,step_count:168,ordered_provider_path:true,normalized_chain_asset_endpoints:true,base_unit_amounts_are_decimal_strings:true,assetfare_fee_step_bound:true,classification_values:["direct_protocol_only","external_intent"],route_aggregator_used_scope:"assetfare_engine_only",external_intent:"Across only for Robinhood ingress; provider-internal liquidity sourcing or aggregation remains possible",server_signing:false,server_submission:false},
    continuation_v3:continuationCapability(),
    phase_b_blocked_routes: 0,
    blocked_source_only_routes: [],
    server_signing: false,
    server_submission: false,
    ...overrides,
  };
}

const PREPARE_OPTION = { kind: "one_shot_first_unsigned_bundle", method: "POST", url: PREPARE_URL, requires_explicit_caller_approval: true, requires_public_wallet_addresses: true, assetfare_never_signs_submits_or_auto_calls: true, note: "Stateless: returns only the first unsigned bundle." };
const SESSION_OPTION = { kind: "caller_approved_full_workflow_session", method: "POST", url: SESSION_URL, lifecycle_urls: { create: { method: "POST", url: SESSION_URL }, read: { method: "GET", url: `${SESSION_URL}/{session_id}` }, observe_source: { method: "POST", url: `${SESSION_URL}/{session_id}/observe-source` }, observe_output: { method: "POST", url: `${SESSION_URL}/{session_id}/observe-output` }, refresh_action: { method: "POST", url: `${SESSION_URL}/{session_id}/refresh-action` } }, requires_explicit_caller_approval: true, requires_public_wallet_addresses: true, assetfare_never_signs_submits_or_auto_calls: true, note: "Idempotent multi-step lifecycle." };
const PREPARE_OPTION_V2 = { ...structuredClone(PREPARE_OPTION), preview_or_manual_first_action_only: true, not_a_session: true, do_not_start_session_after_submission: true };
const SESSION_OPTION_V2 = { ...structuredClone(SESSION_OPTION), recommended_for_multistep: true };
function executableHandoff() { return { kind: "caller_operated_rest_prepare", url: PREPARE_URL, method: "POST", requires_explicit_caller_approval: true, requires_public_wallet_addresses: true, request_fields: [...REQUEST_FIELDS], assetfare_server_signing: false, assetfare_server_submission: false, caller_must_verify_sign_and_submit: true, requires_fresh_requote: true, automatic_prepare_call_forbidden: true, options: [structuredClone(PREPARE_OPTION), structuredClone(SESSION_OPTION)], note: "Guidance only.", available: true }; }
function executableHandoffV2() { return { kind: "caller_operated_rest_prepare", url: PREPARE_URL, method: "POST", requires_explicit_caller_approval: true, requires_public_wallet_addresses: true, request_fields: [...REQUEST_FIELDS], assetfare_server_signing: false, assetfare_server_submission: false, caller_must_verify_sign_and_submit: true, requires_fresh_requote: true, automatic_prepare_call_forbidden: true, schema_version: 2, selection: "choose_exactly_one", mutually_exclusive: true, do_not_call_both: true, selection_before_signing: true, once_any_action_submitted_do_not_start_other_mode: true, enforcement: "advisory_caller_side", options: [structuredClone(PREPARE_OPTION_V2), structuredClone(SESSION_OPTION_V2)], note: "Machine-readable v2.", available: true }; }
function quote(intent, overrides = {}) {
  const sourceOnly = SOURCE_ONLY.has(intent.from_chain);
  const fee = 1;
  const expectedReceive = Math.max(.000001, intent.amount_usd - .01);
  const minimumReceive = Math.max(.000001, intent.amount_usd - .05);
  const expectedCost = intent.amount_usd - expectedReceive;
  const maximumCost = intent.amount_usd - minimumReceive;
  const smallWarning=maximumCost/intent.amount_usd>=.01;
  const routeName=`${intent.from_chain}:${intent.from_token}->${intent.to_chain}:${intent.to_token}`,contract=directRouteContract.routes[routeName];
  assert.ok(contract,`missing direct route contract ${routeName}`);
  let expectedInput=2_500_000,minimumInput=2_500_000;
  const summarySteps=[],rawSteps=[];
  for(const planned of contract.steps){
    const expectedOutput=Math.max(1,expectedInput-1_000),minimumOutput=Math.max(1,minimumInput-2_000),[fromChain,fromAsset]=planned.from.split(":"),[toChain,toAsset]=planned.to.split(":");
    const evidence={status:"pass",inputAmount:String(expectedInput),aggregatorApiUsed:false,signed:false,submitted:false};
    let raw;
    if(planned.action==="swap")raw={kind:"direct_swap",chain:fromChain,provider:planned.provider,from:fromAsset,to:toAsset,route_fee_bps:planned.assetfare_fee_bps};
    else if(planned.provider==="across_intent_bridge")raw={kind:"direct_bridge",provider:planned.provider,from:fromChain,to:toChain,from_asset:fromAsset,to_asset:toAsset,external_intent_protocol:true,route_fee_bps:planned.assetfare_fee_bps};
    else raw={kind:"direct_bridge",provider:planned.provider,from:fromChain,to:toChain,asset:fromAsset,route_fee_bps:planned.assetfare_fee_bps,...(planned.provider==="circle_cctp"&&["polygon","optimism"].includes(fromChain)?{cctp_mode:"no_forward",finality_threshold:2000,destination_native_gas_required:true,economics_informational_only:true}:{})};
    rawSteps.push({index:planned.index,...raw,expected_input_base:expectedInput,floor_input_base:minimumInput,expected_output_base:expectedOutput,minimum_output_base:minimumOutput,expected_evidence:evidence,floor_evidence:null});
    summarySteps.push({...planned,expected_input_base:String(expectedInput),minimum_input_base:String(minimumInput),expected_output_base:String(expectedOutput),minimum_output_base:String(minimumOutput),aggregator_api_used:false});
    expectedInput=expectedOutput;minimumInput=minimumOutput;
  }
  const external=contract.classification==="external_intent",feeIndex=contract.steps.findIndex((step)=>step.assetfare_fee_bps===1);
  return attachContinuation({
    quote_id: "00000000-0000-4000-8000-000000000001",
    status: "capped_public_agent_release",
    version: "assetfare-direct-multichain-api-quote-v2",
    as_of: "2026-09-19T00:00:00Z",
    ttl_seconds: 60,
    intent: { from: `${intent.from_chain}:${intent.from_token}`, to: `${intent.to_chain}:${intent.to_token}`, amount_usd: intent.amount_usd, estimated_input_base: 2_500_000 },
    cost_summary:{scope:"token_path_only_network_gas_excluded",input_value_usd:intent.amount_usd,expected_receive_value_usd:expectedReceive,minimum_receive_value_usd:minimumReceive,expected_total_cost_usd:expectedCost,maximum_total_cost_usd:maximumCost,expected_total_cost_percent:expectedCost/intent.amount_usd*100,maximum_total_cost_percent:maximumCost/intent.amount_usd*100,assetfare_service_fee:{bps:1,estimated_usd:intent.amount_usd/10000,included_in_receive_amount:true,note:"AssetFare service fee only; not total"},provider_fee_components:[],unpriced_costs:["source_chain_network_fee"],rankable_all_in:false,small_amount_warning:smallWarning,warning:smallWarning?"fixed provider fee":null},
    eta:{estimated_time_seconds:23,estimated_time_range_seconds:[8,23],complete_route_estimate:true,sources:["https://github.com/circlefin/cctp-go/blob/main/transfer.go"],note:"estimate"},
    offer: { expected_receive_amount: expectedReceive, estimated_min_receive_amount: minimumReceive, expected_receive_usd:expectedReceive, estimated_min_receive_usd:minimumReceive, output_symbol: intent.to_token, estimated_time_seconds: 23, assetfare_fee_bps: fee, fee_modeled_bps: fee, fee_collectible_now: true, fee_blocker: null, fee_collection_steps: [feeIndex], fee_collection: "only_on_eligible_successful_executor_step" },
    route: { status:"pass",version:"assetfare-direct-multichain-quote-v2",route:routeName,mode:contract.mode,input_base:2_500_000,expected_output_base:expectedInput,minimum_output_base:minimumInput,steps:rawSteps,quote_latency_ms:1,aggregator_api_used:false,external_intent_protocol_used:external,server_signing:false,server_submission:false },
    direct_route_summary:{version:"assetfare-direct-route-summary-v1",route:routeName,from:`${intent.from_chain}:${intent.from_token}`,to:`${intent.to_chain}:${intent.to_token}`,classification:contract.classification,mode:contract.mode,route_aggregator_used:false,external_intent_protocol_used:external,provider_internal_dex_aggregation_possible:external,assetfare_fee_bps:1,fee_collection_step_index:feeIndex,server_signing:false,server_submission:false,step_count:summarySteps.length,steps:summarySteps},
    risk: { non_atomic: true, external_intent_protocol_used:external, provider_internal_dex_aggregation_possible:external, server_signing: false, server_submission: false },
    execution: { supported: true, first_unsigned_action_supported: true, blocker: null },
    caller_action_plan_handoff: executableHandoff(),
    caller_action_plan_handoff_v2: executableHandoffV2(),
    handoff_schema_version: 2,
    ...overrides,
  });
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
  if (String(url).endsWith("/v2/capabilities")) {if(mode==="missing-direct-summary-contract"){const value=capabilities();delete value.direct_route_summary;return Response.json(value);}if(mode==="missing-continuation-contract"){const value=capabilities();delete value.continuation_v3;return Response.json(value);}if(mode==="wrong-continuation-contract")return Response.json(capabilities({continuation_v3:{...continuationCapability(),automatic_selection_forbidden:false}}));if(mode==="wrong-continuation-hash-spec")return Response.json(capabilities({continuation_v3:{...continuationCapability(),quote_payload_sha256_spec:"sha256(JSON.stringify(quote))"}}));if(mode==="wrong-direct-summary-contract")return Response.json(capabilities({direct_route_summary:{...capabilities().direct_route_summary,step_count:167}}));if(mode==="wrong-direct-summary-scope")return Response.json(capabilities({direct_route_summary:{...capabilities().direct_route_summary,external_intent:"No external provider"}}));return Response.json(mode === "unsafe-capabilities" ? capabilities({ server_submission: true }) : mode === "wrong-source-only" ? capabilities({ source_only_routes: ["polygon:USDC->base:USDC", "polygon:USDC->arbitrum:USDC", "optimism:USDC->base:USDC"] }) : mode === "partial-current-availability" ? (()=>{const value=capabilities();delete value.execution_availability;return value;})() : mode === "fake-unavailable-route" ? capabilities({currently_prepare_ready_routes:75,temporarily_unavailable_routes:["evil:USDC->base:USDC"],temporarily_unavailable_route_count:1,execution_availability:{status:"degraded",provider:"circle_iris",provider_dependent_routes:50,recent_fee_snapshot_usable:false,guarantees_future_availability:false}}) : mode === "availability-status-inconsistent" ? capabilities({execution_availability:{status:"degraded",provider:"circle_iris",provider_dependent_routes:50,recent_fee_snapshot_usable:true,guarantees_future_availability:false}}) : capabilities());}
  if (String(url).endsWith("/v2/quote")) {
    const intent = JSON.parse(String(init.body));
    if (mode === "nested-signing") { const value = quote(intent); value.offer.server_submission = true; value.route.steps[0].server_signing = true; value.execution.server_submission = true; return Response.json(value); }
    if(mode==="quote-private-key"){const value=quote(intent);value.route.steps[0].private_key="secret";return Response.json(value);}
    if(mode==="quote-seed-phrase"){const value=quote(intent);value.route.steps[0].seedPhrase="alpha beta gamma";return Response.json(value);}
    if(mode==="quote-signed-transaction"){const value=quote(intent);value.route.steps[0].signedTransaction="0xdead";return Response.json(value);}
    if(mode==="quote-signed-true"){const value=quote(intent);value.route.steps[0].signed=true;return Response.json(value);}
    if(mode==="direct-summary-missing"){const value=quote(intent);delete value.direct_route_summary;return Response.json(value);}
    if(mode==="direct-summary-extra"){const value=quote(intent);value.direct_route_summary.extra="forbidden";return Response.json(value);}
    if(mode==="direct-summary-private"){const value=quote(intent);value.direct_route_summary.steps[0].private_key="forbidden";return Response.json(value);}
    if(mode==="direct-summary-mode"){const value=quote(intent);value.direct_route_summary.mode="evil_mode";return Response.json(value);}
    if(mode==="direct-summary-top-aggregator"){const value=quote(intent);value.direct_route_summary.route_aggregator_used=true;return Response.json(value);}
    if(mode==="direct-summary-step-aggregator"){const value=quote(intent);value.direct_route_summary.steps[0].aggregator_api_used=true;return Response.json(value);}
    if(mode==="direct-summary-known-wrong-provider"){const value=quote(intent);value.direct_route_summary.steps[0].provider="paxos_usdg_layerzero_oft";value.route.steps[0].provider="paxos_usdg_layerzero_oft";return Response.json(value);}
    if(mode==="direct-summary-intent-input"){const value=quote(intent);value.intent.estimated_input_base+=1;return Response.json(value);}
    if(mode==="direct-summary-risk-external"){const value=quote(intent);value.risk.external_intent_protocol_used=!value.risk.external_intent_protocol_used;return Response.json(value);}
    if(mode==="direct-summary-fee-index"){const value=quote(intent);value.direct_route_summary.fee_collection_step_index=7;return Response.json(value);}
    if(mode==="direct-summary-raw-extra"){const value=quote(intent);value.route.steps[0].unexpected="forbidden";return Response.json(value);}
    if(mode==="direct-summary-across-false"){const value=quote(intent);value.direct_route_summary.classification="direct_protocol_only";value.direct_route_summary.external_intent_protocol_used=false;value.direct_route_summary.provider_internal_dex_aggregation_possible=false;return Response.json(value);}
    if(mode==="direct-summary-intermediate-input"){const value=quote(intent);value.direct_route_summary.steps[1].expected_input_base=String(Number(value.direct_route_summary.steps[1].expected_input_base)+1);value.route.steps[1].expected_input_base+=1;return Response.json(value);}
    if(mode==="direct-summary-fee-move"){const value=quote(intent),fee=value.direct_route_summary.fee_collection_step_index;value.direct_route_summary.steps[fee].assetfare_fee_bps=0;value.route.steps[fee].route_fee_bps=0;value.direct_route_summary.steps[0].assetfare_fee_bps=1;value.route.steps[0].route_fee_bps=1;value.direct_route_summary.fee_collection_step_index=0;value.offer.fee_collection_steps=[0];return Response.json(value);}
    if(mode==="continuation-missing"){const value=quote(intent);delete value.continuation_v3;return Response.json(value);}
    if(mode==="continuation-extra"){const value=quote(intent);value.continuation_v3.private_key="forbidden";return Response.json(value);}
    if(mode==="continuation-fingerprint"){const value=quote(intent);value.continuation_v3.quote_fingerprint="0".repeat(64);return Response.json(value);}
    if(mode==="continuation-summary-hash"){const value=quote(intent);value.continuation_v3.direct_route_summary_sha256="0".repeat(64);return Response.json(value);}
    if(mode==="continuation-payload-hash"){const value=quote(intent);value.continuation_v3.quote_payload_sha256="0".repeat(64);return Response.json(value);}
    if(mode==="continuation-payload-spec"){const value=quote(intent);value.continuation_v3.quote_payload_sha256_spec="sha256(JSON.stringify(quote))";return Response.json(value);}
    if(mode==="continuation-claim-payload-spec"){const value=quote(intent);value.continuation_v3.quote_fingerprint_claim.quote_payload_sha256_spec="sha256(JSON.stringify(quote))";return Response.json(value);}
    if(mode==="continuation-wallets"){const value=quote(intent);value.continuation_v3.required_wallet_chains=["base"];return Response.json(value);}
    if(mode==="continuation-signer"){const value=quote(intent);value.continuation_v3.event_signer_public_required=!value.continuation_v3.event_signer_public_required;return Response.json(value);}
    if(mode==="continuation-mode"){const value=quote(intent);value.continuation_v3.allowed_modes=["session"];return Response.json(value);}
    if(mode==="continuation-bounds"){const value=quote(intent);value.continuation_v3.minimum_output_base="1";return Response.json(value);}
    if(mode==="continuation-ttl"){const value=quote(intent);value.continuation_v3.expires_at=new Date(Date.parse(value.continuation_v3.expires_at)+1000).toISOString();return Response.json(value);}
    if(mode==="continuation-expired"){const value=quote(intent);return Response.json(attachContinuation(value,{issuedAt:Date.now()-120_000,ttl:60}));}
    if(mode==="continuation-future-issued"){const value=quote(intent);return Response.json(attachContinuation(value,{issuedAt:Date.now()+120_000,ttl:60}));}
    if(mode==="continuation-quote-ttl-mismatch"){const value=quote(intent);value.ttl_seconds=30;return Response.json(value);}
    if(mode==="continuation-selected"){const value=quote(intent);value.continuation_v3.selection_status="selected";return Response.json(value);}
    if (mode === "missing-handoff") { const value = quote(intent); delete value.caller_action_plan_handoff; return Response.json(value); }
    if (mode === "null-handoff") return Response.json(quote(intent, { caller_action_plan_handoff: null }));
    if (mode === "array-handoff") return Response.json(quote(intent, { caller_action_plan_handoff: [] }));
    if (mode === "handoff-extra-field") { const value = quote(intent); value.caller_action_plan_handoff.private_key = "leak"; return Response.json(value); }
    if (mode === "handoff-request-fields-reordered") { const value = quote(intent); value.caller_action_plan_handoff.request_fields = ["from_chain", "caller_approved", "from_token", "to_chain", "to_token", "amount_usd", "wallets", "event_signer_public"]; return Response.json(value); }
    if (mode === "handoff-request-fields-short") { const value = quote(intent); value.caller_action_plan_handoff.request_fields = ["caller_approved", "from_chain", "from_token", "to_chain", "to_token", "amount_usd", "wallets"]; return Response.json(value); }
    if (mode === "handoff-approval-false") { const value = quote(intent); value.caller_action_plan_handoff.requires_explicit_caller_approval = false; return Response.json(value); }
    if (mode === "handoff-server-signs") { const value = quote(intent); value.caller_action_plan_handoff.assetfare_server_signing = true; return Response.json(value); }
    if (mode === "handoff-v2-not-mutually-exclusive") { const value = quote(intent); delete value.caller_action_plan_handoff_v2.do_not_call_both; return Response.json(value); }
    if (mode === "handoff-v2-wrong-schema-version") { const value = quote(intent); value.caller_action_plan_handoff_v2.schema_version = 1; return Response.json(value); }
    if (mode === "handoff-v2-cross-field") { const value = quote(intent); value.caller_action_plan_handoff_v2.options[0].recommended_for_multistep = true; return Response.json(value); }
    if (mode === "handoff-v2-enforcement-overclaim") { const value = quote(intent); value.caller_action_plan_handoff_v2.enforcement = "server_enforced"; return Response.json(value); }
    if (mode === "handoff-schema-version-mismatch") { const value = quote(intent); value.handoff_schema_version = 3; return Response.json(value); }
    if (mode === "rollback-core-no-v2") { const value = quote(intent); delete value.caller_action_plan_handoff_v2; delete value.handoff_schema_version; return Response.json(attachContinuation(value)); }
    if (mode === "handoff-v2-orphan-version") { const value = quote(intent); delete value.caller_action_plan_handoff_v2; return Response.json(value); }
    if (mode === "handoff-v2-orphan-sibling") { const value = quote(intent); delete value.handoff_schema_version; return Response.json(value); }
    if (mode === "handoff-v2-null-sibling") { const value = quote(intent); value.caller_action_plan_handoff_v2 = null; return Response.json(value); }
    if (mode === "handoff-v2-option-missing-note") { const value = quote(intent); delete value.caller_action_plan_handoff_v2.options[0].note; return Response.json(value); }
    if (mode === "handoff-v2-option-missing-required") { const value = quote(intent); delete value.caller_action_plan_handoff_v2.options[0].not_a_session; return Response.json(value); }
    if (mode === "handoff-v2-missing-lifecycle") { const value = quote(intent); delete value.caller_action_plan_handoff_v2.options[1].lifecycle_urls.create; return Response.json(value); }
    if (mode === "handoff-v2-arbitrary-lifecycle") { const value = quote(intent); value.caller_action_plan_handoff_v2.options[1].lifecycle_urls.create.url = "https://api.assetfare.dev/v2/evil"; return Response.json(value); }
    if (mode === "handoff-v2-extra-lifecycle") { const value = quote(intent); value.caller_action_plan_handoff_v2.options[1].lifecycle_urls.extra = { method: "POST", url: SESSION_URL }; return Response.json(value); }
    if (mode === "handoff-v2-lifecycle-missing-method") { const value = quote(intent); delete value.caller_action_plan_handoff_v2.options[1].lifecycle_urls.create.method; return Response.json(value); }
    if (mode === "handoff-v2-null-without-version") { const value = quote(intent); value.caller_action_plan_handoff_v2 = null; delete value.handoff_schema_version; return Response.json(value); }
    if (mode === "handoff-v2-array-sibling") { const value = quote(intent); value.caller_action_plan_handoff_v2 = []; return Response.json(value); }
    if (mode === "handoff-v2-blocker-key") { const value = quote(intent); value.caller_action_plan_handoff_v2.blocker = null; return Response.json(value); }
    if (mode === "handoff-v2-missing-required-top") { const value = quote(intent); delete value.caller_action_plan_handoff_v2.selection; return Response.json(value); }
    if (mode === "fee-8bp") { const value = quote(intent); value.offer.assetfare_fee_bps = 8; value.offer.fee_modeled_bps = 1; return Response.json(value); }
    if (mode === "fee-0bp") { const value = quote(intent); value.offer.assetfare_fee_bps = 0; value.offer.fee_modeled_bps = 0; value.offer.fee_collectible_now = false; value.offer.fee_collection_steps = []; return Response.json(value); }
    if (mode === "fee-2-step") { const value = quote(intent); value.offer.assetfare_fee_bps = 1; value.offer.fee_collection_steps = [0, 0]; return Response.json(value); }
    if (mode === "fee-0-step-for-1bp") { const value = quote(intent); value.offer.assetfare_fee_bps = 1; value.offer.fee_collection_steps = []; return Response.json(value); }
    if (mode === "fee-step-out-of-range") { const value = quote(intent); value.offer.assetfare_fee_bps = 1; value.offer.fee_collection_steps = [7]; return Response.json(value); }
    if (mode === "execution-false-on-executable") { const value = quote(intent); value.execution = { supported: false, first_unsigned_action_supported: false, blocker: "execution_not_ready_phase_b" }; return Response.json(value); }
    if (mode === "source-only-fee-uncollectible") { const value = quote(intent); value.offer.fee_collectible_now = false; return Response.json(value); }
    if (mode === "cost-total-mismatch") { const value = quote(intent); value.cost_summary.maximum_total_cost_usd += .5; return Response.json(value); }
    if (mode === "cost-service-fee-mismatch") { const value = quote(intent); value.cost_summary.assetfare_service_fee.estimated_usd += .1; return Response.json(value); }
    if (mode === "cost-provider-negative") { const value = quote(intent); value.cost_summary.provider_fee_components=[{provider:"circle_cctp",kind:"forward",expected_usd:-1,maximum_usd:0,included_in_receive_amount:true}]; return Response.json(value); }
    if (mode === "eta-mismatch") { const value = quote(intent); value.eta.estimated_time_seconds = 99; return Response.json(value); }
    if (mode === "cost-component-sum") { const value=quote(intent);value.cost_summary.provider_fee_components=[{provider:"circle",kind:"forward",expected_usd:1,maximum_usd:1,included_in_receive_amount:true}];return Response.json(value); }
    if (mode === "cost-component-inverted") { const value=quote(intent);value.cost_summary.provider_fee_components=[{provider:"circle",kind:"forward",expected_usd:.02,maximum_usd:.01,included_in_receive_amount:true}];return Response.json(value); }
    if (mode === "cost-warning-false") { const value=quote(intent);value.cost_summary.small_amount_warning=true;value.cost_summary.warning="incorrect warning";return Response.json(value); }
    if (mode === "cost-unpriced-empty") { const value=quote(intent);value.cost_summary.unpriced_costs=[];return Response.json(value); }
    if (mode === "eta-inverted") { const value=quote(intent);value.eta.estimated_time_range_seconds=[30,23];return Response.json(value); }
    if (mode === "eta-incomplete-with-time") { const value=quote(intent);value.eta.complete_route_estimate=false;return Response.json(value); }
    if (mode === "ttl-too-long") { const value=quote(intent);value.ttl_seconds=61;return Response.json(value); }
    if (mode === "rollback-core-no-cost") { const value = quote(intent); delete value.cost_summary;delete value.eta;return Response.json(attachContinuation(value)); }
    if (mode === "submicro-rounding") { const value=quote(intent);value.offer.expected_receive_usd=24.1234567;value.offer.estimated_min_receive_usd=23.123456;Object.assign(value.cost_summary,{expected_receive_value_usd:24.123457,minimum_receive_value_usd:23.123456,expected_total_cost_usd:.876543,maximum_total_cost_usd:1.876544,expected_total_cost_percent:3.506172,maximum_total_cost_percent:7.506176,small_amount_warning:true,warning:"fixed cost"});return Response.json(attachContinuation(value)); }
    return Response.json(mode === "unsafe-quote" ? quote(intent, { risk: { server_signing: true, server_submission: false } }) : quote(intent));
  }
  if (String(url).endsWith("/v2/prepare")) {const value=prepareBundle();if(mode==="unsafe-bundle-signed")value.unsigned_action.signed=true;if(mode==="unsafe-bundle-secret")value.unsigned_action.private_key="secret";if(mode==="unsafe-bundle-camel")value.unsigned_action.serverSigning=true;if(mode==="unsafe-bundle-nested-secret")value.unsigned_action.transactions=[{seedPhrase:"alpha beta gamma"}];if(mode==="unsafe-bundle-compound-secret")value.unsigned_action.transactions=[{eventSignerPrivateKey:"secret"}];if(mode==="unsafe-bundle-nested-signed")value.unsigned_action.transactions=[{signedTransaction:"0xdead",nested:{signed:true}}];if(mode==="unsafe-bundle-signature")value.unsigned_action.transactions=[{signature:"0xdead"}];if(mode==="bundle-hash-mismatch")value.expires_at="2099-01-02T00:00:00Z";if(mode==="bundle-version-mismatch"){value.version="assetfare-direct-multichain-action-v3";delete value.payload_sha256;value.payload_sha256=hashBundle(value);}if(mode==="bundle-hash-spec-missing"){delete value.payload_sha256_spec;delete value.payload_sha256;value.payload_sha256=hashBundle(value);}if(mode==="bundle-hash-spec-mismatch"){value.payload_sha256_spec="sha256(JSON.stringify(bundle))";delete value.payload_sha256;value.payload_sha256=hashBundle(value);}return Response.json(value);}
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
  const dynamicPrepare = listed.tools.find((tool) => tool.name === "assetfare_v2_prepare");
  const card = await serverCard();
  const staticCapabilities = card.tools.find((tool) => tool.name === "assetfare_v2_capabilities");
  const staticQuote = card.tools.find((tool) => tool.name === "assetfare_v2_quote");
  assert.equal(listed.tools.length, 9);
  assert.equal(card.serverInfo.version, "1.3.3");
  assert.equal(card.tools.length, 9);
  assert.equal(dynamicPrepare.outputSchema.properties.version.const, BUNDLE_VERSION);
  assert.equal(dynamicPrepare.outputSchema.properties.payload_sha256.pattern, "^[0-9a-f]{64}$");
  assert.equal(dynamicPrepare.outputSchema.properties.payload_sha256.description, BUNDLE_HASH_SPEC);
  assert.equal(dynamicPrepare.outputSchema.properties.payload_sha256_spec.const, BUNDLE_HASH_SPEC);
  assert.ok(dynamicPrepare.outputSchema.required.includes("payload_sha256_spec"));
  // Every dynamic tool has a matching static server-card entry with the same description.
  const dynamicNames = new Set(listed.tools.map((tool) => tool.name));
  const staticNames = new Set(card.tools.map((tool) => tool.name));
  assert.equal(dynamicNames.size, 9);
  assert.deepEqual([...dynamicNames].sort(), [...staticNames].sort());
  const newTools = ["assetfare_v2_prepare", "assetfare_v2_session_create", "assetfare_v2_session_get", "assetfare_v2_session_observe_source", "assetfare_v2_session_observe_output", "assetfare_v2_session_refresh_action"];
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
    { ...validIntent, amount_usd: Number.POSITIVE_INFINITY },
    { ...validIntent, amount_usd: 0.99 },
    { ...validIntent, extra: "forbidden" },
  ];
  const beforeInvalid = calls.length;
  for (const args of invalid) {
    const result = await call(client, "assetfare_v2_quote", args);
    assert.equal(result.isError, true, `invalid input accepted: ${JSON.stringify(args)}`);
  }
  assert.equal(calls.length, beforeInvalid, "invalid input reached upstream");

  const beforeUncapped = calls.length;
  const uncapped = await call(client, "assetfare_v2_quote", { ...validIntent, amount_usd: 2500.25 });
  assert.equal(uncapped.isError, false, "finite amount above the retired USD 1,000 business cap was rejected");
  assert.equal(calls.length, beforeUncapped + 1, "uncapped quote did not reach upstream exactly once");
  for (const [amountUsd, expectedFeeUsd] of [[100_000, 10], [1_000_000, 100]]) {
    const large = await call(client, "assetfare_v2_quote", { ...validIntent, amount_usd: amountUsd });
    assert.equal(large.isError, false, `exact 1bp no-maximum quote rejected at USD ${amountUsd}`);
    assert.equal(parse(large).cost_summary.assetfare_service_fee.estimated_usd, expectedFeeUsd);
  }

  // Fail-closed handoff / fee / execution hostiles (all on a valid executable route).
  const failClosed = ["missing-handoff", "null-handoff", "array-handoff", "handoff-extra-field", "handoff-request-fields-reordered", "handoff-request-fields-short", "handoff-approval-false", "handoff-server-signs", "handoff-v2-not-mutually-exclusive", "handoff-v2-wrong-schema-version", "handoff-v2-cross-field", "handoff-v2-enforcement-overclaim", "handoff-schema-version-mismatch", "handoff-v2-orphan-version", "handoff-v2-orphan-sibling", "handoff-v2-null-sibling", "handoff-v2-option-missing-note", "handoff-v2-option-missing-required", "handoff-v2-missing-lifecycle", "handoff-v2-arbitrary-lifecycle", "handoff-v2-extra-lifecycle", "handoff-v2-lifecycle-missing-method", "handoff-v2-null-without-version", "handoff-v2-array-sibling", "handoff-v2-blocker-key", "handoff-v2-missing-required-top", "fee-8bp", "fee-0bp", "fee-2-step", "fee-0-step-for-1bp", "fee-step-out-of-range", "execution-false-on-executable", "cost-total-mismatch", "cost-service-fee-mismatch", "cost-provider-negative", "cost-component-sum", "cost-component-inverted", "cost-warning-false", "cost-unpriced-empty", "eta-mismatch", "eta-inverted", "eta-incomplete-with-time", "ttl-too-long", "quote-private-key", "quote-seed-phrase", "quote-signed-transaction", "quote-signed-true", "direct-summary-missing", "direct-summary-extra", "direct-summary-private", "direct-summary-mode", "direct-summary-top-aggregator", "direct-summary-step-aggregator", "direct-summary-known-wrong-provider", "direct-summary-intent-input", "direct-summary-risk-external", "direct-summary-fee-index", "direct-summary-raw-extra", "continuation-missing", "continuation-extra", "continuation-fingerprint", "continuation-summary-hash", "continuation-payload-hash", "continuation-payload-spec", "continuation-claim-payload-spec", "continuation-wallets", "continuation-signer", "continuation-mode", "continuation-bounds", "continuation-ttl", "continuation-expired", "continuation-future-issued", "continuation-quote-ttl-mismatch", "continuation-selected"];
  const executableIntent = { from_chain: "base", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 25 };
  for (const failureMode of failClosed) {
    mode = failureMode;
    const result = await call(client, "assetfare_v2_quote", executableIntent);
    assert.equal(result.isError, true, `${failureMode} did not fail closed`);
  }
  for (const [failureMode,intent] of [["direct-summary-across-false",{from_chain:"base",from_token:"USDC",to_chain:"robinhood",to_token:"USDG",amount_usd:25}],["direct-summary-intermediate-input",{from_chain:"solana",from_token:"SOL",to_chain:"base",to_token:"ETH",amount_usd:25}],["direct-summary-fee-move",{from_chain:"solana",from_token:"SOL",to_chain:"base",to_token:"ETH",amount_usd:25}]]) {
    mode=failureMode;const result=await call(client,"assetfare_v2_quote",intent);assert.equal(result.isError,true,`${failureMode} did not fail closed`);
  }
  // Rollback/transition: a Core that omits the v2 sibling (v1-only) must STILL quote successfully.
  mode = "rollback-core-no-v2";
  const rollbackQuote = await call(client, "assetfare_v2_quote", executableIntent);
  assert.equal(rollbackQuote.isError ?? false, false, "rollback core (v1-only, no v2 sibling) failed to quote");
  mode = "rollback-core-no-cost";
  const rollbackCost = parse(await call(client, "assetfare_v2_quote", executableIntent));
  assert.equal(rollbackCost.cost_summary.scope, "token_path_only_network_gas_excluded");
  assert.ok(rollbackCost.cost_summary.unpriced_costs.includes("provider_fee_breakdown_unavailable_legacy_core"));
  mode = "submicro-rounding";
  const roundedQuote=await call(client,"assetfare_v2_quote",executableIntent);
  assert.equal(roundedQuote.isError??false,false,"sub-micro USD rounding alignment was rejected");
  mode = "success";
  // An audited 1bp source-only route claiming the fee is not collectible must fail closed.
  mode = "source-only-fee-uncollectible";
  const feeReadiness = await call(client, "assetfare_v2_quote", { from_chain: "polygon", from_token: "USDC", to_chain: "base", to_token: "USDC", amount_usd: 25 });
  assert.equal(feeReadiness.isError, true, "source-only fee_collectible_now:false was not rejected");

  mode = "success";
  for (const failureMode of ["unsafe-capabilities", "wrong-source-only", "partial-current-availability", "fake-unavailable-route", "availability-status-inconsistent", "missing-direct-summary-contract", "missing-continuation-contract", "wrong-continuation-contract", "wrong-continuation-hash-spec", "wrong-direct-summary-contract", "wrong-direct-summary-scope", "unsafe-quote", "nested-signing", "oversized", "invalid-json", "wrong-content-type", "unsafe-error", "network"]) {
    mode = failureMode;
    const capabilityFailure = ["unsafe-capabilities", "wrong-source-only", "partial-current-availability", "fake-unavailable-route", "availability-status-inconsistent", "missing-direct-summary-contract", "missing-continuation-contract", "wrong-continuation-contract", "wrong-continuation-hash-spec", "wrong-direct-summary-contract", "wrong-direct-summary-scope"].includes(failureMode);
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
  const sourceOnlyBundle = parse(sourceOnlyPrepare);
  assert.deepEqual(sourceOnlyPrepare.structuredContent, sourceOnlyBundle, "prepare text and structuredContent diverged");
  assert.deepEqual(sourceOnlyBundle, prepareBundle(), "MCP adapter did not return the exact upstream Core bundle");
  assert.equal(calls.length, beforePrepare + 1, "source-only prepare did not reach the approved endpoint exactly once");
  const sourceOnlyQuote=quote({from_chain:"polygon",from_token:"USDC",to_chain:"base",to_token:"USDC",amount_usd:25}),sourceOnlyApproval=approvalFor(sourceOnlyQuote,"one_shot","mcp.one.0001"),v3Before=calls.length;
  const v3Prepared=await call(client,"assetfare_v2_prepare",{caller_approved:true,from_chain:"polygon",from_token:"USDC",to_chain:"base",to_token:"USDC",amount_usd:25,wallets:{polygon:"0x1111111111111111111111111111111111111111",base:"0x2222222222222222222222222222222222222222"},approval_v3:sourceOnlyApproval});assert.equal(v3Prepared.isError,false);assert.equal(calls.length,v3Before+1);assert.deepEqual(JSON.parse(calls.at(-1).init.body).approval_v3,sourceOnlyApproval);
  const wrongMode={...sourceOnlyApproval,selected_mode:"session"},wrongModeBefore=calls.length,wrongModeResult=await call(client,"assetfare_v2_prepare",{caller_approved:true,from_chain:"polygon",from_token:"USDC",to_chain:"base",to_token:"USDC",amount_usd:25,wallets:{polygon:"0x1111111111111111111111111111111111111111",base:"0x2222222222222222222222222222222222222222"},approval_v3:wrongMode});assert.equal(wrongModeResult.isError,true);assert.equal(calls.length,wrongModeBefore);
  assert.equal(sourceOnlyBundle.version, BUNDLE_VERSION);
  assert.equal(sourceOnlyBundle.signed, false);
  assert.equal(sourceOnlyBundle.guidance, undefined, "MCP guidance mutated the hashed Core bundle");
  const unhashedBundle = { ...sourceOnlyBundle };
  delete unhashedBundle.payload_sha256;
  assert.equal(hashBundle(unhashedBundle), sourceOnlyBundle.payload_sha256, "Core bundle hash was not preserved");

  const uncappedPrepareArgs = { caller_approved: true, from_chain: "base", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 2500.25, wallets: { base: "0x1111111111111111111111111111111111111111", arbitrum: "0x2222222222222222222222222222222222222222" } };
  const beforeUncappedPrepare = calls.length;
  const uncappedPrepare = await call(client, "assetfare_v2_prepare", uncappedPrepareArgs);
  assert.equal(uncappedPrepare.isError, false, "caller-approved prepare above the retired business cap was rejected");
  assert.equal(parse(uncappedPrepare).signed, false);
  assert.equal(JSON.parse(String(calls.at(-1).init.body)).amount_usd, 2500.25);
  assert.equal(calls.length, beforeUncappedPrepare + 1, "uncapped prepare did not reach upstream exactly once");

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

  const beforeInvalidPrepareAmount = calls.length;
  for (const amount_usd of [0.99, Number.NaN, Number.POSITIVE_INFINITY]) {
    const result = await call(client, "assetfare_v2_prepare", { ...uncappedPrepareArgs, amount_usd });
    assert.equal(result.isError, true, `prepare accepted unsafe amount ${String(amount_usd)}`);
  }
  assert.equal(calls.length, beforeInvalidPrepareAmount, "unsafe prepare amount reached upstream");

  // A private-key-shaped wallet value (64-hex secret, not a public address) is rejected before any network call.
  const beforeSecret = calls.length;
  const secretPrepare = await call(client, "assetfare_v2_prepare", { caller_approved: true, from_chain: "base", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 25, wallets: { base: "0x1111111111111111111111111111111111111111", arbitrum: "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" } });
  assert.equal(secretPrepare.isError, true, "prepare accepted a non-public-address (private-key-shaped) wallet value");
  assert.equal(calls.length, beforeSecret, "secret-material hostile reached upstream");
  const beforeExtraSecret=calls.length;
  const extraSecret=await call(client,"assetfare_v2_prepare",{...uncappedPrepareArgs,private_key:"secret"});
  assert.equal(extraSecret.isError,true,"prepare silently stripped an extra private_key field");
  assert.equal(calls.length,beforeExtraSecret,"extra secret field reached upstream");
  for(const unsafeMode of ["unsafe-bundle-signed","unsafe-bundle-secret","unsafe-bundle-camel","unsafe-bundle-nested-secret","unsafe-bundle-compound-secret","unsafe-bundle-nested-signed","unsafe-bundle-signature","bundle-hash-mismatch","bundle-version-mismatch","bundle-hash-spec-missing","bundle-hash-spec-mismatch"]){mode=unsafeMode;const before=calls.length;const unsafe=await call(client,"assetfare_v2_prepare",uncappedPrepareArgs);assert.equal(unsafe.isError,true,`${unsafeMode} upstream output was accepted`);assert.equal(calls.length,before+1);}mode="success";

  // The remote adapter never generates a caller session secret. The client
  // generates 32 CSPRNG bytes locally and supplies the token only on session calls.
  const beforeToken = calls.length;
  assert.equal(dynamicNames.has("assetfare_v2_new_session_capability"), false);
  const token = randomBytes(32).toString("base64url");
  const token2 = randomBytes(32).toString("base64url");
  assert.equal(calls.length, beforeToken, "client token generation changed upstream calls");
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(token, token2, "client token generator must be non-deterministic");

  assert.ok(calls.every((item) => item.url.endsWith("/v2/capabilities") || item.url.endsWith("/v2/quote") || item.url.endsWith("/v2/prepare")), "v2 tools reached an unauthorized path");
  console.log(JSON.stringify({ status: "pass", version: packageMetadata.version, tool_count: listed.tools.length, valid_routes: routeCount, source_only_routes: sourceOnlyCount, upstream_calls_for_matrix: 77, fail_closed_hostiles: failClosed.length, caller_approved_hostiles: badApproval.length, signed: false, submitted: false }));
} finally {
  globalThis.fetch = originalFetch;
  await client.close();
  await server.close();
}
