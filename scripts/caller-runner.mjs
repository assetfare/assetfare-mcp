#!/usr/bin/env node
/** Local caller-owned wallet orchestration. AssetFare never receives a key. */

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isMain } from "../src/is-main.js";
import { runCallerOwnedSession } from "../src/caller-runner.js";

function usage(){return `Usage:
  assetfare-agent-runner \\
    --capability-file ./session-capability.json \\
    --policy-file ./caller-execution-policy.json \\
    --state-file ./caller-runner-state.json \\
    --wallet-adapter ./my-local-wallet-adapter.mjs

The adapter is caller-selected, caller-owned local code. It keeps keys in the caller's wallet
environment and returns only simulations, public receipts, and transaction
hashes. AssetFare's server never receives a key, signs, submits, selects a wallet,
or becomes custodian. This CLI intentionally has no private-key, seed, mnemonic,
keystore, raw-transaction, or hosted-signer option.
`;}

function parseArgs(argv){const out={};const names=new Set(["capability-file","policy-file","state-file","wallet-adapter","api-base"]);for(let i=0;i<argv.length;i+=1){const raw=argv[i];if(raw==="--help"||raw==="-h")return {help:true};if(!raw.startsWith("--"))throw new Error("assetfare_runner_argument_invalid");const equal=raw.indexOf("="),key=raw.slice(2,equal<0?undefined:equal);if(!names.has(key))throw new Error("assetfare_runner_argument_unknown");const value=equal>=0?raw.slice(equal+1):argv[++i];if(typeof value!=="string"||!value||Object.hasOwn(out,key.replaceAll("-","_")))throw new Error("assetfare_runner_argument_invalid");out[key.replaceAll("-","_")]=value;}for(const key of ["capability_file","policy_file","state_file","wallet_adapter"])if(!out[key])throw new Error(`assetfare_runner_${key}_missing`);return out;}

async function loadAdapter(path){const absolute=resolve(path);let metadata;try{metadata=lstatSync(absolute);}catch{throw new Error("assetfare_runner_wallet_adapter_invalid");}if(!metadata.isFile()||metadata.isSymbolicLink()||metadata.uid!==process.getuid()||(metadata.mode&0o022)!==0||metadata.size<2||metadata.size>1_048_576)throw new Error("assetfare_runner_wallet_adapter_invalid");let imported;try{imported=await import(pathToFileURL(absolute).href);}catch{throw new Error("assetfare_runner_wallet_adapter_load_failed");}if(typeof imported.createCallerWalletAdapter!=="function")throw new Error("assetfare_runner_wallet_adapter_factory_missing");const adapter=await imported.createCallerWalletAdapter();return adapter;}

async function run(argv,{stdout=process.stdout,stderr=process.stderr}={}){const args=parseArgs(argv);if(args.help){stdout.write(usage());return {help:true};}const adapter=await loadAdapter(args.wallet_adapter);const result=await runCallerOwnedSession({capabilityFile:args.capability_file,policyFile:args.policy_file,stateFile:args.state_file,walletAdapter:adapter,apiBase:args.api_base,onProgress:value=>stderr.write(`${JSON.stringify({assetfare_caller_runner:true,...value})}\n`)});stdout.write(`${JSON.stringify(result,null,2)}\n`);return result;}

function failure(error){const message=String(error?.message||""),safe=/^(assetfare_runner|assetfare_plan|assetfare_session)_[A-Za-z0-9_:-]+$/.test(message)?message:`assetfare_runner_failed:${createHash("sha256").update(message).digest("hex").slice(0,16)}`;return {status:"fail",error:safe,key_location:"caller_wallet_adapter_only",assetfare_server_key_access:false,assetfare_server_signing:false,assetfare_server_submission:false};}

if(isMain(import.meta.url))run(process.argv.slice(2)).catch(error=>{process.stderr.write(`${JSON.stringify(failure(error))}\n`);process.exitCode=1;});

export { failure, loadAdapter, parseArgs, run, usage };
