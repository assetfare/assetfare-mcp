#!/usr/bin/env node
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { sessionVerificationContext } from "./plan.mjs";
import { approvalFor, sessionBindingFor } from "../test/continuation-fixture.mjs";
import { quoteFixture } from "../test/quote-fixture.mjs";
import { EVENT, FROM, NOW, SOL, TO, evmBundle, rehashBundleOnly, rehashEvm, rehashSolana, solanaBundle } from "../test/action-bundle-fixture.mjs";

const token="R".repeat(43),sessionId="00000000-0000-4000-8000-000000000099";
const evmIntent={from_chain:"base",from_token:"USDC",to_chain:"arbitrum",to_token:"USDC",amount_usd:250},evmQuote=quoteFixture({...evmIntent,issuedAt:NOW,quote_id:"00000000-0000-4000-8000-000000000001"}),evmApproval=approvalFor(evmQuote,"session","remote-create-0001"),evmStored=sessionVerificationContext({intent:evmIntent,wallets:{base:FROM,arbitrum:TO},approval:evmApproval,directRouteSummary:evmQuote.direct_route_summary}),evmContext={...evmStored.value,verification_context_sha256:evmStored.sha256};
const solIntent={from_chain:"solana",from_token:"USDC",to_chain:"base",to_token:"USDC",amount_usd:250},solQuote=quoteFixture({...solIntent,issuedAt:NOW,quote_id:"00000000-0000-4000-8000-000000000002"}),solApproval=approvalFor(solQuote,"session","remote-sol-0001"),solStored=sessionVerificationContext({intent:solIntent,wallets:{solana:SOL,base:TO},eventSignerPublic:EVENT,approval:solApproval,directRouteSummary:solQuote.direct_route_summary}),solContext={...solStored.value,verification_context_sha256:solStored.sha256};

function session(action,approval=evmApproval){return {session_id:sessionId,status:action?"action_ready":"ready",action_available:Boolean(action),current_action:action,quote_binding:sessionBindingFor(approval),server_signing:false,server_submission:false,signed:false,submitted:false};}
function response(value,status=200){return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});}
function parse(result){return JSON.parse(result.content[0].text);}
async function call(client,name,args){return client.callTool({name,arguments:args});}

const originalFetch=globalThis.fetch;let mode="evm",lastRequest=null,calls=0;
globalThis.fetch=async(url,init={})=>{calls+=1;lastRequest={url:String(url),init};if(mode==="evm")return response(session(evmBundle()));if(mode==="sol")return response(session(solanaBundle(),solApproval));if(mode==="missing-receipt"){const value=evmBundle();delete value.unsigned_action.safety_receipt;rehashBundleOnly(value);return response(session(value));}if(mode==="hostile-evm"){const value=evmBundle(),evil="0xDeaD00000000000000000000000000000000BeeF";value.unsigned_action.transactions[1].to=evil;value.unsigned_action.safety_receipt.target_or_program_allowlist=[value.unsigned_action.transactions[0].to,evil].sort();rehashEvm(value);return response(session(value));}if(mode==="hostile-sol"){const value=solanaBundle();value.unsigned_action.instructions[2].programId="Evil111111111111111111111111111111111111111";rehashSolana(value);value.unsigned_action.safety_receipt.target_or_program_allowlist=[...new Set(value.unsigned_action.instructions.map((row)=>row.programId))].sort();value.unsigned_action.safety_receipt.selector_or_instruction_allowlist=[...new Set(value.unsigned_action.safety_receipt.payload_binding.raw_payloads.map((row)=>`${row.program_id}:${row.data_prefix_hex}`))].sort();rehashBundleOnly(value);return response(session(value,solApproval));}if(mode==="legacy-binding"){const value=session(evmBundle());value.quote_binding={version:"legacy_advisory",whole_session_path_and_bounds_enforced:false,server_signing:false,server_submission:false};return response(value);}if(mode==="token-echo")return response({...session(evmBundle()),diagnostic_capability:token});throw new Error("unexpected mock mode");};

const server=createServer({},"v2"),[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(),client=new Client({name:"assetfare-remote-session-selftest",version:"1"});
try{
  await server.connect(serverTransport);await client.connect(clientTransport);
  const args={session_token:token,session_id:sessionId,verification_context:evmContext};
  mode="evm";const valid=parse(await call(client,"assetfare_v2_session_get",args));assert.equal(valid.semantic_verification,true);assert.equal(valid.action_verification.verified,true);assert.equal(valid.caller_wallet_handoff.wallet_standard,"EIP-1193");assert.doesNotMatch(JSON.stringify(valid),new RegExp(token));
  const beforeMissing=calls,missing=await call(client,"assetfare_v2_session_get",{session_token:token,session_id:sessionId});assert.equal(missing.isError,true);assert.match(missing.content[0].text,/Required at verification_context/);assert.equal(calls,beforeMissing);
  mode="missing-receipt";const noReceipt=await call(client,"assetfare_v2_session_get",args);assert.equal(noReceipt.isError,true);assert.match(parse(noReceipt).error,/bundle_receipt_invalid|receipt_version/);
  mode="hostile-evm";const evmHostile=await call(client,"assetfare_v2_session_get",args);assert.equal(evmHostile.isError,true);assert.match(parse(evmHostile).error,/evm_cctp_target/);
  mode="sol";const solValid=parse(await call(client,"assetfare_v2_session_get",{session_token:token,session_id:sessionId,verification_context:solContext}));assert.equal(solValid.action_verification.verified,true);assert.equal(solValid.caller_wallet_handoff.wallet_standard,"Solana Wallet Standard");
  mode="hostile-sol";const solHostile=await call(client,"assetfare_v2_session_get",{session_token:token,session_id:sessionId,verification_context:solContext});assert.equal(solHostile.isError,true);assert.match(parse(solHostile).error,/solana_program_pins/);
  const drift={...structuredClone(evmContext),wallets:{base:FROM,arbitrum:FROM}};delete drift.verification_context_sha256;drift.verification_context_sha256=evmStored.sha256;mode="evm";const drifted=await call(client,"assetfare_v2_session_get",{session_token:token,session_id:sessionId,verification_context:drift});assert.equal(drifted.isError,true);assert.match(parse(drifted).error,/context_hash_mismatch/);
  mode="legacy-binding";const legacy=await call(client,"assetfare_v2_session_get",args);assert.equal(legacy.isError,true);assert.match(parse(legacy).error,/quote_binding_mismatch/);
  mode="token-echo";const echo=await call(client,"assetfare_v2_session_get",args);assert.equal(echo.isError,true);assert.match(parse(echo).error,/session_token_echo_rejected/);
  mode="evm";const create=parse(await call(client,"assetfare_v2_session_create",{caller_approved:true,...evmIntent,wallets:{base:FROM,arbitrum:TO},approval_v3:evmApproval,session_token:token,idempotency_key:evmApproval.idempotency_key,verification_context:evmContext}));assert.equal(create.semantic_verification,true);assert.equal(create.caller_wallet_handoff.wallet_standard,"EIP-1193");assert.ok(!JSON.parse(lastRequest.init.body).verification_context,"verification context must remain caller-side");
  console.log(JSON.stringify({status:"pass",remote_mcp_semantic_verification:true,remote_mcp_evm_handoff:true,remote_mcp_solana_handoff:true,hostiles_rejected:7,context_required_before_upstream:true,context_not_forwarded:true,raw_token_exposed:false,signing:false,submission:false,live_requests:false}));
}finally{await client.close().catch(()=>{});await server.close().catch(()=>{});globalThis.fetch=originalFetch;}
