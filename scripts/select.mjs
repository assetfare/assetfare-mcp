#!/usr/bin/env node
/** Offline explicit selection: exact quote JSON -> strict approval_v3 file. Network calls: zero. */

import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { APPROVAL_V3_VERSION, validateApprovalV3, validateContinuationV3 } from "../src/continuation-v3.js";
import { isMain } from "../src/is-main.js";
import { parseV2Quote } from "../src/server.js";

const MAX_QUOTE_BYTES=1_048_576;
const MINIMUM_PLAN_REMAINING_MS=15_000;
const BASE=/^[1-9][0-9]*$/;

function usage(){return `Usage:
  assetfare-select --quote <quote.json> --mode <one_shot|session> \\
    --maximum-input-base <integer> --minimum-output-base <integer> \\
    --output <approval.json>

Reads and verifies one exact Core 2.4.1 quote locally, requires an explicit mode
and caller bounds, then creates one strict approval_v3 JSON file with mode 0600.
It performs zero network calls, never selects automatically, never claims human
approval, never accepts private/signing material, and never signs or submits.
Multi-step quotes are session-only. The output path must not already exist.\n`;}

function parseArgs(argv){
  const out={};const allowed=new Set(["quote","mode","maximum-input-base","minimum-output-base","output"]);
  for(let index=0;index<argv.length;index+=1){
    const raw=argv[index];if(raw==="--help"||raw==="-h")return {help:true};
    if(!raw.startsWith("--"))throw new Error("assetfare_select_argument_invalid");
    const equal=raw.indexOf("="),key=raw.slice(2,equal<0?undefined:equal);if(!allowed.has(key)||Object.hasOwn(out,key))throw new Error("assetfare_select_argument_invalid");
    const value=equal>=0?raw.slice(equal+1):argv[++index];if(typeof value!=="string"||!value)throw new Error(`assetfare_select_${key.replaceAll("-","_")}_missing`);out[key]=value;
  }
  for(const key of allowed)if(!out[key])throw new Error(`assetfare_select_${key.replaceAll("-","_")}_missing`);
  if(!["one_shot","session"].includes(out.mode))throw new Error("assetfare_select_mode_invalid");
  if(!BASE.test(out["maximum-input-base"])||!BASE.test(out["minimum-output-base"]))throw new Error("assetfare_select_bounds_invalid");
  return {quote:out.quote,mode:out.mode,maximum_input_base:out["maximum-input-base"],minimum_output_base:out["minimum-output-base"],output:out.output};
}

function readJsonFile(path,label){
  const absolute=resolve(path);let descriptor,metadata,text;
  try{descriptor=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);metadata=fstatSync(descriptor);if(!metadata.isFile()||metadata.size<2||metadata.size>MAX_QUOTE_BYTES)throw new Error("shape");text=readFileSync(descriptor,"utf8");}
  catch{throw new Error(`assetfare_select_${label}_file_invalid`);}
  finally{if(descriptor!==undefined)closeSync(descriptor);}
  let value;try{value=JSON.parse(text);}catch{throw new Error(`assetfare_select_${label}_json_invalid`);}
  if(!value||Array.isArray(value)||typeof value!=="object")throw new Error(`assetfare_select_${label}_json_invalid`);return value;
}

function writePrivateJson(path,value){
  const absolute=resolve(path),temporary=`${absolute}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;let descriptor;
  try{descriptor=openSync(temporary,"wx",0o600);writeFileSync(descriptor,`${JSON.stringify(value,null,2)}\n`,{encoding:"utf8"});fsyncSync(descriptor);chmodSync(temporary,0o600);closeSync(descriptor);descriptor=undefined;linkSync(temporary,absolute);unlinkSync(temporary);}
  catch(error){if(descriptor!==undefined)closeSync(descriptor);try{unlinkSync(temporary);}catch{}throw new Error(error?.code==="EEXIST"?"assetfare_select_output_exists":"assetfare_select_output_invalid");}
  return absolute;
}

export function selectQuote(argv,{stdout=process.stdout,nowMs=Date.now()}={}){
  const args=parseArgs(argv);if(args.help){stdout.write(usage());return {help:true};}
  const raw=readJsonFile(args.quote,"quote");
  const source=String(raw.intent?.from||"").split(":"),destination=String(raw.intent?.to||"").split(":");
  if(source.length!==2||destination.length!==2)throw new Error("assetfare_select_quote_intent_invalid");
  const intent={from_chain:source[0],from_token:source[1],to_chain:destination[0],to_token:destination[1],amount_usd:raw.intent?.amount_usd};
  const quote=parseV2Quote(raw,intent);
  const continuation=validateContinuationV3(quote.continuation_v3,quote,{requireUnexpired:true,nowMs});
  if(Date.parse(continuation.expires_at)-nowMs<=MINIMUM_PLAN_REMAINING_MS)throw new Error("assetfare_select_quote_near_expiry_requote_required");
  const approval={version:APPROVAL_V3_VERSION,quote_id:continuation.quote_id,quote_fingerprint:continuation.quote_fingerprint,selection_status:"selected",selected_mode:args.mode,maximum_input_base:args.maximum_input_base,minimum_output_base:args.minimum_output_base,direct_route_summary_sha256:continuation.direct_route_summary_sha256,idempotency_key:`select.${randomBytes(16).toString("hex")}`};
  validateApprovalV3(approval,continuation,{mode:args.mode,requireUnexpired:true,nowMs});
  const outputPath=writePrivateJson(args.output,approval);
  const result={status:"approval_v3_written",output_path:outputPath,file_mode:"0600",quote_id:approval.quote_id,selected_mode:approval.selected_mode,selection_was_explicit:true,automatic_selection_performed:false,human_approval_proof_claimed:false,network_requests:0,server_signing:false,server_submission:false};
  stdout.write(`${JSON.stringify(result)}\n`);return result;
}

if(isMain(import.meta.url))try{selectQuote(process.argv.slice(2));}catch(error){process.stderr.write(`${JSON.stringify({status:"fail",error:error?.message||"assetfare_select_failed",network_requests:0,server_signing:false,server_submission:false})}\n`);process.exitCode=1;}

export { parseArgs, readJsonFile, usage };
