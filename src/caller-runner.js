/**
 * Caller-owned AssetFare session runner.
 *
 * This module orchestrates a caller's already-approved session but never owns,
 * imports, serializes, logs, signs with, or submits through a private key.  A
 * caller-selected local wallet adapter performs simulation/signing/submission
 * and returns only public summaries and transaction hashes.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { readSessionCapability, sha256 } from "../scripts/plan.mjs";
import { runSession } from "../scripts/session.mjs";

const POLICY_VERSION="assetfare-caller-owned-execution-policy-v2";
const STATE_VERSION="assetfare-caller-owned-runner-state-v2";
const ADAPTER_VERSION="assetfare-caller-wallet-adapter-v2";
const PREPARATION_VERSION="assetfare-caller-wallet-preparation-v2";
const SUBMISSION_VERSION="assetfare-caller-wallet-submission-v2";
const CONFIRMATION_VERSION="assetfare-caller-wallet-confirmation-v2";
const HANDOFF_VERSION="assetfare-caller-wallet-handoff-v3";
const ID=/^[A-Za-z0-9._:-]{8,128}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVM_HASH=/^0x[0-9a-fA-F]{64}$/;
const SOL_HASH=/^[1-9A-HJ-NP-Za-km-z]{32,128}$/;
const FORBIDDEN=["privatekey","seedphrase","mnemonic","secretkey","secretjsonarray","signedtransaction","serializedtransaction","rawtransaction"];

function canonical(value){return JSON.stringify(value,Object.keys(value||{}).sort());}
function digest(value){return sha256(value);}
function bigint(value,label){if(typeof value==="boolean"||value===null||!/^(0|[1-9]\d*)$/.test(String(value)))throw new Error(`assetfare_runner_${label}_invalid`);return BigInt(String(value));}
function safeInteger(value,label,minimum=0,maximum=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(value)||value<minimum||value>maximum)throw new Error(`assetfare_runner_${label}_invalid`);return value;}
function exactKeys(value,keys){return value&&typeof value==="object"&&!Array.isArray(value)&&Object.keys(value).sort().join(",")===[...keys].sort().join(",");}
function nowIso(nowMs=Date.now()){return new Date(nowMs).toISOString();}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function cleanId(value){return String(value).replace(/[^A-Za-z0-9._:-]/g,".").slice(0,72);}

function assertPublic(value,label="adapter_output"){
  const stack=[[value,0]];let seen=0;
  while(stack.length){const [node,depth]=stack.pop();if(++seen>2048||depth>20)throw new Error(`assetfare_runner_${label}_unsafe`);if(Array.isArray(node)){for(const child of node)stack.push([child,depth+1]);continue;}if(node&&typeof node==="object"){for(const [key,child] of Object.entries(node)){const normalized=key.toLowerCase().replaceAll("_","").replaceAll("-","");if(FORBIDDEN.some(term=>normalized.includes(term)))throw new Error(`assetfare_runner_${label}_unsafe`);stack.push([child,depth+1]);}}}
  return value;
}

function readPrivateJson(path,label,maximum=262_144){
  const absolute=resolve(path);let descriptor,metadata,value;
  try{descriptor=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);metadata=fstatSync(descriptor);if(!metadata.isFile()||metadata.nlink!==1||(metadata.mode&0o077)!==0||metadata.uid!==process.getuid()||metadata.size<2||metadata.size>maximum)throw new Error("unsafe");value=JSON.parse(readFileSync(descriptor,"utf8"));}
  catch{throw new Error(`assetfare_runner_${label}_invalid`);}
  finally{if(descriptor!==undefined)closeSync(descriptor);}
  return {absolute,value};
}

function atomicPrivateJson(path,value){
  const absolute=resolve(path),temporary=`${absolute}.tmp-${process.pid}-${randomBytes(12).toString("hex")}`;let descriptor;
  try{descriptor=openSync(temporary,"wx",0o600);writeFileSync(descriptor,`${JSON.stringify(value,null,2)}\n`,{encoding:"utf8"});fsyncSync(descriptor);chmodSync(temporary,0o600);closeSync(descriptor);descriptor=undefined;renameSync(temporary,absolute);chmodSync(absolute,0o600);}
  catch{if(descriptor!==undefined)closeSync(descriptor);throw new Error("assetfare_runner_state_write_failed");}
  return absolute;
}

function validatePolicy(raw,capability,nowMs=Date.now()){
  const keys=["version","authorization_id","status","single_use","automatic_execution_authorized","authorization_expires_at","quote_id","session_id","route","wallets","maximum_input_base","minimum_final_output_base","minimum_action_remaining_seconds","minimum_submit_remaining_seconds","maximum_runtime_seconds","evm","solana","custody"];
  if(!exactKeys(raw,keys)||raw.version!==POLICY_VERSION||!ID.test(raw.authorization_id||"")||raw.status!=="approved"||raw.single_use!==true||raw.automatic_execution_authorized!==true||!UUID.test(raw.quote_id||"")||!UUID.test(raw.session_id||"")||Date.parse(raw.authorization_expires_at)<=nowMs)throw new Error("assetfare_runner_policy_invalid");
  const context=capability.verification_context,approval=context?.approval_v3,intent=context?.intent;
  if(capability.session_id!==raw.session_id||capability.quote_id!==raw.quote_id||approval?.quote_id!==raw.quote_id||approval?.selected_mode!=="session"||raw.route!==`${intent?.from_chain}:${intent?.from_token}->${intent?.to_chain}:${intent?.to_token}`||digest(raw.wallets)!==digest(context?.wallets))throw new Error("assetfare_runner_policy_binding_invalid");
  const maximumInput=bigint(raw.maximum_input_base,"maximum_input"),minimumFinal=bigint(raw.minimum_final_output_base,"minimum_final_output");
  if(maximumInput<=0n||minimumFinal<=0n||bigint(approval.maximum_input_base,"approval_maximum_input")>maximumInput||bigint(approval.minimum_output_base,"approval_minimum_output")<minimumFinal)throw new Error("assetfare_runner_policy_bounds_invalid");
  safeInteger(raw.minimum_action_remaining_seconds,"minimum_remaining",30,170);safeInteger(raw.minimum_submit_remaining_seconds,"minimum_submit_remaining",5,120);if(raw.minimum_submit_remaining_seconds>raw.minimum_action_remaining_seconds)throw new Error("assetfare_runner_policy_submit_margin_invalid");safeInteger(raw.maximum_runtime_seconds,"maximum_runtime",60,3600);
  if(!exactKeys(raw.evm,["maximum_total_native_spend_wei","maximum_fee_per_gas_wei","gas_limit_caps","approval_recovery_gas_limit","allow_approval_revoke_on_failure","maximum_signed_submitted_transactions"])||!Array.isArray(raw.evm.gas_limit_caps)||raw.evm.gas_limit_caps.length<1||raw.evm.gas_limit_caps.length>8||raw.evm.allow_approval_revoke_on_failure!==true)throw new Error("assetfare_runner_policy_evm_invalid");
  const evm={maximum_total_native_spend_wei:bigint(raw.evm.maximum_total_native_spend_wei,"evm_native_cap"),maximum_fee_per_gas_wei:bigint(raw.evm.maximum_fee_per_gas_wei,"evm_fee_cap"),gas_limit_caps:raw.evm.gas_limit_caps.map((v,i)=>bigint(v,`evm_gas_cap_${i}`)),approval_recovery_gas_limit:bigint(raw.evm.approval_recovery_gas_limit,"evm_recovery_gas"),allow_approval_revoke_on_failure:true,maximum_signed_submitted_transactions:safeInteger(raw.evm.maximum_signed_submitted_transactions,"evm_transaction_cap",1,16)};
  if(evm.maximum_total_native_spend_wei<=0n||evm.maximum_fee_per_gas_wei<=0n||evm.gas_limit_caps.some(v=>v<=0n)||evm.approval_recovery_gas_limit<=0n)throw new Error("assetfare_runner_policy_evm_invalid");
  if(!exactKeys(raw.solana,["maximum_total_fee_and_rent_lamports","maximum_signed_submitted_transactions"]))throw new Error("assetfare_runner_policy_solana_invalid");
  const solana={maximum_total_fee_and_rent_lamports:bigint(raw.solana.maximum_total_fee_and_rent_lamports,"solana_cap"),maximum_signed_submitted_transactions:safeInteger(raw.solana.maximum_signed_submitted_transactions,"solana_transaction_cap",1,16)};
  if(solana.maximum_total_fee_and_rent_lamports<=0n)throw new Error("assetfare_runner_policy_solana_invalid");
  if(raw.custody?.key_location!=="caller_wallet_adapter_only"||raw.custody?.assetfare_server_key_access!==false||raw.custody?.assetfare_server_signing!==false||raw.custody?.assetfare_server_submission!==false||raw.custody?.caller_wallet_adapter_signing!==true||raw.custody?.caller_wallet_adapter_submission!==true||raw.custody?.raw_key_serialization_forbidden!==true)throw new Error("assetfare_runner_policy_custody_invalid");
  return {...structuredClone(raw),maximumInput,minimumFinal,evm,solana,sha256:digest(raw)};
}

function validateAdapter(adapter){
  const info=assertPublic(adapter?.info,"adapter_info");
  if(info?.version!==ADAPTER_VERSION||info?.custody!=="caller_owned"||info?.key_location!=="caller_environment_only"||info?.assetfare_server_key_access!==false||info?.assetfare_server_signing!==false||info?.assetfare_server_submission!==false||info?.signs_locally!==true||info?.submits_via_caller_rpc!==true||info?.idempotent_submission_by_operation_id!==true)throw new Error("assetfare_runner_adapter_contract_invalid");
  for(const name of ["prepareEvmRequest","submitEvmRequest","confirmEvmTransaction","prepareEvmApprovalRevocation","submitEvmApprovalRevocation","prepareSolanaAction","submitSolanaAction","confirmSolanaTransaction"])if(typeof adapter[name]!=="function")throw new Error("assetfare_runner_adapter_contract_invalid");
  return adapter;
}

function initialState(policy,nowMs=Date.now()){return {version:STATE_VERSION,authorization_id:policy.authorization_id,policy_sha256:policy.sha256,session_id:policy.session_id,route:policy.route,status:"running",operation_counter:0,actions:[],totals:{evm_maximum_native_spend_wei:"0",evm_protocol_value_wei:"0",evm_actual_fee_wei:"0",evm_actual_native_spend_wei:"0",evm_transactions:0,solana_fee_and_rent_lamports:"0",solana_transactions:0},created_at:nowIso(nowMs),updated_at:nowIso(nowMs),assetfare_server_key_access:false,assetfare_server_signing:false,assetfare_server_submission:false};}

function loadState(path,policy,nowMs=Date.now()){
  try{const {value}=readPrivateJson(path,"state",1_048_576);if(value.version!==STATE_VERSION||value.authorization_id!==policy.authorization_id||value.policy_sha256!==policy.sha256||value.session_id!==policy.session_id||value.route!==policy.route||value.assetfare_server_key_access!==false||value.assetfare_server_signing!==false||value.assetfare_server_submission!==false||!Array.isArray(value.actions)||!Number.isSafeInteger(value.operation_counter))throw new Error("invalid");assertPublic(value,"state");return value;}catch(error){if(error.message!=="assetfare_runner_state_invalid")throw error;const absolute=resolve(path);try{lstatSync(absolute);throw error;}catch(statError){if(statError?.code!=="ENOENT")throw error;}const value=initialState(policy,nowMs);atomicPrivateJson(path,value);return value;}
}
function saveState(path,state,nowMs=Date.now()){state.updated_at=nowIso(nowMs);assertPublic(state,"state");atomicPrivateJson(path,state);return state;}
function nextOperation(state,policy,kind,statePath){state.operation_counter+=1;saveState(statePath,state);const value=`${cleanId(policy.authorization_id)}.${cleanId(kind)}.${state.operation_counter}`;if(!ID.test(value))throw new Error("assetfare_runner_idempotency_invalid");return value;}
function actionState(state,handoff){let value=state.actions.find(item=>item.action_id===handoff.action_id);if(!value){value={action_id:handoff.action_id,step_index:handoff.step_index,chain_family:handoff.chain_family,attempt:1,status:"ready",requests:[],transaction_hashes:[]};state.actions.push(value);}if(value.step_index!==handoff.step_index||value.chain_family!==handoff.chain_family)throw new Error("assetfare_runner_action_state_mismatch");return value;}

function validateHandoff(handoff,policy,capability,nowMs=Date.now()){
  assertPublic(handoff,"handoff");const unhashed={...handoff};delete unhashed.handoff_sha256;
  if(handoff?.version!==HANDOFF_VERSION||handoff.handoff_sha256!==digest(unhashed)||handoff.workflow_id!==policy.session_id||handoff.route!==policy.route||handoff.assetfare_server_key_access!==false||handoff.assetfare_server_signing!==false||handoff.assetfare_server_submission!==false||handoff.assetfare_automatic_wallet_invocation_forbidden!==true||handoff.caller_owned_wallet_adapter_required!==true||handoff.caller_policy_authorization_required!==true||handoff.delegated_agent_execution_supported!==true||handoff.manual_wallet_confirmation_supported!==true||handoff.human_confirmation_required_by_assetfare!==false||handoff.verified_bundle?.server_signing!==false||handoff.verified_bundle?.server_submission!==false||handoff.verification?.verified!==true||handoff.verification?.approval_v3?.path_and_provider_bound!==true)throw new Error("assetfare_runner_handoff_invalid");
  const remaining=Date.parse(handoff.expires_at)-nowMs;if(!Number.isFinite(remaining)||remaining<policy.minimum_action_remaining_seconds*1000)throw new Error("assetfare_runner_handoff_not_wallet_ready");
  const context=capability.verification_context,approval=context.approval_v3,receipt=handoff.verified_bundle.unsigned_action?.safety_receipt;
  if(approval.quote_id!==policy.quote_id||digest(context.wallets)!==digest(policy.wallets)||bigint(approval.maximum_input_base,"approval_maximum")>policy.maximumInput||bigint(approval.minimum_output_base,"approval_minimum")<policy.minimumFinal||receipt?.custody?.server_signing!==false||receipt?.custody?.server_submission!==false)throw new Error("assetfare_runner_handoff_policy_mismatch");
  if(handoff.step_index===0&&bigint(receipt.spend?.maximum_amount_base,"handoff_input")>policy.maximumInput)throw new Error("assetfare_runner_input_cap_exceeded");
  return handoff;
}

function evmRequest(row,index){const request=row?.params?.[0];if(row?.index!==index||row?.method!=="eth_sendTransaction"||row?.assetfare_automatic_invocation_forbidden!==true||row?.caller_owned_policy_required!==true||!request||!/^0x[0-9a-fA-F]{40}$/.test(request.from||"")||!/^0x[0-9a-fA-F]{40}$/.test(request.to||"")||!/^0x(?:[0-9a-fA-F]{2})*$/.test(request.data||"")||!/^0x[0-9a-fA-F]+$/.test(request.value||"")||!/^0x[0-9a-fA-F]+$/.test(request.chainId||""))throw new Error("assetfare_runner_evm_request_invalid");return request;}
function executionWindow(policy,handoff,startedMs){const value={authorization_expires_at:policy.authorization_expires_at,runner_started_at:new Date(startedMs).toISOString(),runner_expires_at:new Date(startedMs+policy.maximum_runtime_seconds*1000).toISOString(),handoff_expires_at:handoff.expires_at,minimum_submit_remaining_seconds:policy.minimum_submit_remaining_seconds};return {...value,execution_window_sha256:digest(value)};}
function assertExecutionWindow(policy,handoff,startedMs,clock,label="submission"){const now=clock(),authorizationExpiry=Date.parse(policy.authorization_expires_at),runnerExpiry=startedMs+policy.maximum_runtime_seconds*1000,handoffExpiry=Date.parse(handoff.expires_at);if(!Number.isFinite(authorizationExpiry)||now>=authorizationExpiry)throw new Error(`assetfare_runner_policy_expired_before_${label}`);if(now>=runnerExpiry)throw new Error(`assetfare_runner_runtime_expired_before_${label}`);if(!Number.isFinite(handoffExpiry)||handoffExpiry-now<policy.minimum_submit_remaining_seconds*1000)throw new Error(`assetfare_runner_handoff_expired_before_${label}`);return executionWindow(policy,handoff,startedMs);}
function publicContext(policy,handoff,startedMs){return {authorization_id:policy.authorization_id,policy_sha256:policy.sha256,route:policy.route,session_id:policy.session_id,action_id:handoff.action_id,step_index:handoff.step_index,execution_window:executionWindow(policy,handoff,startedMs),assetfare_server_key_access:false,assetfare_server_signing:false,assetfare_server_submission:false};}
function validatePreparation(value,{family,operationId,bindingSha,windowSha}){assertPublic(value,"preparation");if(value?.version!==PREPARATION_VERSION||value.family!==family||value.operation_id!==operationId||value.binding_sha256!==bindingSha||value.execution_window_sha256!==windowSha||value.simulation_success!==true||typeof value.preparation_handle!=="string"||value.preparation_handle.length<8||value.preparation_handle.length>256||value.assetfare_server_key_access!==false||value.assetfare_server_signing!==false||value.assetfare_server_submission!==false)throw new Error("assetfare_runner_preparation_invalid");return value;}
function validateSubmission(value,{family,operationId,bindingSha,windowSha}){assertPublic(value,"submission");const regex=family==="evm"?EVM_HASH:SOL_HASH;if(value?.version!==SUBMISSION_VERSION||value.family!==family||value.operation_id!==operationId||value.binding_sha256!==bindingSha||value.execution_window_sha256!==windowSha||!regex.test(value.transaction_hash||"")||value.signed_by!=="caller_wallet_adapter"||value.submitted_by!=="caller_wallet_adapter"||value.assetfare_server_key_access!==false||value.assetfare_server_signing!==false||value.assetfare_server_submission!==false)throw new Error("assetfare_runner_submission_invalid");return value;}
function validateConfirmation(value,{family,operationId,hash,bindingSha,windowSha}){assertPublic(value,"confirmation");if(value?.version!==CONFIRMATION_VERSION||value.family!==family||value.operation_id!==operationId||value.binding_sha256!==bindingSha||value.execution_window_sha256!==windowSha||value.transaction_hash!==hash||value.success!==true||value.finalized!==true||value.assetfare_server_key_access!==false||value.assetfare_server_signing!==false||value.assetfare_server_submission!==false)throw new Error("assetfare_runner_confirmation_invalid");return value;}

async function executeEvm({handoff,adapter,policy,state,statePath,capability,clock,executionStartedMs}){
  const rows=handoff.ordered_requests;if(!Array.isArray(rows)||!rows.length||rows.length>policy.evm.gas_limit_caps.length)throw new Error("assetfare_runner_evm_request_count_invalid");
  const maxFee=policy.evm.maximum_fee_per_gas_wei;let reserve=policy.evm.approval_recovery_gas_limit*maxFee;
  for(let i=0;i<rows.length;i++){const request=evmRequest(rows[i],i);reserve+=BigInt(request.value)+policy.evm.gas_limit_caps[i]*maxFee;}
  if(reserve>policy.evm.maximum_total_native_spend_wei)throw new Error("assetfare_runner_evm_upfront_cap_exceeded");
  const action=actionState(state,handoff),context=publicContext(policy,handoff,executionStartedMs),windowSha=context.execution_window.execution_window_sha256;if(action.maximum_native_reserve_wei===undefined){const aggregate=bigint(state.totals.evm_maximum_native_spend_wei,"state_evm_reserved")+reserve;if(aggregate>policy.evm.maximum_total_native_spend_wei)throw new Error("assetfare_runner_evm_aggregate_cap_exceeded");action.maximum_native_reserve_wei=reserve.toString();state.totals.evm_maximum_native_spend_wei=aggregate.toString();}saveState(statePath,state,clock());let submissionAttempted=false;
  try{
    for(let index=0;index<rows.length;index++){
      const request=evmRequest(rows[index],index);let item=action.requests[index];const bindingSha=digest(request),operationId=`${cleanId(policy.authorization_id)}:${handoff.action_id}:${action.attempt}:${index}`;
      if(item?.confirmed===true){if(item.binding_sha256!==bindingSha)throw new Error("assetfare_runner_evm_resume_binding_mismatch");continue;}
      if(!item?.transaction_hash){
        assertExecutionWindow(policy,handoff,executionStartedMs,clock,"prepare");
        const prepared=validatePreparation(await adapter.prepareEvmRequest({operation_id:operationId,request:structuredClone(request),request_index:index,maximum_gas_limit:policy.evm.gas_limit_caps[index].toString(),maximum_fee_per_gas_wei:maxFee.toString(),context}),{family:"evm",operationId,bindingSha,windowSha});
        const gas=bigint(prepared.gas_limit,"adapter_evm_gas"),fee=bigint(prepared.max_fee_per_gas_wei,"adapter_evm_fee"),maximum=bigint(prepared.maximum_native_spend_wei,"adapter_evm_maximum");
        if(gas>policy.evm.gas_limit_caps[index]||fee>maxFee||maximum!==BigInt(request.value)+gas*fee)throw new Error("assetfare_runner_evm_simulation_cap_exceeded");
        if(state.totals.evm_transactions+1>policy.evm.maximum_signed_submitted_transactions)throw new Error("assetfare_runner_evm_transaction_count_exceeded");
        assertExecutionWindow(policy,handoff,executionStartedMs,clock,"submission");
        submissionAttempted=true;action.status="submission_attempted";saveState(statePath,state,clock());const submitted=validateSubmission(await adapter.submitEvmRequest({operation_id:operationId,preparation_handle:prepared.preparation_handle,binding_sha256:bindingSha,execution_window_sha256:windowSha,context}),{family:"evm",operationId,bindingSha,windowSha});
        item={operation_id:operationId,binding_sha256:bindingSha,execution_window_sha256:windowSha,transaction_hash:submitted.transaction_hash,confirmed:false,maximum_native_spend_wei:maximum.toString(),protocol_value_wei:String(BigInt(request.value))};action.requests[index]=item;action.transaction_hashes=action.requests.filter(Boolean).map(value=>value.transaction_hash);action.status="submitted";state.totals.evm_transactions+=1;saveState(statePath,state,clock());
      }
      const confirmed=validateConfirmation(await adapter.confirmEvmTransaction({operation_id:item.operation_id,transaction_hash:item.transaction_hash,binding_sha256:item.binding_sha256,execution_window_sha256:item.execution_window_sha256,context}),{family:"evm",operationId:item.operation_id,hash:item.transaction_hash,bindingSha:item.binding_sha256,windowSha:item.execution_window_sha256});
      const actual=bigint(confirmed.actual_fee_wei,"adapter_evm_actual_fee"),protocol=bigint(item.protocol_value_wei,"adapter_evm_protocol_value");if(actual+protocol>bigint(item.maximum_native_spend_wei,"adapter_evm_recorded_maximum"))throw new Error("assetfare_runner_evm_actual_fee_exceeded");item.actual_fee_wei=actual.toString();item.confirmed=true;state.totals.evm_actual_fee_wei=(bigint(state.totals.evm_actual_fee_wei,"state_evm_actual")+actual).toString();state.totals.evm_protocol_value_wei=(bigint(state.totals.evm_protocol_value_wei,"state_evm_protocol")+protocol).toString();state.totals.evm_actual_native_spend_wei=(bigint(state.totals.evm_actual_fee_wei,"state_evm_actual")+bigint(state.totals.evm_protocol_value_wei,"state_evm_protocol")).toString();if(bigint(state.totals.evm_actual_native_spend_wei,"state_evm_native")>policy.evm.maximum_total_native_spend_wei)throw new Error("assetfare_runner_evm_actual_total_exceeded");saveState(statePath,state,clock());
    }
  }catch(error){
    const receipt=handoff.verified_bundle.unsigned_action.safety_receipt,approval=receipt?.approval,approvalDone=action.requests[0]?.confirmed===true,downstreamSubmitted=action.requests.slice(1).some(item=>item?.transaction_hash),anySubmitted=action.requests.some(item=>item?.transaction_hash);
    if(!submissionAttempted&&!approvalDone&&!anySubmitted&&action.maximum_native_reserve_wei!==undefined){const reserved=bigint(action.maximum_native_reserve_wei,"state_evm_action_reserve"),aggregate=bigint(state.totals.evm_maximum_native_spend_wei,"state_evm_reserved");if(aggregate<reserved)throw new Error("assetfare_runner_evm_reserve_state_invalid");state.totals.evm_maximum_native_spend_wei=(aggregate-reserved).toString();delete action.maximum_native_reserve_wei;action.status="pre_submission_failed_reservation_released";saveState(statePath,state,clock());}
    else if(submissionAttempted&&!anySubmitted){action.status="submission_outcome_unknown";saveState(statePath,state,clock());}
    if(approval?.required===true&&approvalDone&&!downstreamSubmitted&&policy.evm.allow_approval_revoke_on_failure){
      const operationId=`${cleanId(policy.authorization_id)}:${handoff.action_id}:${action.attempt}:revoke`,bindingSha=digest({chain_id:handoff.chain_id,owner:receipt.parties.caller,token:approval.token,target:approval.target,allowance_base:"0"});
      if(state.totals.evm_transactions+1>policy.evm.maximum_signed_submitted_transactions)throw new Error("assetfare_runner_evm_recovery_transaction_count_exceeded");
      assertExecutionWindow(policy,handoff,executionStartedMs,clock,"recovery_prepare");
      const prepared=validatePreparation(await adapter.prepareEvmApprovalRevocation({operation_id:operationId,chain_id:handoff.chain_id,owner:receipt.parties.caller,token:approval.token,target:approval.target,maximum_gas_limit:policy.evm.approval_recovery_gas_limit.toString(),maximum_fee_per_gas_wei:maxFee.toString(),binding_sha256:bindingSha,context}),{family:"evm",operationId,bindingSha,windowSha});
      const gas=bigint(prepared.gas_limit,"adapter_evm_recovery_gas"),fee=bigint(prepared.max_fee_per_gas_wei,"adapter_evm_recovery_fee_cap");if(gas>policy.evm.approval_recovery_gas_limit||fee>maxFee)throw new Error("assetfare_runner_approval_recovery_cap_exceeded");
      assertExecutionWindow(policy,handoff,executionStartedMs,clock,"recovery_submission");
      const submitted=validateSubmission(await adapter.submitEvmApprovalRevocation({operation_id:operationId,preparation_handle:prepared.preparation_handle,binding_sha256:bindingSha,execution_window_sha256:windowSha,context}),{family:"evm",operationId,bindingSha,windowSha});
      const recovered=validateConfirmation(await adapter.confirmEvmTransaction({operation_id:operationId,transaction_hash:submitted.transaction_hash,binding_sha256:bindingSha,execution_window_sha256:windowSha,context}),{family:"evm",operationId,hash:submitted.transaction_hash,bindingSha,windowSha});if(recovered.allowance_after_base!=="0")throw new Error("assetfare_runner_approval_recovery_failed");
      const recoveryFee=bigint(recovered.actual_fee_wei,"adapter_evm_recovery_fee");if(recoveryFee>gas*fee)throw new Error("assetfare_runner_approval_recovery_cap_exceeded");state.totals.evm_transactions+=1;state.totals.evm_actual_fee_wei=(bigint(state.totals.evm_actual_fee_wei,"state_evm_actual")+recoveryFee).toString();state.totals.evm_actual_native_spend_wei=(bigint(state.totals.evm_actual_fee_wei,"state_evm_actual")+bigint(state.totals.evm_protocol_value_wei,"state_evm_protocol")).toString();action.recoveries=[...(action.recoveries||[]),{transaction_hash:recovered.transaction_hash,allowance_after_base:"0",actual_fee_wei:recoveryFee.toString()}];action.attempt+=1;action.requests=[];action.transaction_hashes=[];action.status="retryable_after_approval_recovery";saveState(statePath,state,clock());
    }
    throw error;
  }
  action.status="confirmed";saveState(statePath,state,clock());return [...action.transaction_hashes];
}

async function executeSolana({handoff,adapter,policy,state,statePath,clock,executionStartedMs}){
  const construction=handoff.transaction_construction;if(!construction||handoff.wallet_method_after_construction!=="signAndSendTransaction"||handoff.assetfare_automatic_method_invocation_forbidden!==true||handoff.caller_owned_policy_required!==true||!Array.isArray(construction.instructions)||!construction.instructions.length)throw new Error("assetfare_runner_solana_construction_invalid");
  const action=actionState(state,handoff),bindingSha=digest(construction),operationId=`${cleanId(policy.authorization_id)}:${handoff.action_id}:${action.attempt}:0`,context=publicContext(policy,handoff,executionStartedMs),windowSha=context.execution_window.execution_window_sha256;let item=action.requests[0];
  if(!item?.transaction_hash){
    assertExecutionWindow(policy,handoff,executionStartedMs,clock,"prepare");
    const prepared=validatePreparation(await adapter.prepareSolanaAction({operation_id:operationId,construction:structuredClone(construction),maximum_fee_and_rent_lamports:policy.solana.maximum_total_fee_and_rent_lamports.toString(),context}),{family:"solana",operationId,bindingSha,windowSha});
    const total=bigint(prepared.maximum_fee_and_rent_lamports,"adapter_solana_maximum");if(bigint(state.totals.solana_fee_and_rent_lamports,"state_solana_previous")+total>policy.solana.maximum_total_fee_and_rent_lamports)throw new Error("assetfare_runner_solana_simulation_cap_exceeded");if(state.totals.solana_transactions+1>policy.solana.maximum_signed_submitted_transactions)throw new Error("assetfare_runner_solana_transaction_count_exceeded");
    assertExecutionWindow(policy,handoff,executionStartedMs,clock,"submission");
    const submitted=validateSubmission(await adapter.submitSolanaAction({operation_id:operationId,preparation_handle:prepared.preparation_handle,binding_sha256:bindingSha,execution_window_sha256:windowSha,context}),{family:"solana",operationId,bindingSha,windowSha});
    item={operation_id:operationId,binding_sha256:bindingSha,execution_window_sha256:windowSha,transaction_hash:submitted.transaction_hash,confirmed:false,maximum_fee_and_rent_lamports:total.toString()};action.requests[0]=item;action.transaction_hashes=[item.transaction_hash];action.status="submitted";state.totals.solana_transactions+=1;saveState(statePath,state,clock());
  }
  if(!item.confirmed){const confirmed=validateConfirmation(await adapter.confirmSolanaTransaction({operation_id:item.operation_id,transaction_hash:item.transaction_hash,binding_sha256:item.binding_sha256,execution_window_sha256:item.execution_window_sha256,context}),{family:"solana",operationId:item.operation_id,hash:item.transaction_hash,bindingSha:item.binding_sha256,windowSha:item.execution_window_sha256});const total=bigint(confirmed.actual_fee_and_rent_lamports,"adapter_solana_actual");if(total>bigint(item.maximum_fee_and_rent_lamports,"adapter_solana_recorded_maximum"))throw new Error("assetfare_runner_solana_actual_fee_exceeded");item.actual_fee_and_rent_lamports=total.toString();item.confirmed=true;state.totals.solana_fee_and_rent_lamports=(bigint(state.totals.solana_fee_and_rent_lamports,"state_solana_actual")+total).toString();if(bigint(state.totals.solana_fee_and_rent_lamports,"state_solana_total")>policy.solana.maximum_total_fee_and_rent_lamports)throw new Error("assetfare_runner_solana_total_cap_exceeded");saveState(statePath,state,clock());}
  action.status="confirmed";saveState(statePath,state,clock());return [...action.transaction_hashes];
}

async function sessionCall(operation,capabilityPath,{idempotencyKey,transactionHashes=[],apiBase,fetchImpl,nowMs}={}){
  const args=["--operation",operation,"--capability-file",capabilityPath,...(idempotencyKey?["--idempotency-key",idempotencyKey]:[]),...transactionHashes.flatMap(value=>["--transaction-hash",value]),...(apiBase?["--api-base",apiBase]:[])];return runSession(args,{fetchImpl,stdout:{write(){}},nowMs,allowExpiredActionWithoutHandoff:true});
}

async function preflightCallerOwnedSession({capabilityFile,policyFile,walletAdapter,apiBase,fetchImpl=fetch,clock=Date.now,sessionClient=null}){
  const capability=readSessionCapability(capabilityFile),{value:rawPolicy}=readPrivateJson(policyFile,"policy"),policy=validatePolicy(rawPolicy,capability,clock()),adapter=validateAdapter(walletAdapter),call=sessionClient?.call?((operation,options={})=>sessionClient.call(operation,options)):((operation,options={})=>sessionCall(operation,capabilityFile,{...options,apiBase,fetchImpl,nowMs:undefined})),current=await call("get",{}),session=current.session;
  let handoffReady=false,remainingSeconds=null,actionId=null;
  if(current.caller_wallet_handoff){const handoff=validateHandoff(current.caller_wallet_handoff,policy,capability,clock());handoffReady=true;remainingSeconds=Math.floor((Date.parse(handoff.expires_at)-clock())/1000);actionId=handoff.action_id;}
  return {status:"preflight_pass",authorization_id:policy.authorization_id,session_id:policy.session_id,route:policy.route,session_status:session.status,current_step:session.current_step??null,action_id:actionId,handoff_wallet_ready:handoffReady,remaining_seconds:remainingSeconds,key_location:"caller_wallet_adapter_only",wallet_adapter_contract:adapter.info.version,assetfare_server_key_access:false,assetfare_server_signing:false,assetfare_server_submission:false,signing:false,submission:false};
}

async function runCallerOwnedSession({capabilityFile,policyFile,stateFile,walletAdapter,apiBase,fetchImpl=fetch,pollIntervalMs=5_000,clock=Date.now,sleep=wait,onProgress=()=>{},sessionClient=null}){
  const capability=readSessionCapability(capabilityFile),{value:rawPolicy}=readPrivateJson(policyFile,"policy"),policy=validatePolicy(rawPolicy,capability,clock()),adapter=validateAdapter(walletAdapter),state=loadState(stateFile,policy,clock()),started=Date.parse(state.created_at);if(!Number.isFinite(started)||started>clock()+5_000)throw new Error("assetfare_runner_state_started_at_invalid");
  const call=sessionClient?.call?((operation,options={})=>sessionClient.call(operation,options)):((operation,options={})=>sessionCall(operation,capabilityFile,{...options,apiBase,fetchImpl,nowMs:undefined}));
  if(state.status==="complete")return runnerResult(state,policy);
  for(let cycle=0;cycle<256;cycle++){
    if(clock()-started>policy.maximum_runtime_seconds*1000)throw new Error("assetfare_runner_runtime_exceeded");
    let current=await call("get",{});const session=current.session;
    if(session.status==="complete"){
      const last=session.workflow?.steps?.at(-1),actual=bigint(last?.actual_output_base,"final_output");if(actual<policy.minimumFinal)throw new Error("assetfare_runner_final_output_below_policy");state.status="complete";state.completed_at=nowIso(clock());state.final_output_base=actual.toString();saveState(stateFile,state,clock());onProgress({event:"complete",session_id:policy.session_id,final_output_base:actual.toString()});return runnerResult(state,policy);
    }
    if(["bridge_in_flight","awaiting_output_receipt"].includes(session.status)){
      state.idempotency??={};const keyName=`output_${session.current_step}`;state.idempotency[keyName]??=nextOperation(state,policy,keyName,stateFile);saveState(stateFile,state,clock());
      try{current=await call("observe-output",{idempotencyKey:state.idempotency[keyName]});onProgress({event:"output_observed",step_index:session.current_step});}
      catch(error){const live=await call("get",{});if(!["bridge_in_flight","awaiting_output_receipt"].includes(live.session.status))continue;if(!["assetfare_plan_request_rejected","assetfare_plan_upstream_unavailable","assetfare_plan_rate_limited"].includes(String(error.message)))throw error;await sleep(pollIntervalMs);continue;}
      continue;
    }
    if(!["action_ready","action_expired","awaiting_action_build"].includes(session.status))throw new Error(`assetfare_runner_session_state_unsupported:${session.status}`);
    let handoff=current.caller_wallet_handoff,remaining=session.current_action?Date.parse(session.current_action.expires_at)-clock():null;
    if(session.status!=="action_ready"||!handoff||remaining<policy.minimum_action_remaining_seconds*1000){
      if(session.status==="action_ready"&&Number.isFinite(remaining)&&remaining>0){await sleep(Math.min(remaining+1000,180_000));continue;}
      const key=nextOperation(state,policy,`ready_${session.current_step}`,stateFile);current=await call("refresh",{idempotencyKey:key});handoff=current.caller_wallet_handoff;if(!handoff)continue;
    }
    validateHandoff(handoff,policy,capability,clock());onProgress({event:"wallet_ready",action_id:handoff.action_id,step_index:handoff.step_index,chain_family:handoff.chain_family,remaining_seconds:Math.floor((Date.parse(handoff.expires_at)-clock())/1000)});
    const hashes=handoff.chain_family==="evm"?await executeEvm({handoff,adapter,policy,state,statePath:stateFile,capability,clock,executionStartedMs:started}):handoff.chain_family==="solana"?await executeSolana({handoff,adapter,policy,state,statePath:stateFile,clock,executionStartedMs:started}):(()=>{throw new Error("assetfare_runner_chain_family_invalid");})();
    state.idempotency??={};const keyName=`source_${handoff.step_index}_${handoff.action_id}`,key=state.idempotency[keyName]??nextOperation(state,policy,keyName,stateFile);state.idempotency[keyName]=key;saveState(stateFile,state,clock());
    await call("observe-source",{idempotencyKey:key,transactionHashes:hashes});const action=actionState(state,handoff);action.status="observed";saveState(stateFile,state,clock());onProgress({event:"source_observed",action_id:handoff.action_id,transaction_hashes:[...hashes]});
  }
  throw new Error("assetfare_runner_cycle_limit_exceeded");
}

function runnerResult(state,policy){return {status:state.status,authorization_id:policy.authorization_id,session_id:policy.session_id,route:policy.route,final_output_base:state.final_output_base??null,actions:state.actions.map(item=>({action_id:item.action_id,step_index:item.step_index,chain_family:item.chain_family,status:item.status,transaction_hashes:[...item.transaction_hashes]})),totals:structuredClone(state.totals),key_location:"caller_wallet_adapter_only",signed_by:"caller_wallet_adapter",submitted_by:"caller_wallet_adapter",assetfare_server_key_access:false,assetfare_server_signing:false,assetfare_server_submission:false};}

export { ADAPTER_VERSION, CONFIRMATION_VERSION, HANDOFF_VERSION, POLICY_VERSION, PREPARATION_VERSION, STATE_VERSION, SUBMISSION_VERSION, assertPublic, preflightCallerOwnedSession, runCallerOwnedSession, validateAdapter, validateHandoff, validatePolicy };
