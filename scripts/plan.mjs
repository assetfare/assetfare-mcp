#!/usr/bin/env node
/** Caller-approved quote -> first unsigned plan. Never signs or submits. */

import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { APPROVAL_V3_VERSION, approvalV3Schema, reapprovalV3Schema, validateApprovalV3, validateContinuationV3 } from "../src/continuation-v3.js";
import { isMain } from "../src/is-main.js";
import { parseV2Bundle, parseV2Quote, parseV2Session } from "../src/server.js";
import { readJsonFile } from "./select.mjs";

const DEFAULT_API_BASE = "https://api.assetfare.dev";
const MAX_RESPONSE_BYTES = 1_048_576;
const TIMEOUT_MS = 45_000;
const MINIMUM_PLAN_REMAINING_MS = 15_000;
const MAX_ACTION_TTL_MS = 180_000;
const ACTION_CLOCK_SKEW_MS = 5_000;
const CHAINS = new Set(["solana","base","arbitrum","robinhood","polygon","optimism"]);
const SELECTORS={approve:"0x095ea7b3",swapNative:"0xc6fa57fb",swapStable:"0xfee8180b",bridgeUsdc:"0xa17f6982",bridgeUsdg:"0xedf202ce",across:"0xad5425c6",receiveMessage:"0x57ecfd28"};
const CCTP_TOKEN_MESSENGER="0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const CCTP_MESSAGE_TRANSMITTER="0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const PROGRAMS={system:"11111111111111111111111111111111",compute:"ComputeBudget111111111111111111111111111111",token:"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",token2022:"TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",ata:"ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",memo:"MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",cctp:"CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",raydium:"CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",orca:"whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc",paxos:"paxosVkYuJBKUQoZGAidRA47Qt4uidqG5fAt5kmr1nR"};
const ORCA={pool:"9RqDTfwCx2SgxsvKpspQHc38HUo3B6hRd3oR9JR966Ps",mintA:"2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",mintB:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",tokenProgramA:PROGRAMS.token2022,tokenProgramB:PROGRAMS.token,vaultA:"6j9UtMmzmWuLu45XXmdUXN3NJBdiicxxoBEex8jUs3j6",vaultB:"5Sokmb48nt8aH8TnnkrAcVea4SdRqGU3qTxhRFvTHJyn",oracle:"4FQqY5C4fjReyc3MkMRqbR7bk9KRzXdCTbAXb5wbycVh",tickSpacing:1,tickArraySize:88,minTick:-443636,maxTick:443636,swapV2Discriminator:"2b04ed0b1ac91e62",minSqrtPrice:4295048016n,maxSqrtPrice:79226673515401279992447579055n};
const ORCA_TICK_STARTS=new Map();
const PINS={
  base:{chain_id:8453,USDC:"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",swap:"0x5F18acc45792e1A7C67A12b7E5186bc3CF88aCB0",swapFree:"0xe843de3ec5935ceb339db6cb1ad614d700c2be09",cctp:"0x3671647267E8b1b66ef03A219CdFcC7E2C5ca998",messageTransmitter:CCTP_MESSAGE_TRANSMITTER,domain:6},
  arbitrum:{chain_id:42161,USDC:"0xaf88d065e77c8cC2239327C5EDb3A432268e5831",swap:"0x7F565f732F4e4F43f2ed66f7cb5536dD5F353B2a",swapFree:"0xdfbdac5fdb3587c9fb0b8d939cf990873e1d5e85",cctp:"0xDefDd6444Bb1eBCF7c269158A9aF4251D94eB8E0",messageTransmitter:CCTP_MESSAGE_TRANSMITTER,domain:3},
  robinhood:{chain_id:4663,USDG:"0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",swap:"0x3d5E2AdE64f7f317b113fea18317BA7f05fe3912",swapFree:"0x74526241b298255d82ab27740162e32aff804a45",usdgOft:"0x0879976eC6F84cF8551Ff66f61A54CEBfd7c2b53"},
  polygon:{chain_id:137,USDC:"0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",cctp:"0xDFBDAC5fdb3587c9Fb0b8d939cF990873E1d5e85",domain:7},
  optimism:{chain_id:10,USDC:"0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",cctp:"0xbff0Ac1Bd5A41144afEAeA2592415dD66E662eaD",domain:2},
  solana:{chain_id:"mainnet-beta",USDC:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",USDG:"2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH",feeRecipient:"J98ACstZN41f5k79ccceXHn1mDD2SPg5UwnWW2pgSVfu",domain:5},
};
const EVM_FEE_RECIPIENT="0x8b01BCD3f4D832c1ab27dD4abb04B4F216E27409";
const ACROSS={base:{pool:"0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",token:PINS.base.USDC},arbitrum:{pool:"0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",token:PINS.arbitrum.USDC}};

function usage() {
  return `Usage:
  assetfare-plan --caller-approved --mode one_shot \\
    --quote quote.json --select-exact-quote-bounds \\
    --wallet base=<0x-address> --wallet arbitrum=<0x-address> \\
    --wallet-handoff-output ./caller-wallet-handoff.json

Instead of --select-exact-quote-bounds, pass --approval approval.json to use a
separately reviewed assetfare-select file with custom stricter bounds. Exactly
one selection source is required.

For session mode, use --mode session and optionally
--session-token-output <new-private-file>. To retry the same lost-response
session creation, use --session-capability-input <existing-private-file>
instead. The token is generated from 256-bit
caller-local CSPRNG memory and sent only in X-AssetFare-Session-Token. It is
never printed or included in structured output. The optional file is created
mode 0600 and must not already exist; without it, recovery after process exit
is unavailable.

The optional wallet-handoff output is a new mode-0600 file containing verified
EIP-1193 request templates or Solana Wallet Standard transaction-construction
inputs. It never invokes a wallet. The caller must decode, simulate, confirm,
sign, and submit each action in order with its own wallet.

The command verifies the exact Core quote, continuation_v3, approval_v3,
wallet/signer requirements, path, bounds, mode and TTL before one POST. It
never selects automatically. --select-exact-quote-bounds is an explicit local
selection of the quote's own maximum-input and minimum-output bounds after the
caller has compared candidates; it does not prove human approval. The command
never signs, submits, or accepts private key material.
`;
}

function parseArgs(argv) {
  const out={wallets:{},caller_approved:false,select_exact_quote_bounds:false};
  const values=new Set(["mode","quote","approval","wallet","event-signer-public","session-token-output","session-capability-input","wallet-handoff-output","api-base"]);
  for(let i=0;i<argv.length;i+=1){
    const raw=argv[i];
    if(raw==="--help"||raw==="-h")return {help:true};
    if(raw==="--caller-approved"){if(out.caller_approved)throw new Error("assetfare_plan_argument_duplicate");out.caller_approved=true;continue;}
    if(raw==="--select-exact-quote-bounds"){if(out.select_exact_quote_bounds)throw new Error("assetfare_plan_selection_source_invalid");out.select_exact_quote_bounds=true;continue;}
    if(!raw.startsWith("--"))throw new Error("assetfare_plan_argument_invalid");
    const equal=raw.indexOf("=");const key=raw.slice(2,equal<0?undefined:equal);if(!values.has(key))throw new Error("assetfare_plan_argument_unknown");
    const normalizedKey=key.replaceAll("-","_");if(key!=="wallet"&&Object.hasOwn(out,normalizedKey))throw new Error("assetfare_plan_argument_duplicate");
    const value=equal>=0?raw.slice(equal+1):argv[++i];if(typeof value!=="string"||!value)throw new Error(`assetfare_plan_${normalizedKey}_missing`);
    if(key==="wallet"){
      const split=value.indexOf("=");if(split<=0||split===value.length-1)throw new Error("assetfare_plan_wallet_invalid");
      const chain=value.slice(0,split),address=value.slice(split+1);if(!CHAINS.has(chain)||Object.hasOwn(out.wallets,chain))throw new Error("assetfare_plan_wallet_invalid");out.wallets[chain]=address;continue;
    }
    out[normalizedKey]=value;
  }
  if(out.help)return out;
  if(out.caller_approved!==true)throw new Error("assetfare_plan_explicit_caller_approval_required");
  for(const key of ["mode","quote"])if(!out[key])throw new Error(`assetfare_plan_${key}_missing`);
  if(Boolean(out.approval)===out.select_exact_quote_bounds)throw new Error("assetfare_plan_selection_source_invalid");
  if(!["one_shot","session"].includes(out.mode))throw new Error("assetfare_plan_mode_invalid");
  if(!Object.keys(out.wallets).length)throw new Error("assetfare_plan_wallets_missing");
  for(const [chain,address] of Object.entries(out.wallets)){
    const valid=chain==="solana"?/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address):/^0x[0-9a-fA-F]{40}$/.test(address);
    if(!valid)throw new Error("assetfare_plan_wallet_invalid");
  }
  if(out.event_signer_public&&!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(out.event_signer_public))throw new Error("assetfare_plan_event_signer_public_invalid");
  if(out.session_token_output&&out.session_capability_input)throw new Error("assetfare_plan_session_capability_source_invalid");
  if(out.mode!=="session"&&(out.session_token_output||out.session_capability_input))throw new Error("assetfare_plan_session_token_output_mode_invalid");
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
  const transactions=Array.isArray(action.transactions)?action.transactions:action.transaction&&typeof action.transaction==="object"?[action.transaction]:null;
  const instructions=Array.isArray(action.instructions)?action.instructions:action.instruction&&typeof action.instruction==="object"?[action.instruction]:null;
  if(transactions&&instructions)throw new Error("assetfare_plan_mixed_action_families");
  if(transactions){if(!transactions.length||transactions.length>4||transactions.some((row)=>!row||typeof row!=="object"||Array.isArray(row)))throw new Error("assetfare_plan_transactions_invalid");return transactions;}
  if(instructions){if(!instructions.length||instructions.length>32||instructions.some((row)=>!row||typeof row!=="object"||Array.isArray(row)))throw new Error("assetfare_plan_instructions_invalid");return instructions;}
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

function integer(value,label,minimum=0){if(typeof value==="boolean"||value===null||value===undefined||!/^\d+$/.test(String(value)))throw new Error(`assetfare_plan_${label}_invalid`);const parsed=BigInt(String(value));if(parsed<BigInt(minimum))throw new Error(`assetfare_plan_${label}_invalid`);return parsed;}
function dataWord(data,index){if(!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)||data.length<10+64*(index+1))throw new Error("assetfare_plan_calldata_invalid");return data.slice(10+64*index,10+64*(index+1)).toLowerCase();}
function dataUint(data,index){return BigInt(`0x${dataWord(data,index)}`);}
function dataAddress(data,index){return `0x${dataWord(data,index).slice(-40)}`;}
function dataBytes32(data,index){return `0x${dataWord(data,index)}`;}
function abiBytes(data,index){const body=String(data).slice(10),offset=Number(BigInt(`0x${dataWord(data,index)}`)),lengthStart=offset*2,length=Number(BigInt(`0x${body.slice(lengthStart,lengthStart+64)}`)),start=lengthStart+64,end=start+length*2;if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(length)||length<0||end>body.length)throw new Error("assetfare_plan_calldata_invalid");return `0x${body.slice(start,end)}`;}
function keccakHex(value){if(!/^0x(?:[0-9a-fA-F]{2})*$/.test(value))throw new Error("assetfare_plan_calldata_invalid");return `0x${Buffer.from(keccak_256(Buffer.from(value.slice(2),"hex"))).toString("hex")}`;}
function exactStringSet(actual,expected){return Array.isArray(actual)&&actual.length===expected.length&&new Set(actual).size===actual.length&&[...actual].sort().every((value,index)=>value===[...expected].sort()[index]);}
function actionInput(action){for(const key of ["inputAmount","inputLamports","inputUsdcBase"])if(action[key]!==undefined)return integer(action[key],"input_amount",1);throw new Error("assetfare_plan_input_amount_missing");}
function actionMinimum(action){for(const key of ["minimumOutput","minimumOutputAmount","minimumUsdcBase","minimumSolLamports"])if(action[key]!==undefined)return integer(action[key],"minimum_output",1);throw new Error("assetfare_plan_minimum_output_missing");}
function actionDeadline(action){for(const key of ["deadline","fillDeadline"])if(action[key]!==undefined&&action[key]!==null)return integer(action[key],"deadline",1);return null;}
function stepScope(step){if(step.chain)return {sourceChain:step.chain,destinationChain:step.chain,sourceToken:step.from,destinationToken:step.to};return {sourceChain:step.from,destinationChain:step.to,sourceToken:step.from_asset||step.asset,destinationToken:step.to_asset||step.asset};}
function expectedToken(chain,symbol){if(["ETH","SOL"].includes(symbol))return `native:${symbol}`;const value=PINS[chain]?.[symbol];if(!value)throw new Error("assetfare_plan_token_pin_missing");return value;}
function actionKind(provider,family){if(provider==="circle_cctp")return `${family}_cctp`;if(provider==="circle_cctp_receive"&&family==="evm")return "evm_cctp_receive";if(provider==="paxos_usdg_layerzero_oft")return `${family}_layerzero`;if(provider==="across_intent_bridge"&&family==="evm")return "evm_across";if(["uniswap_v3","raydium_clmm","orca_whirlpool"].includes(provider))return `${family}_dex`;throw new Error("assetfare_plan_provider_invalid");}

function verifyNoForwardMessage(message,{sourceChain,destinationChain,recipient,amount}){const byte=(offset,length)=>`0x${message.slice(2+offset*2,2+(offset+length)*2)}`,u32=offset=>Number(BigInt(byte(offset,4))),u256=offset=>BigInt(byte(offset,32)),padded=value=>`0x${"0".repeat(24)}${value.slice(2).toLowerCase()}`;if(!/^0x[0-9a-fA-F]{752}$/.test(message)||!["polygon","optimism"].includes(sourceChain)||!["base","arbitrum"].includes(destinationChain))throw new Error("assetfare_plan_verification_failed:cctp_receive_message_shape");const body=byte(148,228);if(u32(0)!==1||u32(4)!==PINS[sourceChain].domain||u32(8)!==PINS[destinationChain].domain||byte(44,32).toLowerCase()!==padded(CCTP_TOKEN_MESSENGER)||byte(76,32).toLowerCase()!==padded(CCTP_TOKEN_MESSENGER)||byte(108,32)!==`0x${"0".repeat(64)}`||u32(140)!==2000||u32(144)<2000||Number(BigInt(`0x${body.slice(2,10)}`))!==1||`0x${body.slice(10,74)}`.toLowerCase()!==padded(PINS[sourceChain].USDC)||`0x${body.slice(74,138)}`.toLowerCase()!==padded(recipient)||BigInt(`0x${body.slice(138,202)}`)!==amount||`0x${body.slice(202,266)}`.toLowerCase()!==padded(PINS[sourceChain].cctp)||BigInt(`0x${body.slice(266,330)}`)!==0n||BigInt(`0x${body.slice(330,394)}`)!==0n||BigInt(`0x${body.slice(394,458)}`)!==0n)throw new Error("assetfare_plan_verification_failed:cctp_receive_message_binding");}
function actionCaller(action,rows,family){for(const key of ["sender","owner","sourceWallet","feePayer"])if(typeof action[key]==="string"&&action[key])return action[key];const signers=action.requiredSigners||action.signers;if(Array.isArray(signers)&&typeof signers[0]==="string")return signers[0];if(family==="evm")return String(rows[0]?.from||"");throw new Error("assetfare_plan_caller_missing");}
function actionFeeAmount(action){for(const key of ["routeFeeStable","routeFeeInput","routeFeeUsdcBase","assetfareFeeBase","routeFee"])if(action[key]!==undefined&&action[key]!==null)return integer(action[key],"fee_amount");return null;}

function associatedTokenAddress(owner,mint,tokenProgram){try{return PublicKey.findProgramAddressSync([new PublicKey(owner).toBuffer(),new PublicKey(tokenProgram).toBuffer(),new PublicKey(mint).toBuffer()],new PublicKey(PROGRAMS.ata))[0].toBase58();}catch{return null;}}
function u128le(value,offset){return value.readBigUInt64LE(offset)+(value.readBigUInt64LE(offset+8)<<64n);}
function orcaTickStart(address){
  if(!ORCA_TICK_STARTS.size){const program=new PublicKey(PROGRAMS.orca),pool=new PublicKey(ORCA.pool),span=ORCA.tickSpacing*ORCA.tickArraySize,first=Math.floor(ORCA.minTick/span)*span,last=Math.floor(ORCA.maxTick/span)*span;for(let start=first;start<=last;start+=span){const key=PublicKey.findProgramAddressSync([Buffer.from("tick_array"),pool.toBuffer(),Buffer.from(String(start))],program)[0].toBase58();ORCA_TICK_STARTS.set(key,start);}}
  return ORCA_TICK_STARTS.get(address);
}
function verifyOrcaSwap({action,rows,step,scope,receipt,caller,inputAmount,minimumOutput,check}){
  const bps=Number(step.route_fee_bps),fee=inputAmount*BigInt(bps)/10000n,swapInput=inputAmount-fee,direction=`${scope.sourceToken.toLowerCase()}_to_${scope.destinationToken.toLowerCase()}`,aToB=direction==="usdg_to_usdc",expectedInputMint=aToB?ORCA.mintA:ORCA.mintB,expectedInputProgram=aToB?ORCA.tokenProgramA:ORCA.tokenProgramB,swapRows=rows.filter(row=>row.programId===PROGRAMS.orca);
  check(["usdg_to_usdc","usdc_to_usdg"].includes(direction)&&action.version==="assetfare-direct-orca-usdc-usdg-action-v2"&&action.direction===direction&&action.pool===ORCA.pool&&action.inputMint===expectedInputMint&&action.inputTokenProgram===expectedInputProgram,"orca_action_identity");
  check(integer(action.inputAmount,"orca_input",1)===inputAmount&&integer(action.swapInput,"orca_swap_input",1)===swapInput&&integer(action.routeFeeInput,"orca_fee")===fee&&integer(action.developerFeeInput,"orca_developer_fee")===0n&&Number(action.routeFeeBps)===bps&&action.routeFeePolicy==="uncapped_exact_one_bps"&&integer(action.estimatedOutput,"orca_estimated_output",1)>=minimumOutput,"orca_action_amounts");
  check((bps===0&&action.feeCollection==="none"&&action.feeRecipient===null&&action.feeRecipientTokenAccount===null)||(bps===1&&action.feeCollection==="atomic_exact_spl_transfer"&&action.feeRecipient===PINS.solana.feeRecipient&&action.feeRecipientTokenAccount===associatedTokenAddress(PINS.solana.feeRecipient,expectedInputMint,expectedInputProgram)),"orca_fee_identity");
  check(swapRows.length===1&&rows[0]===swapRows[0]&&rows.length===(bps===1?3:1),"orca_instruction_count");
  const row=swapRows[0],data=rawDataBytes(row,"solana_instruction"),keys=row?.keys;
  check(data.length===43&&data.subarray(0,8).toString("hex")===ORCA.swapV2Discriminator&&data.readBigUInt64LE(8)===swapInput&&data.readBigUInt64LE(16)===minimumOutput&&u128le(data,24)===(aToB?ORCA.minSqrtPrice:ORCA.maxSqrtPrice)&&data[40]===1&&data[41]===(aToB?1:0)&&data[42]===0,"orca_instruction_data");
  const ownerAtaA=associatedTokenAddress(caller,ORCA.mintA,ORCA.tokenProgramA),ownerAtaB=associatedTokenAddress(caller,ORCA.mintB,ORCA.tokenProgramB),fixed=[ORCA.tokenProgramA,ORCA.tokenProgramB,PROGRAMS.memo,caller,ORCA.pool,ORCA.mintA,ORCA.mintB,ownerAtaA,ORCA.vaultA,ownerAtaB,ORCA.vaultB,null,null,null,ORCA.oracle],flags=[[false,false],[false,false],[false,false],[true,false],[false,true],[false,false],[false,false],[false,true],[false,true],[false,true],[false,true],[false,true],[false,true],[false,true],[false,true]];
  check(Array.isArray(keys)&&keys.length===15&&keys.every((key,index)=>key&&key.isSigner===flags[index][0]&&key.isWritable===flags[index][1]&&(fixed[index]===null||key.pubkey===fixed[index])),"orca_instruction_accounts");
  const starts=Array.isArray(keys)&&keys.length===15?keys.slice(11,14).map(key=>orcaTickStart(key.pubkey)):[];check(starts.length===3&&starts.every(Number.isInteger)&&starts.slice(1).every((value,index)=>aToB?value<=starts[index]&&starts[index]-value<=ORCA.tickArraySize:value>=starts[index]&&value-starts[index]<=ORCA.tickArraySize),"orca_tick_arrays");
  if(bps===1){const ata=rows[1],transfer=rows[2],recipientAta=action.feeRecipientTokenAccount,ataData=rawDataBytes(ata,"solana_instruction"),ataExpected=[[caller,true,true],[recipientAta,false,true],[PINS.solana.feeRecipient,false,false],[expectedInputMint,false,false],[PROGRAMS.system,false,false],[expectedInputProgram,false,false]];check(ata.programId===PROGRAMS.ata&&ataData.length===1&&ataData[0]===1&&Array.isArray(ata.keys)&&canonical(ata.keys)===canonical(ataExpected.map(([pubkey,isSigner,isWritable])=>({pubkey,isSigner,isWritable}))),"orca_fee_ata_instruction");check(transfer.programId===expectedInputProgram,"orca_fee_transfer_order");}
  check(exactStringSet(action.programs,[...new Set(rows.map(item=>item.programId))]),"orca_program_list");
  check(receipt.action.provider==="orca_whirlpool"&&receipt.action.kind==="solana_dex","orca_receipt_kind");
}

function verifyPlanBundle(bundle,intent,nowMs=Date.now()){
  parseV2Bundle(bundle);
  const checks=[];const check=(condition,label)=>{if(!condition)throw new Error(`assetfare_plan_verification_failed:${label}`);checks.push(label);};
  check(bundle.payload_sha256===sha256(withoutKey(bundle,"payload_sha256")),"bundle_payload_sha256");
  const expires=Date.parse(bundle.expires_at),prepared=Date.parse(bundle.prepared_at);check(Number.isFinite(expires)&&expires>nowMs&&expires<=nowMs+MAX_ACTION_TTL_MS+ACTION_CLOCK_SKEW_MS,"bundle_fresh_expiry");
  check(Number.isFinite(prepared)&&prepared<=nowMs+ACTION_CLOCK_SKEW_MS&&prepared>=nowMs-MAX_ACTION_TTL_MS&&expires>=prepared&&expires-prepared<=MAX_ACTION_TTL_MS,"bundle_prepared_at");
  if(bundle.expires_in_seconds!==undefined)check(Number(bundle.expires_in_seconds)===Math.round((expires-prepared)/1000),"bundle_ttl_seconds");
  const action=bundle.unsigned_action,receipt=action?.safety_receipt;
  check(receipt?.schema==="https://assetfare.dev/schemas/action-safety-receipt-v1"&&receipt?.schema_version===1,"receipt_version");
  check(receipt?.generation==="decoded_built_action_only"&&!hasSubjectiveSafetyKey(receipt),"receipt_objective_only");
  check(receipt?.custody?.server_signing===false&&receipt?.custody?.server_submission===false,"receipt_noncustodial");
  check(action.signed===false&&action.submitted===false&&action.aggregatorApiUsed===false&&action.serverSigning!==true&&action.serverSubmission!==true,"action_unsigned_unsubmitted");
  check(bundle.route===`${intent.from_chain}:${intent.from_token}->${intent.to_chain}:${intent.to_token}`&&bundle.workflow?.route===bundle.route,"bundle_route");
  check(bundle.workflow?.workflow_id===bundle.workflow_id&&bundle.workflow?.current_step===bundle.step_index&&Array.isArray(bundle.workflow?.steps),"workflow_binding");
  check(canonical(bundle.workflow?.wallets)===canonical(intent.wallets),"workflow_wallets");
  const scopes=bundle.workflow.steps.map(stepScope);check(scopes.length>0&&scopes[0].sourceChain===intent.from_chain&&scopes[0].sourceToken===intent.from_token&&scopes.at(-1).destinationChain===intent.to_chain&&scopes.at(-1).destinationToken===intent.to_token&&scopes.slice(1).every((scope,index)=>scope.sourceChain===scopes[index].destinationChain&&scope.sourceToken===scopes[index].destinationToken),"workflow_topology");
  const step=bundle.workflow.steps[bundle.step_index];check(step&&typeof step==="object"&&(!step.action_id||step.action_id===bundle.action_id),"workflow_step");const scope=stepScope(step);
  check(receipt.network?.source_chain===scope.sourceChain&&receipt.network?.destination_chain===scope.destinationChain,"receipt_step_route");
  check(receipt.spend?.token?.symbol===scope.sourceToken&&sameParty(receipt.spend?.token?.address_or_mint,expectedToken(scope.sourceChain,scope.sourceToken)),"receipt_spend_asset");
  check(receipt.receive?.token?.symbol===scope.destinationToken&&sameParty(receipt.receive?.token?.address_or_mint,expectedToken(scope.destinationChain,scope.destinationToken)),"receipt_receive_asset");
  const rows=rawActionRows(action),family=rows[0]?.chainId!==undefined?"evm":"solana",caller=actionCaller(action,rows,family),inputAmount=actionInput(action),minimumOutput=actionMinimum(action);
  check(receipt.action?.kind===actionKind(step.provider,family)&&receipt.action?.provider===step.provider,"receipt_action_kind");
  check(sameParty(caller,step.caller_wallet)&&sameParty(receipt.parties?.caller,caller)&&sameParty(receipt.parties?.fee_payer,action.feePayer||caller),"receipt_caller_wallet");
  if(Array.isArray(action.requiredSigners)||Array.isArray(action.signers)){const required=action.requiredSigners||action.signers;if(family==="evm")check(exactStringSet(required,[caller]),"evm_required_signers");}
  check(inputAmount===integer(step.actual_input_base,"workflow_input",1)&&minimumOutput>=integer(step.minimum_output_base,"workflow_minimum",1),"workflow_amounts");
  check(receipt.spend?.exact_amount_base===String(inputAmount)&&receipt.spend?.maximum_amount_base===String(inputAmount),"receipt_exact_spend");
  check(receipt.receive?.minimum_amount_base===String(minimumOutput),"receipt_minimum_receive");
  check(receipt.timing?.bundle_expires_at===bundle.expires_at,"receipt_expiry_binding");
  const deadline=actionDeadline(action);if(deadline!==null){const nowSeconds=BigInt(Math.floor(nowMs/1000));check(deadline>=nowSeconds-5n&&deadline<=nowSeconds+600n,"action_deadline_fresh");}
  check(receipt.risks?.caller_verification_required===true,"receipt_caller_verification");
  check(receipt.payload_binding?.canonicalization==="UTF-8 JSON sorted keys compact separators; omit safety_receipt","receipt_canonicalization");
  check(receipt.payload_binding?.action_sha256===sha256(withoutKey(action,"safety_receipt")),"receipt_action_sha256");
  const bindings=receipt.payload_binding?.raw_payloads;check(Array.isArray(bindings)&&bindings.length===rows.length&&bindings.map((row)=>row.index).sort((a,b)=>a-b).every((value,index)=>value===index),"receipt_raw_coverage");
  const targets=[],calls=[],nativeValues=[];
  for(const binding of bindings){const row=rows[binding.index],kind=family==="evm"?"evm_transaction":"solana_instruction";check(binding.kind===kind&&binding.raw_sha256===sha256(row),`receipt_raw_${binding.index}`);const bytes=rawDataBytes(row,kind);check(binding.data_sha256===sha256(bytes),`receipt_data_${binding.index}`);
    if(family==="evm"){
      check(Number(row.chainId)===PINS[scope.sourceChain]?.chain_id&&sameParty(row.from,caller)&&/^0x[0-9a-fA-F]{40}$/.test(String(row.to||"")),`evm_party_chain_${binding.index}`);
      const selector=String(row.data).slice(0,10).toLowerCase(),value=integer(row.value??0,"native_value");targets.push(row.to);calls.push(selector);nativeValues.push(value);
      check(binding.chain_id===Number(row.chainId)&&sameParty(binding.target,row.to)&&binding.selector===selector&&binding.native_value_base===String(value),`receipt_evm_row_${binding.index}`);
    }else{
      check(typeof row.programId==="string"&&Array.isArray(row.keys)&&row.keys.every((key)=>typeof key.pubkey==="string"&&typeof key.isSigner==="boolean"&&typeof key.isWritable==="boolean"),`solana_row_${binding.index}`);
      const prefix=bytes.subarray(0,8).toString("hex"),instructionType=row.type??row.instruction_type??null,call=`${instructionType?`${instructionType}@`:""}${row.programId}:${prefix}`;targets.push(row.programId);calls.push(call);
      check(binding.program_id===row.programId&&binding.data_prefix_hex===prefix&&(binding.instruction_type??null)===instructionType,`receipt_solana_row_${binding.index}`);
    }
  }
  check(exactStringSet(receipt.target_or_program_allowlist,[...new Set(targets)])&&exactStringSet(receipt.selector_or_instruction_allowlist,[...new Set(calls)]),"receipt_allowlists");
  let derivedApproval={required:false,token:null,target:null,exact_allowance_base:null},destinationRecipient=action.recipient??null,destinationDomain=action.destinationDomain??null;
  if(family==="evm"){
    const approvals=rows.map((row,index)=>[row,index]).filter(([row])=>String(row.data).slice(0,10).toLowerCase()===SELECTORS.approve);check(approvals.length<=1,"approval_count");
    if(approvals.length){const [row,index]=approvals[0],spender=dataAddress(row.data,0),amount=dataUint(row.data,1);check(amount===inputAmount,"approval_amount");derivedApproval={required:true,token:row.to,target:spender,exact_allowance_base:String(amount),transaction_index:index};}
    check(canonical(receipt.approval)===canonical(derivedApproval),"receipt_approval");
    const values=nativeValues.map(String),maximum=nativeValues.reduce((a,b)=>a>b?a:b,0n);check(canonical(receipt.native_value_cap)===canonical({maximum_base:String(maximum),unit:"wei",per_transaction_base:values}),"receipt_native_value_cap");
    const selectors=calls,main=rows.at(-1),data=main.data,pin=PINS[scope.sourceChain];
    if(receipt.action.kind==="evm_dex"){
      const direction=String(action.direction||""),expected=direction==="native_to_stable"?[SELECTORS.swapNative]:direction==="stable_to_native"?[SELECTORS.approve,SELECTORS.swapStable]:[],bps=Number(action.routeFeeBps??step.route_fee_bps),expectedExecutor=bps===1?pin?.swap:pin?.swapFree;check(canonical(selectors)===canonical(expected)&&sameParty(action.executor,expectedExecutor)&&sameParty(main.to,action.executor),"evm_swap_target");check(sameParty(dataAddress(data,0),action.recipient)&&sameParty(action.recipient,step.recipient_wallet),"evm_swap_recipient");
      if(direction==="native_to_stable"){check(integer(main.value??0,"native_value")===inputAmount&&!derivedApproval.required,"evm_swap_native_value");check(dataUint(data,2)===BigInt(action.routeFeeBps)&&dataUint(data,3)===minimumOutput&&dataUint(data,4)===deadline,"evm_swap_arguments");}
      else{check(integer(main.value??0,"native_value")===0n&&derivedApproval.required&&sameParty(derivedApproval.token,expectedToken(scope.sourceChain,scope.sourceToken))&&sameParty(derivedApproval.target,action.executor)&&dataUint(data,1)===inputAmount,"evm_swap_stable_input");check(dataUint(data,3)===BigInt(action.routeFeeBps)&&dataUint(data,4)===minimumOutput&&dataUint(data,5)===deadline,"evm_swap_arguments");}
    }else if(receipt.action.kind==="evm_cctp"){
      check(canonical(selectors)===canonical([SELECTORS.approve,SELECTORS.bridgeUsdc])&&derivedApproval.required&&sameParty(action.executor,pin?.cctp)&&sameParty(main.to,action.executor)&&sameParty(derivedApproval.token,expectedToken(scope.sourceChain,scope.sourceToken))&&sameParty(derivedApproval.target,action.executor)&&sameParty(action.recipient,step.recipient_wallet),"evm_cctp_target");check(dataUint(data,0)===inputAmount&&dataUint(data,1)===BigInt(PINS[scope.destinationChain]?.domain)&&dataUint(data,4)===integer(action.maxCctpFee??0,"max_cctp_fee")&&dataUint(data,5)===integer(action.finality??action.finalityThreshold,"finality")&&dataUint(data,7)===deadline,"evm_cctp_arguments");destinationRecipient=dataBytes32(data,2);destinationDomain=Number(dataUint(data,1));if(action.mintRecipient)check(action.mintRecipient.toLowerCase()===destinationRecipient,"evm_cctp_mint_recipient");
    }else if(receipt.action.kind==="evm_cctp_receive"){
      check(canonical(selectors)===canonical([SELECTORS.receiveMessage])&&!derivedApproval.required&&sameParty(main.to,pin?.messageTransmitter)&&sameParty(action.sender,step.caller_wallet)&&sameParty(action.recipient,step.recipient_wallet)&&action.destination===scope.sourceChain&&["polygon","optimism"].includes(action.sourceChain)&&/^0x[0-9a-fA-F]{64}$/.test(action.sourceTxHash||""),"evm_cctp_receive_target");const message=abiBytes(data,0),attestation=abiBytes(data,1);check(keccakHex(message).toLowerCase()===String(action.messageHash).toLowerCase()&&String(action.sourceMessageHash).toLowerCase()===String(action.messageHash).toLowerCase()&&keccakHex(attestation).toLowerCase()===String(action.attestationHash).toLowerCase()&&integer(action.burnAmountBase,"burn_amount",1)===inputAmount,"evm_cctp_receive_payload");verifyNoForwardMessage(message,{sourceChain:action.sourceChain,destinationChain:scope.sourceChain,recipient:caller,amount:inputAmount});destinationRecipient=caller;destinationDomain=PINS[scope.sourceChain].domain;
    }else if(receipt.action.kind==="evm_layerzero"){
      check(canonical(selectors)===canonical([SELECTORS.approve,SELECTORS.bridgeUsdg])&&derivedApproval.required&&sameParty(action.executor,PINS.robinhood.usdgOft)&&sameParty(main.to,action.executor)&&sameParty(derivedApproval.token,pin?.USDG)&&sameParty(derivedApproval.target,action.executor)&&action.recipient===step.recipient_wallet,"evm_layerzero_target");const native=integer(action.nativeFee,"native_fee");check(dataUint(data,0)===inputAmount&&dataUint(data,2)===minimumOutput&&dataUint(data,3)===native&&dataUint(data,4)===deadline&&integer(main.value??0,"native_value")===native,"evm_layerzero_arguments");destinationRecipient=dataBytes32(data,1);
    }else if(receipt.action.kind==="evm_across"){
      const across=ACROSS[scope.sourceChain];check(canonical(selectors)===canonical([SELECTORS.approve,SELECTORS.across])&&derivedApproval.required&&action.providerApprovalDiscarded===true&&sameParty(action.spokePool,across?.pool)&&sameParty(main.to,across?.pool)&&sameParty(derivedApproval.token,across?.token)&&sameParty(derivedApproval.target,across?.pool)&&(!action.recipient||sameParty(action.recipient,step.recipient_wallet)),"across_target");check(action.semanticValidation&&Object.values(action.semanticValidation).length>0&&Object.values(action.semanticValidation).every((value)=>value===true),"across_semantics");check(dataUint(data,4)===inputAmount&&dataUint(data,5)===integer(action.grossDepositOutputAmount,"gross_output")&&dataUint(data,6)===BigInt(PINS[scope.destinationChain].chain_id)&&dataUint(data,9)===integer(action.fillDeadline,"fill_deadline"),"across_arguments");destinationRecipient=dataBytes32(data,1);destinationDomain=Number(dataUint(data,6));
    }
  }else{
    check(canonical(receipt.approval)===canonical(derivedApproval),"receipt_approval");const allowed=step.provider==="raydium_clmm"?new Set([PROGRAMS.system,PROGRAMS.compute,PROGRAMS.token,PROGRAMS.token2022,PROGRAMS.ata,PROGRAMS.memo,PROGRAMS.raydium]):step.provider==="orca_whirlpool"?new Set([PROGRAMS.token,PROGRAMS.token2022,PROGRAMS.ata,PROGRAMS.orca]):step.provider==="circle_cctp"?new Set([PROGRAMS.token,PROGRAMS.ata,PROGRAMS.cctp]):step.provider==="paxos_usdg_layerzero_oft"?new Set([PROGRAMS.paxos,PROGRAMS.token,PROGRAMS.token2022]):new Set();check(allowed.size>0&&rows.every((row)=>allowed.has(row.programId)),"solana_program_pins");
    const rawSigners=new Set(rows.flatMap((row)=>row.keys.filter((key)=>key.isSigner).map((key)=>key.pubkey))),required=action.requiredSigners||action.signers;check(Array.isArray(required)&&exactStringSet(required,[...rawSigners])&&rawSigners.has(caller),"solana_signers");if(intent.event_signer_public&&receipt.action.kind==="solana_cctp")check(rawSigners.has(intent.event_signer_public),"solana_event_signer");if(step.provider==="orca_whirlpool")verifyOrcaSwap({action,rows,step,scope,receipt,caller,inputAmount,minimumOutput,check});
    const bps=Number(action.routeFeeBps??step.route_fee_bps),feeAmount=actionFeeAmount(action)??0n,transfers=[];for(const row of rows){const bytes=rawDataBytes(row,"solana_instruction");if([PROGRAMS.token,PROGRAMS.token2022].includes(row.programId)&&bytes.length===10&&bytes[0]===12)transfers.push({amount:bytes.readBigUInt64LE(1),row});}if(bps===1){check(transfers.length===1&&transfers[0].amount===feeAmount,"solana_fee_transfer");const keys=transfers[0].row.keys,feeMint=keys?.[1]?.pubkey,feeDestination=keys?.[2]?.pubkey,authority=keys?.[3]?.pubkey,expectedFeeAccount=action.feeRecipientAta??action.feeRecipientUsdcAta??action.feeRecipientTokenAccount,allowedMints=[receipt.spend.token.address_or_mint,receipt.receive.token.address_or_mint].filter((value)=>!String(value).startsWith("native:"));check(keys?.length>=4&&allowedMints.includes(feeMint)&&typeof expectedFeeAccount==="string"&&feeDestination===expectedFeeAccount&&authority===caller,"solana_fee_accounts");}else check(transfers.length===0,"solana_no_fee_transfer");if(receipt.action.kind==="solana_cctp")check(rows.length===(bps?3:1),"solana_cctp_instruction_count");if(receipt.action.kind==="solana_layerzero")check(rows.length===1,"solana_layerzero_instruction_count");const nativeCap=scope.sourceChain==="solana"&&scope.sourceToken==="SOL"?inputAmount:0n;check(canonical(receipt.native_value_cap)===canonical({maximum_base:String(nativeCap),unit:"lamports",per_transaction_base:[]}),"receipt_native_value_cap");destinationRecipient=action.recipient??(receipt.action.kind==="solana_dex"?caller:null);check(destinationRecipient===null||sameParty(destinationRecipient,step.recipient_wallet),"solana_recipient_wallet");if(receipt.action.kind==="solana_cctp"&&destinationDomain===null)destinationDomain=PINS[scope.destinationChain]?.domain??null;
  }
  check((destinationRecipient===null&&receipt.destination?.recipient===null)||sameParty(receipt.destination?.recipient,String(destinationRecipient)),"receipt_protocol_recipient");check((destinationDomain??null)===(receipt.destination?.domain??null),"receipt_destination_domain");
  const bps=Number(action.routeFeeBps??action.effectiveRouteFeeBps??step.route_fee_bps),fee=receipt.assetfare_service_fee,explicitFee=actionFeeAmount(action);check([0,1].includes(bps)&&bps===Number(step.route_fee_bps)&&fee?.bps===bps&&fee?.formula==="floor(fee_basis_base * bps / 10000)","receipt_fee_policy");let basis=inputAmount;if(action.grossDepositOutputAmount!==undefined&&action.assetfareFeeBase!==undefined)basis=integer(action.grossDepositOutputAmount,"fee_basis",1);else if(action.routeFeeBasisExpectedUsdcBase!==undefined)basis=integer(action.routeFeeBasisExpectedUsdcBase,"fee_basis",1);else if(action.direction==="native_to_stable")basis=null;const exact=basis===null?null:basis*BigInt(bps)/10000n;if(explicitFee!==null&&exact!==null)check(explicitFee===exact,"action_fee_formula");const expectedFee=explicitFee??exact;check(fee.exact_amount_base===(expectedFee===null?null:String(expectedFee))&&fee.basis?.amount_base===(basis===null?null:String(basis)),"receipt_fee_amount");const expectedFeeRecipient=bps===0?null:scope.sourceChain==="solana"?PINS.solana.feeRecipient:EVM_FEE_RECIPIENT;check((expectedFeeRecipient===null&&fee.recipient===null)||sameParty(fee.recipient,expectedFeeRecipient),"receipt_fee_recipient");check((receipt.timing?.action_deadline_unix??null)===(deadline===null?null:Number(deadline))&&(receipt.timing?.quote_expiry_unix??null)===(action.quoteExpiryTimestamp??null)&&canonical(receipt.timing?.recent_blockhash??null)===canonical(action.recentBlockhash??null),"receipt_timing_fields");
  return {verified:true,verification_scope:"decoded_current_action_and_intent",checks,simulation_performed:false,safe_to_sign:false,simulation_note:"Decode and simulate again in the caller's wallet/RPC immediately before signing; this verifier does not authorize a signature."};
}

function verifyApprovalBundleBounds(bundle,quote,approval){
  const workflow=bundle?.workflow,summary=quote.direct_route_summary,index=bundle?.step_index,receipt=bundle?.unsigned_action?.safety_receipt;
  const legacyReceive=Boolean(workflow?.legacy_source_only_receive_recovery===true&&Array.isArray(workflow?.steps)&&workflow.steps.length===2&&summary?.step_count===1&&summary?.steps?.length===1&&index===1);
  if(!workflow||!Array.isArray(workflow.steps)||(!legacyReceive&&workflow.steps.length!==summary.step_count)||!Number.isInteger(index)||index<0||(!legacyReceive&&index>=summary.step_count))throw new Error("assetfare_plan_approval_path_binding_failed");
  for(let offset=0;offset<summary.steps.length;offset+=1){const expected=summary.steps[offset],actual=workflow.steps[offset],scope=stepScope(actual);if(actual?.provider!==expected.provider||scope.sourceChain!==expected.from.split(":")[0]||scope.sourceToken!==expected.from.split(":")[1]||scope.destinationChain!==expected.to.split(":")[0]||scope.destinationToken!==expected.to.split(":")[1]||Number(actual.route_fee_bps)!==expected.assetfare_fee_bps)throw new Error("assetfare_plan_approval_path_binding_failed");}
  if(legacyReceive){
    const first=workflow.steps[0],receiveStep=workflow.steps[1],source=summary.from.split(":")[0],destination=summary.to.split(":")[0],wallet=workflow.wallets?.[destination],evidence=first?.source_receipt?.provider_evidence,sourceTx=first?.submission?.transaction_hash;
    const exactReceive=first?.kind==="direct_bridge"&&first?.provider==="circle_cctp"&&first?.cctp_mode==="no_forward"&&first?.from===source&&first?.to===destination&&first?.asset==="USDC"&&Number(first?.route_fee_bps)===1&&first?.status==="attestation_verified"&&first?.receipt?.kind==="cctp_attestation"&&first?.receipt?.source_transaction_hash===sourceTx&&typeof evidence?.sourceMessage==="string"&&/^0x[0-9a-fA-F]+$/u.test(evidence.sourceMessage)&&/^0x[0-9a-fA-F]{64}$/u.test(evidence.sourceMessageHash||"")&&receiveStep?.kind==="direct_receive"&&receiveStep?.provider==="circle_cctp_receive"&&receiveStep?.chain===destination&&receiveStep?.source_chain===source&&receiveStep?.from==="USDC"&&receiveStep?.to==="USDC"&&receiveStep?.cctp_mode==="no_forward"&&Number(receiveStep?.route_fee_bps)===0&&receiveStep?.caller_wallet===wallet&&receiveStep?.recipient_wallet===wallet&&receiveStep?.source_tx_hash===sourceTx&&receiveStep?.source_message===evidence?.sourceMessage&&receiveStep?.source_message_hash===evidence?.sourceMessageHash&&BigInt(receiveStep?.burn_amount_base??0)===BigInt(evidence?.burnUSDC??-1)&&BigInt(receiveStep?.actual_input_base??0)===BigInt(evidence?.burnUSDC??-1)&&BigInt(first?.actual_output_base??0)===BigInt(evidence?.burnUSDC??-1);
    if(!exactReceive)throw new Error("assetfare_plan_approval_path_binding_failed");
  }
  const step=summary.steps[legacyReceive?0:index],spend=integer(receipt?.spend?.maximum_amount_base,"approval_spend",1),receive=integer(receipt?.receive?.minimum_amount_base,"approval_receive",1),stepMaximum=integer(step.expected_input_base,"approval_step_input",1),stepMinimum=integer(step.minimum_output_base,"approval_step_output",1);
  if(spend>stepMaximum||receive<stepMinimum||(index===0&&spend>BigInt(approval.maximum_input_base))||((legacyReceive||index===summary.step_count-1)&&receive<BigInt(approval.minimum_output_base)))throw new Error("assetfare_plan_approval_bounds_binding_failed");
  return {path_and_provider_bound:true,caller_bounds_enforced:true,legacy_source_only_receive_recovery:legacyReceive,quote_id:approval.quote_id,quote_fingerprint:approval.quote_fingerprint};
}

async function responseText(response){
  const declared=Number(response.headers.get("content-length"));if(Number.isFinite(declared)&&declared>MAX_RESPONSE_BYTES)throw new Error("assetfare_plan_response_too_large");
  if(!response.body?.getReader){const text=await response.text();if(Buffer.byteLength(text,"utf8")>MAX_RESPONSE_BYTES)throw new Error("assetfare_plan_response_too_large");return text;}
  const reader=response.body.getReader(),chunks=[];let total=0;while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>MAX_RESPONSE_BYTES){await reader.cancel().catch(()=>{});throw new Error("assetfare_plan_response_too_large");}chunks.push(Buffer.from(value));}return Buffer.concat(chunks,total).toString("utf8");
}
async function requestJson(fetchImpl,url,options={}){
  let response;try{response=await fetchImpl(url,{...options,headers:{accept:"application/json",...(options.body?{"content-type":"application/json"}:{}),"x-assetfare-channel":"npm_plan_cli",...(options.headers||{})},redirect:"error",signal:AbortSignal.timeout(TIMEOUT_MS)});}catch{throw new Error("assetfare_plan_upstream_unavailable");}
  const media=String(response.headers.get("content-type")||"").split(";",1)[0].toLowerCase();if(media!=="application/json"&&!media.endsWith("+json"))throw new Error("assetfare_plan_response_invalid");
  let payload;try{payload=JSON.parse(await responseText(response));}catch{throw new Error("assetfare_plan_response_invalid");}
  if(!response.ok){if(response.status===409){let safe;try{safe=reapprovalV3Schema.parse(payload);}catch{throw new Error("assetfare_plan_request_rejected");}throw Object.assign(new Error(safe.reason),{status:409,reapproval:safe});}throw new Error(response.status===429?"assetfare_plan_rate_limited":response.status>=500?"assetfare_plan_upstream_unavailable":"assetfare_plan_request_rejected");}
  if(!payload||Array.isArray(payload)||typeof payload!=="object")throw new Error("assetfare_plan_response_invalid");return payload;
}

function validatedBase(value){const url=new URL(value||DEFAULT_API_BASE);if(url.search||url.hash||url.username||url.password||url.pathname!=="/")throw new Error("assetfare_plan_api_base_invalid");if(url.protocol!=="https:"&&!(["127.0.0.1","localhost"].includes(url.hostname)&&url.protocol==="http:"))throw new Error("assetfare_plan_api_base_invalid");return url.origin;}

function sessionVerificationContext({intent,wallets,eventSignerPublic,approval,directRouteSummary}){
  const value={version:"assetfare-session-verification-context-v1",intent:structuredClone(intent),wallets:structuredClone(wallets),event_signer_public:eventSignerPublic||null,approval_v3:structuredClone(approval),direct_route_summary:structuredClone(directRouteSummary)};
  return {value,sha256:sha256(value)};
}

function sessionCapabilityValue({token,quoteId,idempotencyKey,sessionId,verificationContext}){
  return {version:"assetfare-caller-session-capability-v2",session_token:token,quote_id:quoteId,idempotency_key:idempotencyKey,...(sessionId?{session_id:sessionId}:{}),verification_context:structuredClone(verificationContext.value),verification_context_sha256:verificationContext.sha256,sensitivity:"sensitive_bearer_capability",is_private_key:false};
}

function writeSessionToken(path,{token,quoteId,idempotencyKey,verificationContext}){
  const absolute=resolve(path),temporary=`${absolute}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;let descriptor;
  try{descriptor=openSync(temporary,"wx",0o600);writeFileSync(descriptor,`${JSON.stringify(sessionCapabilityValue({token,quoteId,idempotencyKey,verificationContext}),null,2)}\n`,{encoding:"utf8"});fsyncSync(descriptor);chmodSync(temporary,0o600);closeSync(descriptor);descriptor=undefined;linkSync(temporary,absolute);unlinkSync(temporary);}
  catch(error){if(descriptor!==undefined)closeSync(descriptor);try{unlinkSync(temporary);}catch{}throw new Error(error?.code==="EEXIST"?"assetfare_plan_session_token_output_exists":"assetfare_plan_session_token_output_invalid");}
  return absolute;
}

function writeWalletHandoff(path,value){
  const absolute=resolve(path),temporary=`${absolute}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;let descriptor;
  try{descriptor=openSync(temporary,"wx",0o600);writeFileSync(descriptor,`${JSON.stringify(value,null,2)}\n`,{encoding:"utf8"});fsyncSync(descriptor);chmodSync(temporary,0o600);closeSync(descriptor);descriptor=undefined;linkSync(temporary,absolute);unlinkSync(temporary);}
  catch(error){if(descriptor!==undefined)closeSync(descriptor);try{unlinkSync(temporary);}catch{}throw new Error(error?.code==="EEXIST"?"assetfare_plan_wallet_handoff_output_exists":"assetfare_plan_wallet_handoff_output_invalid");}
  return absolute;
}

function requireNewWalletHandoffPath(path){
  const absolute=resolve(path);try{lstatSync(absolute);throw new Error("exists");}catch(error){if(error?.code!=="ENOENT")throw new Error("assetfare_plan_wallet_handoff_output_exists");}return absolute;
}

function readSessionCapability(path){
  const absolute=resolve(path);let descriptor,metadata,text,value;
  try{descriptor=openSync(absolute,constants.O_RDONLY|constants.O_NOFOLLOW);metadata=fstatSync(descriptor);if(!metadata.isFile()||(metadata.mode&0o077)!==0||metadata.size<2||metadata.size>65_536)throw new Error("mode");text=readFileSync(descriptor,"utf8");value=JSON.parse(text);}
  catch{throw new Error("assetfare_plan_session_capability_input_invalid");}
  finally{if(descriptor!==undefined)closeSync(descriptor);}
  if(!value||Array.isArray(value)||typeof value!=="object")throw new Error("assetfare_plan_session_capability_input_invalid");
  const keys=Object.keys(value),legacyAllowed=new Set(["version","session_token","quote_id","idempotency_key","session_id","sensitivity","is_private_key"]),currentAllowed=new Set([...legacyAllowed,"verification_context","verification_context_sha256"]),allowed=value.version==="assetfare-caller-session-capability-v2"?currentAllowed:legacyAllowed;
  const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if(keys.some((key)=>!allowed.has(key))||!["assetfare-caller-session-capability-v1","assetfare-caller-session-capability-v2"].includes(value.version)||!/^[A-Za-z0-9_-]{43}$/.test(value.session_token||"")||!uuid.test(value.quote_id||"")||!approvedIdempotency(value.idempotency_key)||value.sensitivity!=="sensitive_bearer_capability"||value.is_private_key!==false||(value.session_id!==undefined&&!uuid.test(value.session_id)))throw new Error("assetfare_plan_session_capability_input_invalid");
  if(value.version==="assetfare-caller-session-capability-v2"){
    const context=value.verification_context,contextKeys=["version","intent","wallets","event_signer_public","approval_v3","direct_route_summary"];
    if(!context||Array.isArray(context)||typeof context!=="object"||Object.keys(context).length!==contextKeys.length||contextKeys.some((key)=>!Object.hasOwn(context,key))||context.version!=="assetfare-session-verification-context-v1"||!/^[0-9a-f]{64}$/.test(value.verification_context_sha256||"")||sha256(context)!==value.verification_context_sha256)throw new Error("assetfare_plan_session_capability_input_invalid");
    const intent=context.intent,wallets=context.wallets,summary=context.direct_route_summary;let approval;
    try{approval=approvalV3Schema.parse(context.approval_v3);}catch{throw new Error("assetfare_plan_session_capability_input_invalid");}
    if(!intent||Object.keys(intent).sort().join(",")!=="amount_usd,from_chain,from_token,to_chain,to_token"||typeof intent.amount_usd!=="number"||!Number.isFinite(intent.amount_usd)||intent.amount_usd<1||!wallets||Array.isArray(wallets)||typeof wallets!=="object"||!Object.keys(wallets).length||Object.entries(wallets).some(([chain,address])=>!CHAINS.has(chain)||(chain==="solana"?!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address):!/^0x[0-9a-fA-F]{40}$/.test(address)))||!(context.event_signer_public===null||/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(context.event_signer_public))||approval.selected_mode!=="session"||approval.selection_status!=="selected"||approval.quote_id!==value.quote_id||approval.idempotency_key!==value.idempotency_key||!summary||summary.route!==`${intent.from_chain}:${intent.from_token}->${intent.to_chain}:${intent.to_token}`||summary.from!==`${intent.from_chain}:${intent.from_token}`||summary.to!==`${intent.to_chain}:${intent.to_token}`||sha256(summary)!==approval.direct_route_summary_sha256)throw new Error("assetfare_plan_session_capability_input_invalid");
  }
  return {...value,path:absolute};
}

function approvedIdempotency(value){return typeof value==="string"&&/^[A-Za-z0-9._:-]{8,128}$/.test(value);}

function updateSessionCapability(path,capability,sessionId,verificationContext){
  const absolute=resolve(path),temporary=`${absolute}.tmp-${process.pid}-${randomBytes(16).toString("hex")}`;let descriptor;
  try{descriptor=openSync(temporary,"wx",0o600);writeFileSync(descriptor,`${JSON.stringify(sessionCapabilityValue({token:capability.session_token,quoteId:capability.quote_id,idempotencyKey:capability.idempotency_key,sessionId,verificationContext}),null,2)}\n`,{encoding:"utf8"});fsyncSync(descriptor);chmodSync(temporary,0o600);closeSync(descriptor);descriptor=undefined;renameSync(temporary,absolute);}
  catch{if(descriptor!==undefined)closeSync(descriptor);try{unlinkSync(temporary);}catch{}throw new Error("assetfare_plan_session_capability_update_failed");}
  return absolute;
}

function callerWalletHandoff(bundle,verification){
  if(!bundle||verification?.verified!==true)throw new Error("assetfare_plan_wallet_handoff_unverified");
  const action=bundle.unsigned_action,receipt=action.safety_receipt,rows=rawActionRows(action),family=rows[0]?.programId?"solana":"evm";
  const common={version:"assetfare-caller-wallet-handoff-v3",action_id:bundle.action_id,workflow_id:bundle.workflow_id,step_index:bundle.step_index,route:bundle.route,expires_at:bundle.expires_at,verified_bundle:structuredClone(bundle),verification:structuredClone(verification),verification_scope:verification.verification_scope,simulation_performed_by_assetfare_plan:false,requires_fresh_caller_simulation:true,caller_wallet_signing_required:true,caller_wallet_submission_required:true,caller_owned_wallet_adapter_required:true,caller_policy_authorization_required:true,delegated_agent_execution_supported:true,manual_wallet_confirmation_supported:true,human_confirmation_required_by_assetfare:false,assetfare_automatic_wallet_invocation_forbidden:true,assetfare_server_key_access:false,assetfare_wallet_invoked:false,assetfare_server_signing:false,assetfare_server_submission:false,assetfare_signed:false,assetfare_submitted:false,post_submission:"Return only caller-wallet-submitted transaction hashes to the session observer. AssetFare never receives a key, signs, submits, or chooses the caller's wallet policy."};
  let handoff;
  if(family==="evm"){
    const chainIds=new Set(rows.map((row)=>Number(row.chainId)));if(chainIds.size!==1||[...chainIds].some((value)=>!Number.isSafeInteger(value)||value<=0))throw new Error("assetfare_plan_wallet_handoff_chain_invalid");
    handoff={...common,chain_family:"evm",wallet_standard:"EIP-1193",chain_id:[...chainIds][0],ordered_requests:rows.map((row,index)=>({index,method:"eth_sendTransaction",params:[{from:row.from,to:row.to,value:`0x${BigInt(row.value??0).toString(16)}`,data:row.data,chainId:`0x${Number(row.chainId).toString(16)}`}],assetfare_automatic_invocation_forbidden:true,caller_owned_policy_required:true})),caller_checks:["recompute the bundle, action, raw payload and handoff hashes before using a request template","switch the wallet to the exact chain_id","decode target, selector, token approval and native value against verified_bundle.unsigned_action.safety_receipt","simulate each ordered request against a trusted caller-selected RPC immediately before caller confirmation or delegated-policy execution","authorize through either explicit wallet confirmation or a caller-owned local agent policy; never grant an unlimited approval"]};
  }else{
    handoff={...common,chain_family:"solana",wallet_standard:"Solana Wallet Standard",cluster:receipt.network.source_chain_id,transaction_construction:{fee_payer:receipt.parties.fee_payer,recent_blockhash:"FETCH_FRESH_FROM_CALLER_SELECTED_RPC",last_valid_block_height:"FETCH_WITH_RECENT_BLOCKHASH",instructions:structuredClone(rows),address_lookup_table_addresses:structuredClone(action.addressLookupTableAddresses||action.address_lookup_table_addresses||[]),required_signers:structuredClone(action.requiredSigners||action.signers)},wallet_method_after_construction:"signAndSendTransaction",assetfare_automatic_method_invocation_forbidden:true,caller_owned_policy_required:true,caller_checks:["recompute the bundle, action, raw payload and handoff hashes before constructing a transaction","rebuild a fresh transaction from these exact instructions and address lookup tables without adding or reordering instructions","fetch a fresh recent blockhash from a trusted caller-selected RPC","require every listed signer, including any caller-owned event signer","simulate the complete transaction immediately before caller confirmation or delegated-policy execution","authorize through either explicit wallet confirmation or a caller-owned local agent policy and record only the submitted signature"]};
  }
  handoff.handoff_sha256_spec="sha256(UTF-8 sorted-key compact JSON of this handoff excluding handoff_sha256)";handoff.handoff_sha256=sha256(handoff);return handoff;
}

async function runPlan(argv,{fetchImpl=fetch,stdout=process.stdout,nowMs}={}){
  const args=parseArgs(argv);if(args.help){stdout.write(usage());return {help:true};}
  if(args.wallet_handoff_output)requireNewWalletHandoffPath(args.wallet_handoff_output);
  const apiBase=validatedBase(args.api_base||process.env.ASSETFARE_API_BASE_URL||DEFAULT_API_BASE);delete args.api_base;
  const rawQuote=readJsonFile(args.quote,"quote"),source=String(rawQuote.intent?.from||"").split(":"),destination=String(rawQuote.intent?.to||"").split(":");
  if(source.length!==2||destination.length!==2)throw new Error("assetfare_plan_quote_intent_invalid");
  const intent={from_chain:source[0],from_token:source[1],to_chain:destination[0],to_token:destination[1],amount_usd:rawQuote.intent?.amount_usd};
  const quote=parseV2Quote(rawQuote,intent),continuation=validateContinuationV3(quote.continuation_v3,quote,{requireUnexpired:true,nowMs:nowMs??Date.now()});
  if(Date.parse(continuation.expires_at)-(nowMs??Date.now())<=MINIMUM_PLAN_REMAINING_MS)throw new Error("assetfare_plan_quote_near_expiry_requote_required");
  const sessionCapability=args.session_capability_input?readSessionCapability(args.session_capability_input):null;
  if(sessionCapability&&sessionCapability.quote_id!==continuation.quote_id)throw new Error("assetfare_plan_session_capability_quote_mismatch");
  const approvalSource=args.select_exact_quote_bounds?"explicit_local_exact_quote_bounds":"caller_supplied_file";
  const rawApproval=args.select_exact_quote_bounds?{version:APPROVAL_V3_VERSION,quote_id:continuation.quote_id,quote_fingerprint:continuation.quote_fingerprint,selection_status:"selected",selected_mode:args.mode,maximum_input_base:continuation.input_base_bounds.maximum,minimum_output_base:continuation.minimum_output_base,direct_route_summary_sha256:continuation.direct_route_summary_sha256,idempotency_key:sessionCapability?.idempotency_key||`plan.${randomBytes(16).toString("hex")}`}:readJsonFile(args.approval,"approval");
  const approval=validateApprovalV3(rawApproval,continuation,{mode:args.mode,requireUnexpired:true,nowMs:nowMs??Date.now()});
  if(sessionCapability&&sessionCapability.idempotency_key!==approval.idempotency_key)throw new Error("assetfare_plan_session_capability_idempotency_mismatch");
  if(quote.execution?.supported!==true||quote.execution?.first_unsigned_action_supported!==true)throw new Error("assetfare_plan_execution_not_ready");
  if(args.mode==="one_shot"&&quote.direct_route_summary.step_count>1)throw new Error("assetfare_plan_multistep_session_required");
  const expectedWallets=[...continuation.required_wallet_chains].sort(),actualWallets=Object.keys(args.wallets).sort();if(canonical(expectedWallets)!==canonical(actualWallets))throw new Error("assetfare_plan_required_wallet_chains_mismatch");
  if(continuation.event_signer_public_required!==Boolean(args.event_signer_public))throw new Error(continuation.event_signer_public_required?"assetfare_plan_event_signer_public_required":"assetfare_plan_event_signer_public_not_allowed");
  const verificationContext=args.mode==="session"?sessionVerificationContext({intent,wallets:args.wallets,eventSignerPublic:args.event_signer_public,approval,directRouteSummary:quote.direct_route_summary}):null;
  if(sessionCapability?.verification_context&&canonical(sessionCapability.verification_context)!==canonical(verificationContext.value))throw new Error("assetfare_plan_session_capability_context_mismatch");
  const body={caller_approved:args.caller_approved,...intent,wallets:args.wallets,...(args.event_signer_public?{event_signer_public:args.event_signer_public}:{}),approval_v3:approval,...(args.mode==="session"?{idempotency_key:approval.idempotency_key}:{})};
  let bundle=null,session=null,verification=null,sessionTokenPath=sessionCapability?.path||null,sessionTokenPersisted=Boolean(sessionCapability),sessionTokenReused=Boolean(sessionCapability);
  if(args.mode==="one_shot"){
    bundle=parseV2Bundle(await requestJson(fetchImpl,`${apiBase}/v2/prepare`,{method:"POST",body:JSON.stringify(body)}));verification={...verifyPlanBundle(bundle,{...intent,wallets:args.wallets,event_signer_public:args.event_signer_public},nowMs??Date.now()),approval_v3:verifyApprovalBundleBounds(bundle,quote,approval)};
  }else{
    const sessionToken=sessionCapability?.session_token||randomBytes(32).toString("base64url");if(!/^[A-Za-z0-9_-]{43}$/.test(sessionToken))throw new Error("assetfare_plan_session_token_generation_failed");
    if(args.session_token_output){sessionTokenPath=writeSessionToken(args.session_token_output,{token:sessionToken,quoteId:approval.quote_id,idempotencyKey:approval.idempotency_key,verificationContext});sessionTokenPersisted=true;}
    session=parseV2Session(await requestJson(fetchImpl,`${apiBase}/v2/session`,{method:"POST",headers:{"x-assetfare-session-token":sessionToken},body:JSON.stringify(body)}),approval,sessionToken);
    if(sessionTokenPath){updateSessionCapability(sessionTokenPath,{session_token:sessionToken,quote_id:approval.quote_id,idempotency_key:approval.idempotency_key},session.session_id,verificationContext);sessionTokenPersisted=true;}
    if(session.current_action){bundle=session.current_action;verification={...verifyPlanBundle(bundle,{...intent,wallets:args.wallets,event_signer_public:args.event_signer_public},nowMs??Date.now()),approval_v3:verifyApprovalBundleBounds(bundle,quote,approval)};}
  }
  const walletHandoff=bundle?callerWalletHandoff(bundle,verification):null;if(args.wallet_handoff_output&&!walletHandoff)throw new Error("assetfare_plan_wallet_handoff_unavailable");const walletHandoffPath=args.wallet_handoff_output?writeWalletHandoff(args.wallet_handoff_output,walletHandoff):null;
  const result={status:"pass",mode:args.mode,approval_v3_enforced:true,approval_v3_source:approvalSource,approval_v3_generated_locally:args.select_exact_quote_bounds,selection_status:"selected",selection_was_explicit:true,automatic_selection_performed:false,human_approval_proof_claimed:false,caller_approved_boolean_is_not_human_proof:true,intent,quote_summary:{quote_id:quote.quote_id,quote_fingerprint:continuation.quote_fingerprint,expires_at:continuation.expires_at,direct_route_summary:quote.direct_route_summary,cost_summary:quote.cost_summary,eta:quote.eta,offer:quote.offer},verification,...(bundle?{bundle,caller_wallet_handoff:walletHandoff}:{}),wallet_handoff_output_path:walletHandoffPath,...(session?{session}:{}),session_token_persisted:sessionTokenPersisted,session_token_output_path:sessionTokenPath,session_capability_reused:sessionTokenReused,session_create_retry_idempotent:sessionTokenReused,session_recovery_after_process_exit:sessionTokenPersisted,raw_session_token_exposed:false,server_signing:false,server_submission:false,signed:false,submitted:false};
  stdout.write(`${JSON.stringify(result,null,2)}\n`);return result;
}

if(isMain(import.meta.url))runPlan(process.argv.slice(2)).catch((error)=>{process.stderr.write(`${JSON.stringify({status:"fail",error:error?.message||"assetfare_plan_failed",server_signing:false,server_submission:false})}\n`);process.exitCode=1;});

export { ACTION_CLOCK_SKEW_MS, MAX_ACTION_TTL_MS, callerWalletHandoff, canonical, parseArgs, readSessionCapability, requestJson, requireNewWalletHandoffPath, runPlan, sessionVerificationContext, sha256, updateSessionCapability, usage, validatedBase, verifyApprovalBundleBounds, verifyPlanBundle, writeSessionToken, writeWalletHandoff };
