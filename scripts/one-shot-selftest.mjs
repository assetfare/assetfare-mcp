#!/usr/bin/env node
import assert from "node:assert/strict";
import { Message, Role } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, defaultServerCallContextBuilder } from "@a2a-js/sdk/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { A2A_PROTOCOL_VERSION, createAssetFareA2A } from "../src/a2a.js";
import { createServer } from "../src/server.js";
import { sha256 } from "./plan.mjs";
import { approvalFor } from "../test/continuation-fixture.mjs";
import { quoteFixture } from "../test/quote-fixture.mjs";
import { EVENT, FROM, NOW, SOL, TO, evmBundle, rehashBundleOnly, rehashEvm, rehashSolana, solanaBundle } from "../test/action-bundle-fixture.mjs";

const evmIntent={from_chain:"base",from_token:"USDC",to_chain:"arbitrum",to_token:"USDC",amount_usd:250},evmQuote=quoteFixture({...evmIntent,issuedAt:NOW,quote_id:"00000000-0000-4000-8000-000000000001"}),evmApproval=approvalFor(evmQuote,"one_shot","one-shot-0001");
const solIntent={from_chain:"solana",from_token:"USDC",to_chain:"base",to_token:"USDC",amount_usd:250},solQuote=quoteFixture({...solIntent,issuedAt:NOW,quote_id:"00000000-0000-4000-8000-000000000002"}),solApproval=approvalFor(solQuote,"one_shot","one-sol-0001");
function oneShotContext({intent,wallets,eventSignerPublic=null,approval,summary}){const value={version:"assetfare-one-shot-verification-context-v1",intent:structuredClone(intent),wallets:structuredClone(wallets),event_signer_public:eventSignerPublic,approval_v3:structuredClone(approval),direct_route_summary:structuredClone(summary)};return {...value,verification_context_sha256:sha256(value)};}
const evmContext=oneShotContext({intent:evmIntent,wallets:{base:FROM,arbitrum:TO},approval:evmApproval,summary:evmQuote.direct_route_summary}),solContext=oneShotContext({intent:solIntent,wallets:{solana:SOL,base:TO},eventSignerPublic:EVENT,approval:solApproval,summary:solQuote.direct_route_summary});

function response(value,status=200){return new Response(JSON.stringify(value),{status,headers:{"content-type":"application/json"}});}
let mode="evm",calls=0,lastRequest=null;
const fetchMock=async(url,init={})=>{calls+=1;lastRequest={url:String(url),init};if(mode==="evm")return response(evmBundle());if(mode==="sol")return response(solanaBundle());if(mode==="missing-receipt"){const value=evmBundle();delete value.unsigned_action.safety_receipt;rehashBundleOnly(value);return response(value);}if(mode==="hostile-evm"){const value=evmBundle(),evil="0xDeaD00000000000000000000000000000000BeeF";value.unsigned_action.transactions[1].to=evil;value.unsigned_action.safety_receipt.target_or_program_allowlist=[value.unsigned_action.transactions[0].to,evil].sort();rehashEvm(value);return response(value);}if(mode==="hostile-sol"){const value=solanaBundle();value.unsigned_action.instructions[2].programId="Evil111111111111111111111111111111111111111";rehashSolana(value);value.unsigned_action.safety_receipt.target_or_program_allowlist=[...new Set(value.unsigned_action.instructions.map((row)=>row.programId))].sort();value.unsigned_action.safety_receipt.selector_or_instruction_allowlist=[...new Set(value.unsigned_action.safety_receipt.payload_binding.raw_payloads.map((row)=>`${row.program_id}:${row.data_prefix_hex}`))].sort();rehashBundleOnly(value);return response(value);}throw new Error("unexpected mock mode");};

const oldFetch=globalThis.fetch;globalThis.fetch=fetchMock;
const server=createServer({},"v2"),[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(),client=new Client({name:"one-shot-selftest",version:"1"});
function parseMcp(result){return JSON.parse(result.content[0].text);}
function data(value){return {content:{$case:"data",value},metadata:undefined,filename:"",mediaType:"application/json"};}
function a2aRequest(value,id){return {jsonrpc:"2.0",id,method:"SendMessage",params:{message:Message.toJSON({messageId:"m",contextId:"",taskId:"",role:Role.ROLE_USER,parts:[data(value)],metadata:undefined,extensions:[],referenceTaskIds:[]})}};}
function a2aContext(){return defaultServerCallContextBuilder({headers:{},user:undefined,extensions:undefined,requestedVersion:A2A_PROTOCOL_VERSION});}
function a2aOutput(result){return result.result.message.parts[0].data;}
const a2a=new JsonRpcTransportHandler(createAssetFareA2A({apiBaseUrl:"http://127.0.0.1:8791",fetch:fetchMock}).requestHandler);
const mcpEvm={caller_approved:true,...evmIntent,wallets:{base:FROM,arbitrum:TO},approval_v3:evmApproval,verification_context:evmContext},mcpSol={caller_approved:true,...solIntent,wallets:{solana:SOL,base:TO},event_signer_public:EVENT,approval_v3:solApproval,verification_context:solContext};
const a2aEvm={operation:"prepare",callerApproved:true,fromChain:"base",fromToken:"USDC",toChain:"arbitrum",toToken:"USDC",amountUsd:250,wallets:{base:FROM,arbitrum:TO},approvalV3:evmApproval,verificationContext:evmContext},a2aSol={operation:"prepare",callerApproved:true,fromChain:"solana",fromToken:"USDC",toChain:"base",toToken:"USDC",amountUsd:250,wallets:{solana:SOL,base:TO},eventSignerPublic:EVENT,approvalV3:solApproval,verificationContext:solContext};

try{
  await server.connect(serverTransport);await client.connect(clientTransport);
  mode="evm";const mcpValid=parseMcp(await client.callTool({name:"assetfare_v2_prepare",arguments:mcpEvm}));assert.equal(mcpValid.semantic_verification,true);assert.equal(mcpValid.action_verification.verified,true);assert.equal(mcpValid.action_verification.approval_v3.caller_bounds_enforced,true);assert.equal(mcpValid.caller_wallet_handoff.wallet_standard,"EIP-1193");assert.match(mcpValid.caller_wallet_handoff.handoff_sha256,/^[0-9a-f]{64}$/);assert.ok(!JSON.parse(lastRequest.init.body).verification_context);
  mode="sol";const mcpSolValid=parseMcp(await client.callTool({name:"assetfare_v2_prepare",arguments:mcpSol}));assert.equal(mcpSolValid.caller_wallet_handoff.wallet_standard,"Solana Wallet Standard");
  const beforeMissing=calls,missing=await client.callTool({name:"assetfare_v2_prepare",arguments:{...mcpEvm,verification_context:undefined}});assert.equal(missing.isError,true);assert.equal(calls,beforeMissing);
  const drift=structuredClone(evmContext);drift.wallets={base:FROM,arbitrum:FROM};const beforeDrift=calls,drifted=await client.callTool({name:"assetfare_v2_prepare",arguments:{...mcpEvm,verification_context:drift}});assert.equal(drifted.isError,true);assert.equal(calls,beforeDrift);
  mode="missing-receipt";assert.equal((await client.callTool({name:"assetfare_v2_prepare",arguments:mcpEvm})).isError,true);
  mode="hostile-evm";assert.equal((await client.callTool({name:"assetfare_v2_prepare",arguments:mcpEvm})).isError,true);
  mode="hostile-sol";assert.equal((await client.callTool({name:"assetfare_v2_prepare",arguments:mcpSol})).isError,true);

  mode="evm";const a2aValid=a2aOutput(await a2a.handle(a2aRequest(a2aEvm,"a2a-evm"),a2aContext()));assert.equal(a2aValid.semanticVerification,true);assert.equal(a2aValid.actionVerification.verified,true);assert.equal(a2aValid.callerWalletHandoff.wallet_standard,"EIP-1193");assert.match(a2aValid.callerWalletHandoff.handoff_sha256,/^[0-9a-f]{64}$/);assert.ok(!JSON.parse(lastRequest.init.body).verificationContext);assert.ok(!JSON.parse(lastRequest.init.body).verification_context);
  mode="sol";const a2aSolValid=a2aOutput(await a2a.handle(a2aRequest(a2aSol,"a2a-sol"),a2aContext()));assert.equal(a2aSolValid.callerWalletHandoff.wallet_standard,"Solana Wallet Standard");
  const a2aBeforeMissing=calls,a2aMissing=a2aOutput(await a2a.handle(a2aRequest({...a2aEvm,verificationContext:undefined},"a2a-missing"),a2aContext()));assert.equal(a2aMissing.error.code,"prepare_intent_invalid");assert.equal(calls,a2aBeforeMissing);
  mode="hostile-evm";assert.equal(a2aOutput(await a2a.handle(a2aRequest(a2aEvm,"a2a-hostile-evm"),a2aContext())).error.code,"assetfare_safety_boundary_failed");
  mode="hostile-sol";assert.equal(a2aOutput(await a2a.handle(a2aRequest(a2aSol,"a2a-hostile-sol"),a2aContext())).error.code,"assetfare_safety_boundary_failed");
  console.log(JSON.stringify({status:"pass",mcp_one_shot_verified:true,a2a_one_shot_verified:true,evm_handoff:true,solana_handoff:true,hostiles_rejected:8,context_required_before_upstream:true,context_not_forwarded:true,signing:false,submission:false,live_requests:false}));
}finally{await client.close().catch(()=>{});await server.close().catch(()=>{});globalThis.fetch=oldFetch;}
