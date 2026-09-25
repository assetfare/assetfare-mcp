#!/usr/bin/env node
/** Offline contract check for a caller-owned wallet adapter. Never signs or submits. */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { validateAdapter } from "../src/caller-runner.js";
import { isMain } from "../src/is-main.js";

function parse(argv){
  if(argv.includes("--help")||argv.includes("-h"))return {help:true};
  if(argv.length!==2||argv[0]!=="--wallet-adapter")throw new Error("assetfare_adapter_conformance_usage");
  return {path:resolve(argv[1])};
}

async function main(argv=process.argv.slice(2),stdout=process.stdout){
  const options=parse(argv);
  if(options.help){stdout.write("Usage: assetfare-adapter-conformance --wallet-adapter ./caller-wallet-adapter.mjs\nOffline only: validates the public adapter contract and never calls signing or submission methods.\n");return;}
  const module=await import(pathToFileURL(options.path).href),factory=module.createCallerWalletAdapter;
  if(typeof factory!=="function")throw new Error("assetfare_adapter_factory_missing");
  const adapter=validateAdapter(await factory());
  stdout.write(`${JSON.stringify({status:"pass",wallet_adapter_contract:adapter.info.version,key_location:adapter.info.key_location,method_count:8,signing:false,submission:false,live_requests:false})}\n`);
}

if(isMain(import.meta.url))main().catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
export { main, parse };
