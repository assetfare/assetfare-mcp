#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Message, Role } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, defaultServerCallContextBuilder } from "@a2a-js/sdk/server";
import { A2A_PROTOCOL_VERSION, createAssetFareA2A } from "../src/a2a.js";
import { sessionVerificationContext } from "./plan.mjs";
import { approvalFor, sessionBindingFor } from "../test/continuation-fixture.mjs";
import { quoteFixture } from "../test/quote-fixture.mjs";
import { EVENT, FROM, NOW, SOL, TO, evmBundle, rehashBundleOnly, rehashEvm, rehashSolana, solanaBundle } from "../test/action-bundle-fixture.mjs";

const token=randomBytes(32).toString("base64url"),sessionId="00000000-0000-4000-8000-000000000099";
const evmIntent={from_chain:"base",from_token:"USDC",to_chain:"arbitrum",to_token:"USDC",amount_usd:250},evmQuote=quoteFixture({...evmIntent,issuedAt:NOW,quote_id:"00000000-0000-4000-8000-000000000001"}),evmApproval=approvalFor(evmQuote,"session","a2a-create-0001"),evmStored=sessionVerificationContext({intent:evmIntent,wallets:{base:FROM,arbitrum:TO},approval:evmApproval,directRouteSummary:evmQuote.direct_route_summary}),evmContext={...evmStored.value,verification_context_sha256:evmStored.sha256};
const solIntent={from_chain:"solana",from_token:"USDC",to_chain:"base",to_token:"USDC",amount_usd:250},solQuote=quoteFixture({...solIntent,issuedAt:NOW,quote_id:"00000000-0000-4000-8000-000000000002"}),solApproval=approvalFor(solQuote,"session","a2a-sol-0001"),solStored=sessionVerificationContext({intent:solIntent,wallets:{solana:SOL,base:TO},eventSignerPublic:EVENT,approval:solApproval,directRouteSummary:solQuote.direct_route_summary}),solContext={...solStored.value,verification_context_sha256:solStored.sha256};

function session(action,approval=evmApproval){return {session_id:sessionId,status:action?"action_ready":"ready",action_available:Boolean(action),current_action:action,quote_binding:sessionBindingFor(approval),server_signing:false,server_submission:false,signed:false,submitted:false};}
function response(value,status=200){return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});}
function data(value){return {content:{$case:"data",value},metadata:undefined,filename:"",mediaType:"application/json"};}
function message(parts){return Message.toJSON({messageId:"m",contextId:"",taskId:"",role:Role.ROLE_USER,parts,metadata:undefined,extensions:[],referenceTaskIds:[]});}
function request(value,id){return {jsonrpc:"2.0",id,method:"SendMessage",params:{message:message([data(value)])}};}
function context(){return defaultServerCallContextBuilder({headers:{},user:undefined,extensions:undefined,requestedVersion:A2A_PROTOCOL_VERSION});}
function output(result){return result.result.message.parts[0].data;}

let mode="evm",calls=0,lastRequest=null;
const recovery={error:"reapproval_required",reason:"approval_v3_quote_not_found_or_process_restarted",action_created:false,fresh_read_only_quote_required:true,new_quote_is_not_action_authority:true,do_not_repeat_confirmed_steps:false,do_not_start_new_session:false,recover_current_session:false,recovery_operation:"obtain_new_quote_and_make_new_selection",replacement_approval_endpoint_available:true,selection_status:"unranked_candidate",automatic_selection_forbidden:true,caller_approved_boolean_is_not_human_proof:true,required_wallet_chains:["arbitrum","base"],event_signer_public_required:false,server_signing:false,server_submission:false};
const fetchMock=async(url,init={})=>{calls+=1;lastRequest={url:String(url),init};if(mode==="reapproval")return response(recovery,409);if(mode==="evm")return response(session(evmBundle()));if(mode==="sol")return response(session(solanaBundle(),solApproval));if(mode==="missing-receipt"){const value=evmBundle();delete value.unsigned_action.safety_receipt;rehashBundleOnly(value);return response(session(value));}if(mode==="hostile-evm"){const value=evmBundle(),evil="0xDeaD00000000000000000000000000000000BeeF";value.unsigned_action.transactions[1].to=evil;value.unsigned_action.safety_receipt.target_or_program_allowlist=[value.unsigned_action.transactions[0].to,evil].sort();rehashEvm(value);return response(session(value));}if(mode==="hostile-sol"){const value=solanaBundle();value.unsigned_action.instructions[2].programId="Evil111111111111111111111111111111111111111";rehashSolana(value);value.unsigned_action.safety_receipt.target_or_program_allowlist=[...new Set(value.unsigned_action.instructions.map((row)=>row.programId))].sort();value.unsigned_action.safety_receipt.selector_or_instruction_allowlist=[...new Set(value.unsigned_action.safety_receipt.payload_binding.raw_payloads.map((row)=>`${row.program_id}:${row.data_prefix_hex}`))].sort();rehashBundleOnly(value);return response(session(value,solApproval));}if(mode==="legacy-binding"){const value=session(evmBundle());value.quote_binding={version:"legacy_advisory",whole_session_path_and_bounds_enforced:false,server_signing:false,server_submission:false};return response(value);}if(mode==="token-echo")return response({...session(evmBundle()),diagnostic_capability:token});throw new Error("unexpected mock mode");};
const handler=new JsonRpcTransportHandler(createAssetFareA2A({apiBaseUrl:"http://127.0.0.1:8791",fetch:fetchMock}).requestHandler);
const common={sessionId,sessionToken:token,verificationContext:evmContext};

for(const [operation,extra] of [["session_get",{}],["observe_source",{idempotencyKey:"a2a-source-0001",transactionHashes:["0x1111111111111111"]}],["observe_output",{idempotencyKey:"a2a-output-0001",transactionHash:"0x2222222222222222"}],["refresh_action",{idempotencyKey:"a2a-refresh-0001"}]]){
  mode="evm";const value=output(await handler.handle(request({operation,...common,...extra},operation),context())).session;
  assert.equal(value.semantic_verification,true);assert.equal(value.action_verification.verified,true);assert.equal(value.action_verification.approval_v3.caller_bounds_enforced,true);assert.equal(value.caller_wallet_handoff.wallet_standard,"EIP-1193");assert.match(value.caller_wallet_handoff.handoff_sha256,/^[0-9a-f]{64}$/);assert.doesNotMatch(JSON.stringify(value),new RegExp(token));
}
mode="evm";const created=output(await handler.handle(request({operation:"session_create",callerApproved:true,fromChain:"base",fromToken:"USDC",toChain:"arbitrum",toToken:"USDC",amountUsd:250,wallets:{base:FROM,arbitrum:TO},sessionToken:token,idempotencyKey:evmApproval.idempotency_key,approvalV3:evmApproval,verificationContext:evmContext},"create"),context())).session;
assert.equal(created.caller_wallet_handoff.wallet_standard,"EIP-1193");const createBody=JSON.parse(String(lastRequest.init.body));assert.equal(Object.prototype.hasOwnProperty.call(createBody,"verificationContext"),false);assert.equal(Object.prototype.hasOwnProperty.call(createBody,"verification_context"),false);

const beforeMissing=calls,missing=output(await handler.handle(request({operation:"session_get",sessionId,sessionToken:token},"missing"),context()));assert.equal(missing.error.code,"session_get_intent_invalid");assert.equal(calls,beforeMissing);
const drift=structuredClone(evmContext);drift.wallets={base:FROM,arbitrum:FROM};const beforeDrift=calls,drifted=output(await handler.handle(request({operation:"session_get",sessionId,sessionToken:token,verificationContext:drift},"drift"),context()));assert.equal(drifted.error.code,"assetfare_safety_boundary_failed");assert.equal(calls,beforeDrift);
mode="missing-receipt";assert.equal(output(await handler.handle(request({operation:"session_get",...common},"missing-receipt"),context())).error.code,"assetfare_safety_boundary_failed");
mode="hostile-evm";assert.equal(output(await handler.handle(request({operation:"session_get",...common},"hostile-evm"),context())).error.code,"assetfare_safety_boundary_failed");
mode="sol";const sol=output(await handler.handle(request({operation:"session_get",sessionId,sessionToken:token,verificationContext:solContext},"sol"),context())).session;assert.equal(sol.action_verification.verified,true);assert.equal(sol.caller_wallet_handoff.wallet_standard,"Solana Wallet Standard");assert.match(sol.caller_wallet_handoff.handoff_sha256,/^[0-9a-f]{64}$/);
mode="hostile-sol";assert.equal(output(await handler.handle(request({operation:"session_get",sessionId,sessionToken:token,verificationContext:solContext},"hostile-sol"),context())).error.code,"assetfare_safety_boundary_failed");
mode="legacy-binding";assert.equal(output(await handler.handle(request({operation:"session_get",...common},"legacy"),context())).error.code,"assetfare_safety_boundary_failed");
mode="token-echo";assert.equal(output(await handler.handle(request({operation:"session_get",...common},"token-echo"),context())).error.code,"assetfare_safety_boundary_failed");
mode="reapproval";const stopped=output(await handler.handle(request({operation:"session_get",...common},"reapproval"),context())).error;assert.equal(stopped.code,"assetfare_reapproval_required");assert.deepEqual(stopped.reapproval,recovery);

console.log(JSON.stringify({status:"pass",a2a_version:"0.3.1",operations_verified:5,evm_handoff:true,solana_handoff:true,hostiles_rejected:7,structured_409_recovery:true,context_required_before_upstream:true,context_not_forwarded:true,raw_token_exposed:false,signing:false,submission:false,live_requests:false}));
