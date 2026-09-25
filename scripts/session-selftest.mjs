#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSession } from "./session.mjs";

const directory = mkdtempSync(join(tmpdir(), "assetfare-session-"));
const capabilityPath = join(directory, "session-capability.json");
const token = "A".repeat(43);
const sessionId = "00000000-0000-4000-8000-000000000099";
writeFileSync(capabilityPath, `${JSON.stringify({ version:"assetfare-caller-session-capability-v1",session_token:token,quote_id:"00000000-0000-4000-8000-000000000001",idempotency_key:"create-0001",session_id:sessionId,sensitivity:"sensitive_bearer_capability",is_private_key:false })}\n`, { mode:0o600 });
chmodSync(capabilityPath, 0o600);

function payload() { return { session_id:sessionId,status:"ready",action_available:false,current_action:null,quote_binding:{version:"assetfare-quote-bound-session-constraints-v1",quote_id:"00000000-0000-4000-8000-000000000001",quote_fingerprint:"f".repeat(64),selected_mode:"session",whole_session_path_and_bounds_enforced:true,server_signing:false,server_submission:false},server_signing:false,server_submission:false,signed:false,submitted:false }; }
function mock({ echo=false }={}) { const calls=[];return { calls, fetch:async(url,init={})=>{calls.push({url:String(url),init});return new Response(JSON.stringify({...payload(),...(echo?{diagnostic_capability:init.headers["x-assetfare-session-token"]}:{})}),{status:200,headers:{"content-type":"application/json"}});}}; }

try {
  for (const [operation, extra, suffix, method] of [
    ["get", [], `/v2/session/${sessionId}`, "GET"],
    ["observe-source", ["--idempotency-key","source-0001","--transaction-hash","0xsourcehash000001"], `/v2/session/${sessionId}/observe-source`, "POST"],
    ["observe-output", ["--idempotency-key","output-0001","--transaction-hash","0xoutputhash000001"], `/v2/session/${sessionId}/observe-output`, "POST"],
    ["refresh", ["--idempotency-key","refresh-0001"], `/v2/session/${sessionId}/refresh-action`, "POST"],
  ]) {
    const network=mock();let output="";const result=await runSession(["--operation",operation,"--capability-file",capabilityPath,...extra,"--api-base","http://127.0.0.1:8788"],{fetchImpl:network.fetch,stdout:{write:value=>{output+=value;}}});
    assert.equal(new URL(network.calls[0].url).pathname,suffix);assert.equal(network.calls[0].init.method||"GET",method);assert.equal(network.calls[0].init.headers["x-assetfare-session-token"],token);assert.equal(result.raw_session_token_exposed,false);assert.ok(!output.includes(token));
  }
  let calls=0;await assert.rejects(()=>runSession(["--operation","observe-source","--capability-file",capabilityPath,"--idempotency-key","source-0002"],{fetchImpl:async()=>{calls+=1;},stdout:{write(){}}}),/transaction_hash_missing/);assert.equal(calls,0);
  const echo=mock({echo:true});await assert.rejects(()=>runSession(["--operation","get","--capability-file",capabilityPath,"--api-base","http://127.0.0.1:8788"],{fetchImpl:echo.fetch,stdout:{write(){}}}),/session_token_echo_rejected/);
  console.log(JSON.stringify({status:"pass",operations:4,capability_file_mode:"0600",raw_token_exposed:false,signing:false,submission:false,live_requests:false}));
} finally { rmSync(directory,{recursive:true,force:true}); }
