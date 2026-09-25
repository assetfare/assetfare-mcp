#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFailure, runSession } from "./session.mjs";
import { sessionVerificationContext } from "./plan.mjs";
import { approvalFor, sessionBindingFor } from "../test/continuation-fixture.mjs";
import { quoteFixture } from "../test/quote-fixture.mjs";
import { EVENT, FROM, NOW, SOL, TO, evmBundle, rehashBundleOnly, rehashEvm, rehashSolana, solanaBundle } from "../test/action-bundle-fixture.mjs";

const directory=mkdtempSync(join(tmpdir(),"assetfare-session-"));
const token="A".repeat(43),sessionId="00000000-0000-4000-8000-000000000099";
const evmIntent={from_chain:"base",from_token:"USDC",to_chain:"arbitrum",to_token:"USDC",amount_usd:250};
const evmQuote=quoteFixture({...evmIntent,issuedAt:NOW,quote_id:"00000000-0000-4000-8000-000000000001"});
const evmApproval=approvalFor(evmQuote,"session","create-0001");
const evmContext=sessionVerificationContext({intent:evmIntent,wallets:{base:FROM,arbitrum:TO},approval:evmApproval,directRouteSummary:evmQuote.direct_route_summary});
const capabilityPath=join(directory,"session-capability.json");

function capability(context=evmContext,approval=evmApproval){return {version:"assetfare-caller-session-capability-v2",session_token:token,quote_id:approval.quote_id,idempotency_key:approval.idempotency_key,session_id:sessionId,verification_context:context.value,verification_context_sha256:context.sha256,sensitivity:"sensitive_bearer_capability",is_private_key:false};}
function save(path,value){writeFileSync(path,`${JSON.stringify(value)}\n`,{mode:0o600});chmodSync(path,0o600);}
save(capabilityPath,capability());

function payload({action=null,approval=evmApproval}={}){return {session_id:sessionId,status:action?"action_ready":"ready",action_available:Boolean(action),current_action:action,quote_binding:sessionBindingFor(approval),server_signing:false,server_submission:false,signed:false,submitted:false};}
function mock({action=null,approval=evmApproval,echo=false,responseStatus=200,responsePayload=null}={}){const calls=[];return {calls,fetch:async(url,init={})=>{calls.push({url:String(url),init});const body=responsePayload||{...payload({action,approval}),...(echo?{diagnostic_capability:init.headers["x-assetfare-session-token"]}:{})};return new Response(JSON.stringify(body),{status:responseStatus,headers:{"content-type":"application/json"}});}};}

try{
  for(const [operation,extra,suffix,method] of [
    ["get",[],`/v2/session/${sessionId}`,"GET"],
    ["observe-source",["--idempotency-key","source-0001","--transaction-hash","0xsourcehash000001"],`/v2/session/${sessionId}/observe-source`,"POST"],
    ["observe-output",["--idempotency-key","output-0001","--transaction-hash","0xoutputhash000001"],`/v2/session/${sessionId}/observe-output`,"POST"],
    ["refresh",["--idempotency-key","refresh-0001"],`/v2/session/${sessionId}/refresh-action`,"POST"],
  ]){
    const network=mock();let output="";const result=await runSession(["--operation",operation,"--capability-file",capabilityPath,...extra,"--api-base","http://127.0.0.1:8788"],{fetchImpl:network.fetch,stdout:{write:value=>{output+=value;}},nowMs:NOW+100});
    assert.equal(new URL(network.calls[0].url).pathname,suffix);assert.equal(network.calls[0].init.method||"GET",method);assert.equal(network.calls[0].init.headers["x-assetfare-session-token"],token);assert.equal(result.strict_quote_binding_verified,true);assert.equal(result.raw_session_token_exposed,false);assert.ok(!output.includes(token));
  }

  const evmHandoffPath=join(directory,"evm-step-handoff.json"),evmNetwork=mock({action:evmBundle()});let evmOutput="";
  const evmResult=await runSession(["--operation","get","--capability-file",capabilityPath,"--wallet-handoff-output",evmHandoffPath,"--api-base","http://127.0.0.1:8788"],{fetchImpl:evmNetwork.fetch,stdout:{write:value=>{evmOutput+=value;}},nowMs:NOW+100});
  const evmHandoff=JSON.parse(readFileSync(evmHandoffPath,"utf8"));assert.equal(lstatSync(evmHandoffPath).mode&0o777,0o600);assert.equal(evmResult.verification.verified,true);assert.equal(evmResult.verification.approval_v3.path_and_provider_bound,true);assert.equal(evmHandoff.wallet_standard,"EIP-1193");assert.equal(evmHandoff.verified_bundle.unsigned_action.safety_receipt.schema_version,1);assert.ok(!evmOutput.includes(token));

  const missingReceipt=evmBundle();delete missingReceipt.unsigned_action.safety_receipt;rehashBundleOnly(missingReceipt);
  await assert.rejects(()=>runSession(["--operation","get","--capability-file",capabilityPath,"--api-base","http://127.0.0.1:8788"],{fetchImpl:mock({action:missingReceipt}).fetch,stdout:{write(){}},nowMs:NOW+100}),/bundle_receipt_invalid|receipt_version/);
  const hostileTarget=evmBundle(),evilTarget="0xDeaD00000000000000000000000000000000BeeF";hostileTarget.unsigned_action.transactions[1].to=evilTarget;hostileTarget.unsigned_action.safety_receipt.target_or_program_allowlist=[hostileTarget.unsigned_action.transactions[0].to,evilTarget].sort();rehashEvm(hostileTarget);
  await assert.rejects(()=>runSession(["--operation","get","--capability-file",capabilityPath,"--api-base","http://127.0.0.1:8788"],{fetchImpl:mock({action:hostileTarget}).fetch,stdout:{write(){}},nowMs:NOW+100}),/evm_cctp_target/);

  const solIntent={from_chain:"solana",from_token:"USDC",to_chain:"base",to_token:"USDC",amount_usd:250};
  const solQuote=quoteFixture({...solIntent,issuedAt:NOW,quote_id:"00000000-0000-4000-8000-000000000002"}),solApproval=approvalFor(solQuote,"session","sol-create-0001"),solContext=sessionVerificationContext({intent:solIntent,wallets:{solana:SOL,base:TO},eventSignerPublic:EVENT,approval:solApproval,directRouteSummary:solQuote.direct_route_summary}),solCapabilityPath=join(directory,"solana-capability.json");save(solCapabilityPath,capability(solContext,solApproval));
  const solHandoffPath=join(directory,"solana-step-handoff.json"),solResult=await runSession(["--operation","get","--capability-file",solCapabilityPath,"--wallet-handoff-output",solHandoffPath,"--api-base","http://127.0.0.1:8788"],{fetchImpl:mock({action:solanaBundle(),approval:solApproval}).fetch,stdout:{write(){}},nowMs:NOW+100});
  assert.equal(solResult.verification.verified,true);assert.equal(solResult.caller_wallet_handoff.wallet_standard,"Solana Wallet Standard");assert.ok(solResult.caller_wallet_handoff.transaction_construction.required_signers.includes(EVENT));
  const hostileProgram=solanaBundle();hostileProgram.unsigned_action.instructions[2].programId="Evil111111111111111111111111111111111111111";rehashSolana(hostileProgram);hostileProgram.unsigned_action.safety_receipt.target_or_program_allowlist=[...new Set(hostileProgram.unsigned_action.instructions.map((row)=>row.programId))].sort();hostileProgram.unsigned_action.safety_receipt.selector_or_instruction_allowlist=[...new Set(hostileProgram.unsigned_action.safety_receipt.payload_binding.raw_payloads.map((row)=>`${row.program_id}:${row.data_prefix_hex}`))].sort();rehashBundleOnly(hostileProgram);
  await assert.rejects(()=>runSession(["--operation","get","--capability-file",solCapabilityPath,"--api-base","http://127.0.0.1:8788"],{fetchImpl:mock({action:hostileProgram,approval:solApproval}).fetch,stdout:{write(){}},nowMs:NOW+100}),/solana_program_pins/);

  const legacyPath=join(directory,"legacy-capability.json");save(legacyPath,{version:"assetfare-caller-session-capability-v1",session_token:token,quote_id:evmApproval.quote_id,idempotency_key:evmApproval.idempotency_key,session_id:sessionId,sensitivity:"sensitive_bearer_capability",is_private_key:false});
  await assert.rejects(()=>runSession(["--operation","get","--capability-file",legacyPath,"--api-base","http://127.0.0.1:8788"],{fetchImpl:mock({action:evmBundle()}).fetch,stdout:{write(){}},nowMs:NOW+100}),/verification_context_required/);
  const weakBinding=payload({action:null});weakBinding.quote_binding={version:"legacy_advisory",whole_session_path_and_bounds_enforced:false,server_signing:false,server_submission:false};
  await assert.rejects(()=>runSession(["--operation","get","--capability-file",capabilityPath,"--api-base","http://127.0.0.1:8788"],{fetchImpl:mock({responsePayload:weakBinding}).fetch,stdout:{write(){}},nowMs:NOW+100}),/quote_binding_mismatch/);

  const recovery={error:"reapproval_required",reason:"approval_v3_quote_not_found_or_process_restarted",action_created:false,fresh_read_only_quote_required:true,new_quote_is_not_action_authority:true,do_not_repeat_confirmed_steps:false,do_not_start_new_session:false,recover_current_session:false,recovery_operation:"obtain_new_quote_and_make_new_selection",replacement_approval_endpoint_available:true,selection_status:"unranked_candidate",automatic_selection_forbidden:true,caller_approved_boolean_is_not_human_proof:true,required_wallet_chains:["arbitrum","base"],event_signer_public_required:false,server_signing:false,server_submission:false};
  let recoveryError;try{await runSession(["--operation","refresh","--capability-file",capabilityPath,"--idempotency-key","refresh-409","--api-base","http://127.0.0.1:8788"],{fetchImpl:mock({responseStatus:409,responsePayload:recovery}).fetch,stdout:{write(){}},nowMs:NOW+100});}catch(error){recoveryError=error;}
  const failure=sessionFailure(recoveryError);assert.equal(failure.recovery.do_not_repeat_confirmed_steps,false);assert.equal(failure.recovery.do_not_start_new_session,false);assert.equal(failure.next_action,"obtain_new_quote_and_make_new_selection");assert.ok(!JSON.stringify(failure).includes(token));

  let calls=0;await assert.rejects(()=>runSession(["--operation","observe-source","--capability-file",capabilityPath,"--idempotency-key","source-0002"],{fetchImpl:async()=>{calls+=1;},stdout:{write(){}}}),/transaction_hash_missing/);assert.equal(calls,0);
  const echo=mock({echo:true});await assert.rejects(()=>runSession(["--operation","get","--capability-file",capabilityPath,"--api-base","http://127.0.0.1:8788"],{fetchImpl:echo.fetch,stdout:{write(){}},nowMs:NOW+100}),/session_token_echo_rejected/);
  console.log(JSON.stringify({status:"pass",operations:4,strict_v3_binding:true,later_evm_handoff:true,later_solana_handoff:true,later_action_hostiles_rejected:4,structured_409_recovery:true,capability_file_mode:"0600",raw_token_exposed:false,signing:false,submission:false,live_requests:false}));
}finally{rmSync(directory,{recursive:true,force:true});}
