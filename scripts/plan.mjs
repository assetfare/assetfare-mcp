#!/usr/bin/env node
/** Caller-approved quote -> first unsigned plan. Never signs or submits. */

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseV2Bundle, parseV2Capabilities, parseV2Intent, parseV2Quote } from "../src/server.js";

const DEFAULT_API_BASE = "https://api.assetfare.dev";
const MAX_RESPONSE_BYTES = 1_048_576;
const TIMEOUT_MS = 45_000;
const CHAINS = new Set(["solana","base","arbitrum","robinhood","polygon","optimism"]);

function usage() {
  return `Usage:
  assetfare-plan --caller-approved \\
    --from-chain solana --from-token USDC \\
    --to-chain base --to-token USDC --amount 250 \\
    --wallet solana=<public-key> --wallet base=<0x-address> \\
    --event-signer-public <caller-owned-public-key>

Returns one freshly requoted unsigned first-action bundle after verifying its
ActionSafetyReceiptV1, raw/action/bundle SHA-256 bindings, intent, fee formula,
and no-sign/no-submit flags. It never accepts a private key, signs, submits, or
moves funds. Solana CCTP callers generate and retain the event-signer keypair
outside AssetFare and pass only its public key.
`;
}

function parseArgs(argv) {
  const out={wallets:{},caller_approved:false};
  const values=new Set(["from-chain","from-token","to-chain","to-token","amount","wallet","event-signer-public","api-base"]);
  for(let i=0;i<argv.length;i+=1){
    const raw=argv[i];
    if(raw==="--help"||raw==="-h")return {help:true};
    if(raw==="--caller-approved"){out.caller_approved=true;continue;}
    if(!raw.startsWith("--"))throw new Error("assetfare_plan_argument_invalid");
    const equal=raw.indexOf("=");const key=raw.slice(2,equal<0?undefined:equal);if(!values.has(key))throw new Error("assetfare_plan_argument_unknown");
    const value=equal>=0?raw.slice(equal+1):argv[++i];if(typeof value!=="string"||!value)throw new Error(`assetfare_plan_${key.replaceAll("-","_")}_missing`);
    if(key==="wallet"){
      const split=value.indexOf("=");if(split<=0||split===value.length-1)throw new Error("assetfare_plan_wallet_invalid");
      const chain=value.slice(0,split),address=value.slice(split+1);if(!CHAINS.has(chain)||Object.hasOwn(out.wallets,chain))throw new Error("assetfare_plan_wallet_invalid");out.wallets[chain]=address;continue;
    }
    out[key.replaceAll("-","_")]=value;
  }
  if(out.help)return out;
  if(out.caller_approved!==true)throw new Error("assetfare_plan_explicit_caller_approval_required");
  for(const key of ["from_chain","from_token","to_chain","to_token","amount"])if(!out[key])throw new Error(`assetfare_plan_${key}_missing`);
  const amount=Number(out.amount);if(!Number.isFinite(amount)||amount<1)throw new Error("assetfare_plan_amount_invalid");out.amount_usd=amount;delete out.amount;
  if(!Object.keys(out.wallets).length)throw new Error("assetfare_plan_wallets_missing");
  for(const [chain,address] of Object.entries(out.wallets)){
    const valid=chain==="solana"?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address):/^0x[0-9a-fA-F]{40}$/.test(address);
    if(!valid)throw new Error("assetfare_plan_wallet_invalid");
  }
  if(out.event_signer_public&&!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(out.event_signer_public))throw new Error("assetfare_plan_event_signer_public_invalid");
  return out;
}

function canonical(value){
  if(value===null||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
function sha256(value){return createHash("sha256").update(Buffer.isBuffer(value)?value:Buffer.from(typeof value==="string"?value:canonical(value),"utf8")).digest("hex");}
function sameParty(left,right){return typeof left==="string"&&typeof right==="string"&&(left.startsWith("0x")&&right.startsWith("0x")?left.toLowerCase()===right.toLowerCase():left===right);}
function withoutKey(value,key){const result=structuredClone(value);delete result[key];return result;}
function hasSubjectiveSafetyKey(value){if(Array.isArray(value))return value.some(hasSubjectiveSafetyKey);if(value&&typeof value==="object")return Object.entries(value).some(([key,item])=>["safe","is_safe"].includes(key.toLowerCase())||hasSubjectiveSafetyKey(item));return false;}

function rawActionRows(action){
  if(Array.isArray(action.transactions))return action.transactions;
  if(action.transaction&&typeof action.transaction==="object")return [action.transaction];
  if(Array.isArray(action.instructions))return action.instructions;
  if(action.instruction&&typeof action.instruction==="object")return [action.instruction];
  throw new Error("assetfare_plan_raw_action_missing");
}

function rawDataBytes(row,kind){
  const data=String(row.data??"");
  if(kind==="evm_transaction"){
    if(!/^0x(?:[0-9a-fA-F]{2})*$/.test(data))throw new Error("assetfare_plan_raw_data_invalid");
    return Buffer.from(data.slice(2),"hex");
  }
  const encoding=String(row.dataEncoding||(/^[0-9a-fA-F]*$/.test(data)?"hex":"base64"));
  if(encoding==="hex"){
    if(!/^(?:[0-9a-fA-F]{2})*$/.test(data))throw new Error("assetfare_plan_raw_data_invalid");
    return Buffer.from(data,"hex");
  }
  if(encoding!=="base64"||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw new Error("assetfare_plan_raw_data_invalid");
  return Buffer.from(data,"base64");
}

function verifyPlanBundle(bundle,intent,nowMs=Date.now()){
  parseV2Bundle(bundle);
  const checks=[];const check=(condition,label)=>{if(!condition)throw new Error(`assetfare_plan_verification_failed:${label}`);checks.push(label);};
  check(bundle.payload_sha256===sha256(withoutKey(bundle,"payload_sha256")),"bundle_payload_sha256");
  check(Date.parse(bundle.expires_at)>nowMs,"bundle_not_expired");
  const action=bundle.unsigned_action,receipt=action?.safety_receipt;
  check(receipt?.schema==="https://assetfare.dev/schemas/action-safety-receipt-v1"&&receipt?.schema_version===1,"receipt_version");
  check(receipt?.generation==="decoded_built_action_only"&&!hasSubjectiveSafetyKey(receipt),"receipt_objective_only");
  check(receipt?.custody?.server_signing===false&&receipt?.custody?.server_submission===false,"receipt_noncustodial");
  check(action.signed===false&&action.submitted===false,"action_unsigned_unsubmitted");
  check(receipt.network?.source_chain===intent.from_chain&&receipt.network?.destination_chain===intent.to_chain,"receipt_route");
  check(receipt.spend?.token?.symbol===intent.from_token&&typeof receipt.spend?.token?.address_or_mint==="string"&&receipt.spend.token.address_or_mint.length>0,"receipt_spend_asset");
  check(receipt.receive?.token?.symbol===intent.to_token&&typeof receipt.receive?.token?.address_or_mint==="string"&&receipt.receive.token.address_or_mint.length>0,"receipt_receive_asset");
  check(receipt.spend?.exact_amount_base===receipt.spend?.maximum_amount_base&&/^[0-9]+$/.test(receipt.spend?.exact_amount_base||"")&&BigInt(receipt.spend.exact_amount_base)>0n,"receipt_exact_spend");
  check(/^[0-9]+$/.test(receipt.receive?.minimum_amount_base||"")&&BigInt(receipt.receive.minimum_amount_base)>0n,"receipt_minimum_receive");
  check(sameParty(receipt.parties?.caller,intent.wallets[intent.from_chain]),"receipt_caller_wallet");
  check(sameParty(receipt.destination?.recipient,intent.wallets[intent.to_chain]),"receipt_destination_wallet");
  const fee=receipt.assetfare_service_fee;check(fee?.bps===1&&fee?.formula==="floor(fee_basis_base * bps / 10000)"&&typeof fee?.recipient==="string"&&fee.recipient.length>0,"receipt_fee_policy");
  if(fee.basis?.amount_base!==null&&fee.exact_amount_base!==null){check(BigInt(fee.exact_amount_base)===BigInt(fee.basis.amount_base)/10000n,"receipt_fee_formula");}
  check(Array.isArray(receipt.target_or_program_allowlist)&&receipt.target_or_program_allowlist.length>0&&Array.isArray(receipt.selector_or_instruction_allowlist)&&receipt.selector_or_instruction_allowlist.length>0,"receipt_allowlists");
  check(receipt.timing?.bundle_expires_at===bundle.expires_at,"receipt_expiry_binding");
  check(receipt.risks?.caller_verification_required===true,"receipt_caller_verification");
  check(receipt.payload_binding?.canonicalization==="UTF-8 JSON sorted keys compact separators; omit safety_receipt","receipt_canonicalization");
  check(receipt.payload_binding?.action_sha256===sha256(withoutKey(action,"safety_receipt")),"receipt_action_sha256");
  const rows=rawActionRows(action),bindings=receipt.payload_binding?.raw_payloads;check(Array.isArray(bindings)&&bindings.length===rows.length,"receipt_raw_count");
  for(const binding of bindings){const row=rows[binding.index];check(Boolean(row)&&binding.raw_sha256===sha256(row),`receipt_raw_${binding.index}`);check(binding.data_sha256===sha256(rawDataBytes(row,binding.kind)),`receipt_data_${binding.index}`);}
  return {verified:true,checks,simulation_performed:false,simulation_note:"Simulate the returned unsigned action with the caller's wallet/RPC immediately before signing."};
}

async function responseText(response){
  const declared=Number(response.headers.get("content-length"));if(Number.isFinite(declared)&&declared>MAX_RESPONSE_BYTES)throw new Error("assetfare_plan_response_too_large");
  const text=await response.text();if(Buffer.byteLength(text,"utf8")>MAX_RESPONSE_BYTES)throw new Error("assetfare_plan_response_too_large");return text;
}
async function requestJson(fetchImpl,url,options={}){
  const response=await fetchImpl(url,{...options,headers:{accept:"application/json",...(options.body?{"content-type":"application/json"}:{}),"x-assetfare-channel":"npm_plan_cli",...(options.headers||{})},redirect:"error",signal:AbortSignal.timeout(TIMEOUT_MS)});
  const media=String(response.headers.get("content-type")||"").split(";",1)[0].toLowerCase();if(media!=="application/json"&&!media.endsWith("+json"))throw new Error("assetfare_plan_response_invalid");
  let payload;try{payload=JSON.parse(await responseText(response));}catch{throw new Error("assetfare_plan_response_invalid");}
  if(!response.ok)throw new Error(response.status===429?"assetfare_plan_rate_limited":response.status>=500?"assetfare_plan_upstream_unavailable":"assetfare_plan_request_rejected");
  if(!payload||Array.isArray(payload)||typeof payload!=="object")throw new Error("assetfare_plan_response_invalid");return payload;
}

function validatedBase(value){const url=new URL(value||DEFAULT_API_BASE);if(url.search||url.hash||url.username||url.password||url.pathname!=="/")throw new Error("assetfare_plan_api_base_invalid");if(url.protocol!=="https:"&&!(["127.0.0.1","localhost"].includes(url.hostname)&&url.protocol==="http:"))throw new Error("assetfare_plan_api_base_invalid");return url.origin;}

async function runPlan(argv,{fetchImpl=fetch,stdout=process.stdout,nowMs=Date.now()}={}){
  const args=parseArgs(argv);if(args.help){stdout.write(usage());return {help:true};}
  const apiBase=validatedBase(args.api_base||process.env.ASSETFARE_API_BASE_URL||DEFAULT_API_BASE);delete args.api_base;
  const intent=parseV2Intent({from_chain:args.from_chain,from_token:args.from_token,to_chain:args.to_chain,to_token:args.to_token,amount_usd:args.amount_usd});
  const capabilities=parseV2Capabilities(await requestJson(fetchImpl,`${apiBase}/v2/capabilities`));
  if((capabilities.temporarily_unavailable_routes||[]).includes(`${intent.from_chain}:${intent.from_token}->${intent.to_chain}:${intent.to_token}`))throw new Error("assetfare_plan_route_temporarily_unavailable");
  const quote=parseV2Quote(await requestJson(fetchImpl,`${apiBase}/v2/quote`,{method:"POST",body:JSON.stringify(intent)}),intent);
  if(quote.execution?.supported!==true||quote.execution?.first_unsigned_action_supported!==true)throw new Error("assetfare_plan_execution_not_ready");
  const body={caller_approved:true,...intent,wallets:args.wallets,...(args.event_signer_public?{event_signer_public:args.event_signer_public}:{})};
  const bundle=await requestJson(fetchImpl,`${apiBase}/v2/prepare`,{method:"POST",body:JSON.stringify(body)});const verification=verifyPlanBundle(bundle,{...intent,wallets:args.wallets},nowMs);
  const result={status:"pass",mode:"caller_approved_unsigned_plan",intent,quote_summary:{quote_id:quote.quote_id,expires_in_seconds:quote.ttl_seconds,cost_summary:quote.cost_summary,eta:quote.eta,offer:quote.offer},verification,bundle,server_signing:false,server_submission:false,signed:false,submitted:false};
  stdout.write(`${JSON.stringify(result,null,2)}\n`);return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runPlan(process.argv.slice(2)).catch((error)=>{process.stderr.write(`${JSON.stringify({status:"fail",error:error?.message||"assetfare_plan_failed",server_signing:false,server_submission:false})}\n`);process.exitCode=1;});

export { canonical, parseArgs, runPlan, sha256, usage, verifyPlanBundle };
