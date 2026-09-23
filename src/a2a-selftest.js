import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Message, Role, canonicalizeAgentCard } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, defaultServerCallContextBuilder } from "@a2a-js/sdk/server";
import { A2A_PROTOCOL_VERSION, assetFareAgentCard, createAssetFareA2A } from "./a2a.js";

const ok = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const endpoints=[["solana","SOL"],["solana","USDC"],["solana","USDG"],["base","ETH"],["base","USDC"],["arbitrum","ETH"],["arbitrum","USDC"],["robinhood","ETH"],["robinhood","USDG"],["polygon","USDC"],["optimism","USDC"]];
const SOURCE_ONLY=["optimism:USDC->arbitrum:USDC","optimism:USDC->base:USDC","polygon:USDC->arbitrum:USDC","polygon:USDC->base:USDC"];
const REQUEST_FIELDS=["caller_approved","from_chain","from_token","to_chain","to_token","amount_usd","wallets","event_signer_public"];
const PREPARE_URL="https://api.assetfare.dev/v2/prepare";const SESSION_URL="https://api.assetfare.dev/v2/session";
const caps = { status:"capped_public_agent_release",public_api_enabled: true,chains:["arbitrum","base","optimism","polygon","robinhood","solana"],asset_endpoints:endpoints.map(([chain,token])=>({chain,token})),source_only_asset_endpoints:[{chain:"optimism",token:"USDC"},{chain:"polygon",token:"USDC"}],source_only_routes:[...SOURCE_ONLY],directed_conversion_routes:76,unsigned_route_plans_ready:76,execution_ready_routes:76,phase_b_blocked_routes:0,blocked_source_only_routes:[],server_signing: false, server_submission: false };
const status = { status: "capped_public_agent_release", server_signing: false, server_submission: false };
const PREPARE_OPTION={kind:"one_shot_first_unsigned_bundle",method:"POST",url:PREPARE_URL,requires_explicit_caller_approval:true,requires_public_wallet_addresses:true,assetfare_never_signs_submits_or_auto_calls:true,note:"stateless first bundle"};
const SESSION_OPTION={kind:"caller_approved_full_workflow_session",method:"POST",url:SESSION_URL,lifecycle_urls:{create:{method:"POST",url:SESSION_URL},read:{method:"GET",url:`${SESSION_URL}/{session_id}`},observe_source:{method:"POST",url:`${SESSION_URL}/{session_id}/observe-source`},observe_output:{method:"POST",url:`${SESSION_URL}/{session_id}/observe-output`},refresh_action:{method:"POST",url:`${SESSION_URL}/{session_id}/refresh-action`}},requires_explicit_caller_approval:true,requires_public_wallet_addresses:true,assetfare_never_signs_submits_or_auto_calls:true,note:"full lifecycle"};
const executableHandoff=()=>({kind:"caller_operated_rest_prepare",url:PREPARE_URL,method:"POST",requires_explicit_caller_approval:true,requires_public_wallet_addresses:true,request_fields:[...REQUEST_FIELDS],assetfare_server_signing:false,assetfare_server_submission:false,caller_must_verify_sign_and_submit:true,requires_fresh_requote:true,automatic_prepare_call_forbidden:true,options:[structuredClone(PREPARE_OPTION),structuredClone(SESSION_OPTION)],note:"guidance only",available:true});
const PREPARE_OPTION_V2={...structuredClone(PREPARE_OPTION),preview_or_manual_first_action_only:true,not_a_session:true,do_not_start_session_after_submission:true};
const SESSION_OPTION_V2={...structuredClone(SESSION_OPTION),recommended_for_multistep:true};
const executableHandoffV2=()=>({kind:"caller_operated_rest_prepare",url:PREPARE_URL,method:"POST",requires_explicit_caller_approval:true,requires_public_wallet_addresses:true,request_fields:[...REQUEST_FIELDS],assetfare_server_signing:false,assetfare_server_submission:false,caller_must_verify_sign_and_submit:true,requires_fresh_requote:true,automatic_prepare_call_forbidden:true,schema_version:2,selection:"choose_exactly_one",mutually_exclusive:true,do_not_call_both:true,selection_before_signing:true,once_any_action_submitted_do_not_start_other_mode:true,enforcement:"advisory_caller_side",options:[structuredClone(PREPARE_OPTION_V2),structuredClone(SESSION_OPTION_V2)],note:"machine v2",available:true});
const quoteFor = (intent) => {const expected=intent.amount_usd-.01,minimum=intent.amount_usd-.02,small=.02/intent.amount_usd>=.01;return { status: "capped_public_agent_release",ttl_seconds:60,intent:{from:`${intent.from_chain}:${intent.from_token}`,to:`${intent.to_chain}:${intent.to_token}`,amount_usd:intent.amount_usd,estimated_input_base:1},execution:{ supported: true, first_unsigned_action_supported:true, blocker:null }, risk: { server_signing: false, server_submission: false }, cost_summary:{scope:"token_path_only_network_gas_excluded",input_value_usd:intent.amount_usd,expected_receive_value_usd:expected,minimum_receive_value_usd:minimum,expected_total_cost_usd:.01,maximum_total_cost_usd:.02,expected_total_cost_percent:.01/intent.amount_usd*100,maximum_total_cost_percent:.02/intent.amount_usd*100,assetfare_service_fee:{bps:1,estimated_usd:intent.amount_usd/10000,included_in_receive_amount:true},provider_fee_components:[],unpriced_costs:["source_chain_network_fee"],rankable_all_in:false,small_amount_warning:small,warning:small?"fixed cost":null},eta:{estimated_time_seconds:20,estimated_time_range_seconds:[8,20],complete_route_estimate:true},offer: {expected_receive_amount:expected,estimated_min_receive_amount:minimum,output_symbol:intent.to_token,expected_receive_usd:expected,estimated_min_receive_usd:minimum,estimated_time_seconds:20,assetfare_fee_bps:1,fee_modeled_bps:1,fee_collectible_now:true,fee_collection_steps:[0],fee_collection:"only_on_eligible_successful_executor_step"},route:{route:`${intent.from_chain}:${intent.from_token}->${intent.to_chain}:${intent.to_token}`,steps:[{provider:"fixture"}],server_signing:false,server_submission:false}, caller_action_plan_handoff: executableHandoff(), caller_action_plan_handoff_v2: executableHandoffV2(), handoff_schema_version: 2 };};
const data = (value) => ({ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" });
const text = (value) => ({ content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" });
const message = (parts) => Message.toJSON({ messageId: "m", contextId: "", taskId: "", role: Role.ROLE_USER, parts, metadata: undefined, extensions: [], referenceTaskIds: [] });
const request = (parts, id = "1", method = "SendMessage") => ({ jsonrpc: "2.0", id, method, params: { message: message(parts) } });
const context = (headers = {}) => defaultServerCallContextBuilder({ headers, user: undefined, extensions: undefined, requestedVersion: A2A_PROTOCOL_VERSION });

const card = assetFareAgentCard();
canonicalizeAgentCard(card);
assert.equal(card.version, "0.1.8");
assert.equal(card.skills.length, 3);
assert.deepEqual(card.skills.map((skill) => skill.id).sort(), ["prepare-first-unsigned-action", "quote-cross-chain-route", "session-lifecycle"]);
assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0");
assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
assert.equal(card.supportedInterfaces[0].url, "https://api.assetfare.dev/a2a");
assert.match(card.description,/non-custodial native-USDC bridge.*76 directed routes.*AssetFare service fee 1bp; Circle\/provider\/network fees additional.*live availability/i);
assert.doesNotMatch(JSON.stringify(card),/flat[ -]?1 ?bp|execution-ready/i);
assert.match(card.description,/Solana native USDC to Base native USDC.*Solana SOL to Base USDC.*Optimism USDC to Base USDC/i);
assert.match(card.description,/caller approval.*unsigned plan.*server never signs or submits/i);
assert.deepEqual(card.skills[0].tags.slice(0,5),["native-usdc","solana-usdc","base-usdc","unsigned-transaction-plan","caller-signed"]);
assert.match(card.skills[0].description,/Solana native USDC to Base native USDC.*caller-approved unsigned transaction-plan/i);
assert.deepEqual(card.skills[0].examples[0],'{"fromChain":"solana","fromToken":"USDC","toChain":"base","toToken":"USDC","amountUsd":250}');
for (const tag of ["native-usdc","solana-usdc","base-usdc","unsigned-transaction-plan","caller-signed"]) assert.ok(card.skills[0].tags.includes(tag));
assert.equal(JSON.parse(card.skills[0].examples[0]).amountUsd,250);
assert.equal(JSON.stringify(card).match(/BEGIN PRIVATE KEY|seed phrase|secret[_-]?key|api[_-]?key|bearer [A-Za-z0-9]/i), null);

let observedBody;let observedHeaders;
const fetchMock = async (url, init = {}) => {
  if (String(url).endsWith("/v2/quote")) { observedBody = JSON.parse(String(init.body));observedHeaders = init.headers;return ok(quoteFor(observedBody)); }
  if (String(url).endsWith("/v2/capabilities")) return ok(caps);
  if (String(url).endsWith("/v2/status")) return ok(status);
  return new Response("{}", { status: 404 });
};
const { requestHandler } = createAssetFareA2A({ apiBaseUrl: "http://127.0.0.1:8791", fetch: fetchMock });
const transport = new JsonRpcTransportHandler(requestHandler);
const intent = { fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 };
const result = await transport.handle(request([data(intent)]), context({ "x-forwarded-for": "203.0.113.10", "user-agent": "external-agent/1" }));
assert.deepEqual(observedBody, { from_chain: "solana", from_token: "SOL", to_chain: "base", to_token: "USDC", amount_usd: 1 });
assert.equal(observedHeaders.get("x-forwarded-for"), "203.0.113.10");
assert.equal(observedHeaders.get("x-assetfare-channel"), "a2a");
assert.equal(result.result.message.role, "ROLE_AGENT");
assert.ok(result.result.message.parts[0].data.quote);
assert.equal(result.result.message.parts[0].data.guidance.transactionSubmitted, false);

const uncappedIntent = { ...intent, amountUsd: 2500.25 };
const uncappedResult = await transport.handle(request([data(uncappedIntent)], "uncapped"), context());
assert.equal(observedBody.amount_usd, 2500.25);
assert.ok(uncappedResult.result.message.parts[0].data.quote);
for (const amountUsd of [0.99, Number.NaN, Number.POSITIVE_INFINITY]) {
  const invalidAmount = await transport.handle(request([data({ ...intent, amountUsd })], `invalid-${String(amountUsd)}`), context());
  assert.equal(invalidAmount.result.message.parts[0].data.error.code, "quote_intent_invalid");
}

const polygonIntent = { fromChain: "polygon", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd: 10 };
const polygonResult = await transport.handle(request([data(polygonIntent)], "polygon"), context());
assert.deepEqual(observedBody, { from_chain: "polygon", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 10 });
assert.ok(polygonResult.result.message.parts[0].data.quote);
const polygonDestination = await transport.handle(request([data({ ...polygonIntent, fromChain: "base", toChain: "polygon" })], "polygon-destination"), context());
assert.equal(polygonDestination.result.message.parts[0].data.error.code, "quote_intent_invalid");

const oldMethod = await transport.handle(request([data(intent)], "2", "message/send"), context());
assert.equal(oldMethod.error.code, -32601);
const freeText = await transport.handle(request([text("send money")], "3"), context());
assert.equal(freeText.result.message.parts[0].data.error.code, "quote_intent_required");
assert.equal(JSON.stringify(freeText).includes('"quote"'), false);

const unsafeFetch = async (url,init={}) => String(url).endsWith("/v2/capabilities") ? ok(caps) : String(url).endsWith("/v2/status") ? ok(status) : ok({ ...quoteFor(JSON.parse(String(init.body))), risk: { server_signing: false, server_submission: true } });
const unsafe = new JsonRpcTransportHandler(createAssetFareA2A({ fetch: unsafeFetch }).requestHandler);
const unsafeResult = await unsafe.handle(request([data(intent)], "4"), context());
assert.equal(unsafeResult.result.message.parts[0].data.error.code, "assetfare_safety_boundary_failed");
assert.equal(JSON.stringify(unsafeResult).includes('"quote"'), false);

const oldCapabilitiesFetch=async(url,init={})=>String(url).endsWith("/v2/capabilities")?ok({...caps,directed_conversion_routes:72,unsigned_route_plans_ready:72}):String(url).endsWith("/v2/status")?ok(status):ok(quoteFor(JSON.parse(String(init.body))));
const oldCapabilitiesResult=await new JsonRpcTransportHandler(createAssetFareA2A({fetch:oldCapabilitiesFetch}).requestHandler).handle(request([data(polygonIntent)],"old-capabilities"),context());
assert.equal(oldCapabilitiesResult.result.message.parts[0].data.error.code,"assetfare_safety_boundary_failed");
const wrongSourceOnlyFetch=async(url,init={})=>String(url).endsWith("/v2/capabilities")?ok({...caps,source_only_routes:["polygon:USDC->base:ETH","polygon:USDC->arbitrum:USDC"]}):String(url).endsWith("/v2/status")?ok(status):ok(quoteFor(JSON.parse(String(init.body))));
const wrongSourceOnlyResult=await new JsonRpcTransportHandler(createAssetFareA2A({fetch:wrongSourceOnlyFetch}).requestHandler).handle(request([data(polygonIntent)],"wrong-source-only"),context());
assert.equal(wrongSourceOnlyResult.result.message.parts[0].data.error.code,"assetfare_safety_boundary_failed");
const mismatchedFetch=async(url,init={})=>String(url).endsWith("/v2/capabilities")?ok(caps):String(url).endsWith("/v2/status")?ok(status):ok(quoteFor({from_chain:"solana",from_token:"SOL",to_chain:"robinhood",to_token:"ETH",amount_usd:999}));
const mismatchedResult=await new JsonRpcTransportHandler(createAssetFareA2A({fetch:mismatchedFetch}).requestHandler).handle(request([data(polygonIntent)],"mismatch"),context());
assert.equal(mismatchedResult.result.message.parts[0].data.error.code,"assetfare_safety_boundary_failed");
const nestedSigningFetch=async(url,init={})=>{if(String(url).endsWith("/v2/capabilities"))return ok(caps);if(String(url).endsWith("/v2/status"))return ok(status);const value=quoteFor(JSON.parse(String(init.body)));value.offer.server_submission=true;value.route.steps[0].server_signing=true;value.execution.server_submission=true;return ok(value);};
const nestedSigningResult=await new JsonRpcTransportHandler(createAssetFareA2A({fetch:nestedSigningFetch}).requestHandler).handle(request([data(intent)],"nested-signing"),context());
assert.equal(nestedSigningResult.result.message.parts[0].data.error.code,"assetfare_safety_boundary_failed");

const leaky = new JsonRpcTransportHandler(createAssetFareA2A({ fetch: async()=>{throw Error("SECRET https://internal/?key=bad");} }).requestHandler);
const leakyResult = await leaky.handle(request([data(intent)], "5"), context());
assert.equal(JSON.stringify(leakyResult).match(/SECRET|internal|https?:\/\//), null);
assert.equal(leakyResult.result.message.parts[0].data.error.code, "assetfare_upstream_unavailable");

// ---- v2 execution operations (prepare + session lifecycle) ------------------
const wallets = { base: "0x1111111111111111111111111111111111111111", arbitrum: "0x2222222222222222222222222222222222222222" };
let execBody; let execHeaders; let execPath;
const execFetch = async (url, init = {}) => {
  execPath = new URL(String(url)).pathname; execHeaders = init.headers;
  if (execPath === "/v2/prepare") { execBody = JSON.parse(String(init.body)); return ok({ status: "pass", version: "assetfare-direct-multichain-action-v2", workflow_id: "wf-1", step_index: 0, unsigned_action: { transaction: "0xUNSIGNED" }, server_signing: false, server_submission: false, signed: false, submitted: false }); }
  if (execPath === "/v2/session") { execBody = JSON.parse(String(init.body)); return ok({ session_id: "00000000-0000-4000-8000-000000000001", status: "action_ready", action_available: true, current_action: { unsigned_action: { transaction: "0xUNSIGNED" } }, server_signing: false, server_submission: false, signed: false, submitted: false }); }
  return new Response("{}", { status: 404 });
};
const execHandler = new JsonRpcTransportHandler(createAssetFareA2A({ fetch: execFetch }).requestHandler);
const dataOf = (r) => r.result.message.parts[0].data;

// Remote A2A never generates the caller's session secret. The client creates it locally.
const sessionToken = randomBytes(32).toString("base64url");
assert.match(sessionToken, /^[A-Za-z0-9_-]{43}$/);
assert.equal(card.skills.some((skill) => skill.id === "new-session-capability"), false);

// prepare happy path: caller_approved:true + exact wallets -> POST /v2/prepare, returns bundle
const prepareResult = await execHandler.handle(request([data({ operation: "prepare", callerApproved: true, fromChain: "base", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd: 25, wallets })], "prepare"), context());
assert.ok(dataOf(prepareResult).bundle.unsigned_action);
assert.equal(execBody.caller_approved, true);
assert.equal(dataOf(prepareResult).guidance.callerMustVerifySignAndSubmit, true);

const uncappedPrepareResult = await execHandler.handle(request([data({ operation: "prepare", callerApproved: true, fromChain: "base", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd: 2500.25, wallets })], "uncapped-prepare"), context());
assert.ok(dataOf(uncappedPrepareResult).bundle.unsigned_action);
assert.equal(execBody.amount_usd, 2500.25);
for (const amountUsd of [0.99, Number.NaN, Number.POSITIVE_INFINITY]) {
  const invalidPrepare = await execHandler.handle(request([data({ operation: "prepare", callerApproved: true, fromChain: "base", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd, wallets })], `invalid-prepare-${String(amountUsd)}`), context());
  assert.equal(dataOf(invalidPrepare).error.code, "prepare_intent_invalid");
}

// prepare caller_approved:false is rejected before any network work
const badPrepare = await execHandler.handle(request([data({ operation: "prepare", callerApproved: false, fromChain: "base", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd: 25, wallets })], "bad-prepare"), context());
assert.equal(dataOf(badPrepare).error.code, "prepare_intent_invalid");

// source-only directional prepare is execution-ready and caller-approved.
const sourceOnlyPrepare = await execHandler.handle(request([data({ operation: "prepare", callerApproved: true, fromChain: "polygon", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 25, wallets: { polygon: "0x3333333333333333333333333333333333333333", base: "0x1111111111111111111111111111111111111111" } })], "src-prepare"), context());
assert.ok(dataOf(sourceOnlyPrepare).bundle.unsigned_action);

// session_create happy path: sends X-AssetFare-Session-Token and caller_approved:true
const sessionResult = await execHandler.handle(request([data({ operation: "session_create", callerApproved: true, fromChain: "base", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd: 25, wallets, sessionToken, idempotencyKey: "a2a-create-0001" })], "session"), context());
assert.equal(dataOf(sessionResult).session.session_id, "00000000-0000-4000-8000-000000000001");
assert.equal(execHeaders.get("x-assetfare-session-token"), sessionToken);
assert.equal(execBody.caller_approved, true);

console.log(JSON.stringify({ status: "pass", official_sdk: "@a2a-js/sdk@1.1.0", card: true, card_skills: card.skills.length, quote: true, prepare: true, session_create: true, remote_session_secret_generation: false, execution_ready_routes: 76, phase_b_blocked_routes: 0, provenance: true, v0_method_rejected: true, free_text_rejected: true, unsafe_quote_rejected: true, sanitized_errors: true, signed: false, submitted: false }));
