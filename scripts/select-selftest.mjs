#!/usr/bin/env node
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectQuote } from "./select.mjs";
import { quoteFixture } from "../test/quote-fixture.mjs";

const directory=mkdtempSync(join(tmpdir(),"assetfare-select-"));
const originalFetch=globalThis.fetch;let network=0;globalThis.fetch=async()=>{network+=1;throw new Error("network_forbidden");};
function save(name,value){const path=join(directory,name);writeFileSync(path,`${JSON.stringify(value)}\n`);return path;}
function rejects(argv,needle,nowMs){assert.throws(()=>selectQuote(argv,{stdout:{write(){}},nowMs}),new RegExp(needle));}
try{
  const now=Date.now(),one=quoteFixture({issuedAt:now}),quotePath=save("quote.json",one),approvalPath=join(directory,"approval.json");let stdout="";
  const result=selectQuote(["--quote",quotePath,"--mode","one_shot","--maximum-input-base",one.continuation_v3.input_base_bounds.maximum,"--minimum-output-base",one.continuation_v3.minimum_output_base,"--output",approvalPath],{stdout:{write:value=>{stdout+=value;}},nowMs:now+100});
  const approval=JSON.parse(readFileSync(approvalPath,"utf8"));
  assert.equal(lstatSync(approvalPath).mode&0o777,0o600);assert.equal(approval.selection_status,"selected");assert.equal(approval.selected_mode,"one_shot");assert.equal(approval.quote_fingerprint,one.continuation_v3.quote_fingerprint);assert.match(approval.idempotency_key,/^select\.[0-9a-f]{32}$/);assert.equal(result.network_requests,0);assert.equal(result.automatic_selection_performed,false);assert.equal(result.human_approval_proof_claimed,false);assert.doesNotMatch(stdout,/session_token|private_key|seed|secret/i);assert.equal(network,0);
  rejects(["--quote",quotePath,"--mode","one_shot","--maximum-input-base",one.continuation_v3.input_base_bounds.maximum,"--minimum-output-base",one.continuation_v3.minimum_output_base,"--output",approvalPath],"output_exists",now+100);
  rejects(["--quote",quotePath,"--mode","one_shot","--maximum-input-base",String(BigInt(one.continuation_v3.input_base_bounds.maximum)+1n),"--minimum-output-base",one.continuation_v3.minimum_output_base,"--output",join(directory,"weak-input.json")],"bounds_weaken",now+100);
  rejects(["--quote",quotePath,"--mode","one_shot","--maximum-input-base",one.continuation_v3.input_base_bounds.maximum,"--minimum-output-base",String(BigInt(one.continuation_v3.minimum_output_base)-1n),"--output",join(directory,"weak-output.json")],"bounds_weaken",now+100);
  rejects(["--quote",quotePath,"--mode","one_shot","--maximum-input-base",one.continuation_v3.input_base_bounds.maximum,"--minimum-output-base",one.continuation_v3.minimum_output_base,"--output",join(directory,"expired.json")],"ttl_invalid",now+61_000);
  rejects(["--quote",quotePath,"--mode","one_shot","--maximum-input-base",one.continuation_v3.input_base_bounds.maximum,"--minimum-output-base",one.continuation_v3.minimum_output_base,"--output",join(directory,"near-expiry.json")],"near_expiry_requote_required",now+45_001);
  const quoteSymlink=join(directory,"quote-symlink.json");symlinkSync(quotePath,quoteSymlink);rejects(["--quote",quoteSymlink,"--mode","one_shot","--maximum-input-base",one.continuation_v3.input_base_bounds.maximum,"--minimum-output-base",one.continuation_v3.minimum_output_base,"--output",join(directory,"symlink-output.json")],"quote_file_invalid",now+100);
  const multi=quoteFixture({from_chain:"solana",from_token:"SOL",to_chain:"base",to_token:"ETH",issuedAt:now,quote_id:"00000000-0000-4000-8000-000000000002"}),multiPath=save("multi.json",multi);
  assert.ok(multi.direct_route_summary.step_count>1);rejects(["--quote",multiPath,"--mode","one_shot","--maximum-input-base",multi.continuation_v3.input_base_bounds.maximum,"--minimum-output-base",multi.continuation_v3.minimum_output_base,"--output",join(directory,"multi-one.json")],"mode_not_allowed",now+100);
  const sessionPath=join(directory,"multi-session.json");selectQuote(["--quote",multiPath,"--mode","session","--maximum-input-base",multi.continuation_v3.input_base_bounds.maximum,"--minimum-output-base",multi.continuation_v3.minimum_output_base,"--output",sessionPath],{stdout:{write(){}},nowMs:now+100});assert.equal(JSON.parse(readFileSync(sessionPath)).selected_mode,"session");
  const tampered=structuredClone(one);tampered.as_of="2026-09-24T00:00:01Z";const tamperedPath=save("tampered.json",tampered);rejects(["--quote",tamperedPath,"--mode","one_shot","--maximum-input-base",one.continuation_v3.input_base_bounds.maximum,"--minimum-output-base",one.continuation_v3.minimum_output_base,"--output",join(directory,"tampered-approval.json")],"hash_mismatch",now+100);
  const sensitive=structuredClone(one);sensitive.private_key="forbidden";const sensitivePath=save("sensitive.json",sensitive);rejects(["--quote",sensitivePath,"--mode","one_shot","--maximum-input-base",one.continuation_v3.input_base_bounds.maximum,"--minimum-output-base",one.continuation_v3.minimum_output_base,"--output",join(directory,"sensitive-approval.json")],"secret_material_rejected",now+100);
  assert.equal(readdirSync(directory).some((name)=>name.includes(".tmp-")),false);assert.equal(network,0);
  console.log(JSON.stringify({status:"pass",network_requests:network,file_mode:"0600",atomic_output:true,symlink_input_rejected:true,multistep_session_only:true,hash_tamper_rejected:true,bounds_tamper_rejected:true,expired_rejected:true,near_expiry_requote_required:true,server_signing:false,server_submission:false}));
}finally{globalThis.fetch=originalFetch;rmSync(directory,{recursive:true,force:true});}
