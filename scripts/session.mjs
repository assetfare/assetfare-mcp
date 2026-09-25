#!/usr/bin/env node
/** Resume and advance a caller-owned AssetFare session. Never signs or submits. */

import { isMain } from "../src/is-main.js";
import { parseV2Session } from "../src/server.js";
import { callerWalletHandoff, readSessionCapability, requestJson, requireNewWalletHandoffPath, validatedBase, verifyApprovalBundleBounds, verifyPlanBundle, writeWalletHandoff } from "./plan.mjs";

const OPERATIONS = new Set(["get", "observe-source", "observe-output", "refresh", "wallet-ready"]);
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,128}$/;
const HASH = /^[A-Za-z0-9:_-]{16,128}$/;
const WALLET_READY_MINIMUM_REMAINING_MS = 120_000;

function usage() {
  return `Usage:
  assetfare-session --operation get \\
    --capability-file ./session-capability.json

  assetfare-session --operation observe-source \\
    --capability-file ./session-capability.json \\
    --idempotency-key source-0001 \\
    --transaction-hash <CALLER_SUBMITTED_HASH>

  assetfare-session --operation get \\
    --capability-file ./session-capability.json \\
    --wallet-handoff-output ./step-2-wallet-handoff.json

  assetfare-session --operation wallet-ready \\
    --capability-file ./session-capability.json \\
    --idempotency-key wallet-ready-0001 \\
    --wallet-handoff-output ./wallet-ready-handoff.json

Operations: get | observe-source | observe-output | refresh | wallet-ready

The mode-0600 capability file is created and updated by assetfare-plan and must
contain the session ID. This command sends the bearer token only in the
X-AssetFare-Session-Token header, never prints it, accepts only already-submitted
transaction hashes, validates the returned session, and never signs or submits.
Every non-null current action is checked through the same semantic verifier used
for the first action and converted to a fresh self-verifying wallet handoff.
wallet-ready uses a current action only when at least 120 seconds remain. If an
unsubmitted action is expired, it refreshes exactly that session step and writes
the verified replacement handoff. It never replaces a still-live action early,
which avoids two simultaneously valid requests for the same step.
`;
}

function parseArgs(argv) {
  const out = { transaction_hashes: [] };
  const valueKeys = new Set(["operation", "capability-file", "session-id", "idempotency-key", "transaction-hash", "wallet-handoff-output", "api-base"]);
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "--help" || raw === "-h") return { help: true };
    if (!raw.startsWith("--")) throw new Error("assetfare_session_argument_invalid");
    const equal = raw.indexOf("=");
    const key = raw.slice(2, equal < 0 ? undefined : equal);
    if (!valueKeys.has(key)) throw new Error("assetfare_session_argument_unknown");
    const value = equal >= 0 ? raw.slice(equal + 1) : argv[++index];
    if (typeof value !== "string" || !value) throw new Error(`assetfare_session_${key.replaceAll("-", "_")}_missing`);
    if (key === "transaction-hash") {
      if (out.transaction_hashes.length >= 8 || !HASH.test(value)) throw new Error("assetfare_session_transaction_hash_invalid");
      out.transaction_hashes.push(value);
      continue;
    }
    const normalized = key.replaceAll("-", "_");
    if (Object.hasOwn(out, normalized)) throw new Error("assetfare_session_argument_duplicate");
    out[normalized] = value;
  }
  for (const key of ["operation", "capability_file"]) if (!out[key]) throw new Error(`assetfare_session_${key}_missing`);
  if (!OPERATIONS.has(out.operation)) throw new Error("assetfare_session_operation_invalid");
  const mutating = out.operation !== "get";
  if (mutating !== Boolean(out.idempotency_key) || (out.idempotency_key && !IDEMPOTENCY.test(out.idempotency_key))) throw new Error("assetfare_session_idempotency_key_invalid");
  if (out.operation === "observe-source" && out.transaction_hashes.length < 1) throw new Error("assetfare_session_transaction_hash_missing");
  if (out.operation === "observe-output" && out.transaction_hashes.length > 1) throw new Error("assetfare_session_transaction_hash_invalid");
  if (!["observe-source", "observe-output"].includes(out.operation) && out.transaction_hashes.length) throw new Error("assetfare_session_transaction_hash_not_allowed");
  if (out.operation === "wallet-ready" && !out.wallet_handoff_output) throw new Error("assetfare_session_wallet_handoff_output_missing");
  return out;
}

async function runSession(argv, { fetchImpl = fetch, stdout = process.stdout, nowMs, allowExpiredActionWithoutHandoff=false } = {}) {
  const args = parseArgs(argv);
  if (args.help) { stdout.write(usage()); return { help: true }; }
  if(args.wallet_handoff_output)requireNewWalletHandoffPath(args.wallet_handoff_output);
  const capability = readSessionCapability(args.capability_file);
  const sessionId = args.session_id || capability.session_id;
  if (!sessionId || (args.session_id && capability.session_id && args.session_id !== capability.session_id)) throw new Error("assetfare_session_id_mismatch_or_missing");
  const apiBase = validatedBase(args.api_base || process.env.ASSETFARE_API_BASE_URL || "https://api.assetfare.dev");
  const root = `${apiBase}/v2/session/${sessionId}`;
  const context=capability.verification_context||null,approval=context?.approval_v3||null,clock=()=>nowMs??Date.now();
  let url = root;
  let options = { headers: { "x-assetfare-session-token": capability.session_token } };
  if (args.operation === "observe-source") {
    url = `${root}/observe-source`;
    options = { ...options, method: "POST", body: JSON.stringify({ idempotency_key: args.idempotency_key, transaction_hashes: args.transaction_hashes }) };
  } else if (args.operation === "observe-output") {
    url = `${root}/observe-output`;
    options = { ...options, method: "POST", body: JSON.stringify({ idempotency_key: args.idempotency_key, ...(args.transaction_hashes[0] ? { transaction_hash: args.transaction_hashes[0] } : {}) }) };
  } else if (args.operation === "refresh") {
    url = `${root}/refresh-action`;
    options = { ...options, method: "POST", body: JSON.stringify({ idempotency_key: args.idempotency_key }) };
  }
  let autoRefreshed=false;
  let session = parseV2Session(await requestJson(fetchImpl, url, options), approval, capability.session_token);
  if(args.operation==="wallet-ready"){
    const firstRemaining=session.current_action?Date.parse(session.current_action.expires_at)-clock():null;
    const expiredAction=Number.isFinite(firstRemaining)&&firstRemaining<=0;
    if(!session.current_action||expiredAction){
      if(!expiredAction&&session.status!=="action_expired"&&session.next_operation!=="refresh_action")throw new Error("assetfare_session_wallet_ready_action_unavailable");
      session=parseV2Session(await requestJson(fetchImpl,`${root}/refresh-action`,{headers:options.headers,method:"POST",body:JSON.stringify({idempotency_key:args.idempotency_key})}),approval,capability.session_token);autoRefreshed=true;
    }
  }
  if (session.session_id !== sessionId) throw new Error("assetfare_session_response_id_mismatch");
  let verification=null,walletHandoff=null,walletHandoffPath=null;
  const verificationNow=clock();
  const expiredCurrentAction=Boolean(session.current_action)&&Number.isFinite(Date.parse(session.current_action.expires_at))&&Date.parse(session.current_action.expires_at)<=verificationNow;
  if(session.current_action){
    if(!context)throw new Error("assetfare_session_verification_context_required");
    if(expiredCurrentAction&&allowExpiredActionWithoutHandoff!==true)throw new Error("assetfare_session_expired_action_refresh_required");
    if(args.operation==="wallet-ready"){
      const remaining=Date.parse(session.current_action.expires_at)-verificationNow;
      if(!Number.isFinite(remaining)||remaining<WALLET_READY_MINIMUM_REMAINING_MS){const error=Object.assign(new Error("assetfare_session_wallet_ready_wait_for_expiry"),{retry_after_ms:Number.isFinite(remaining)?Math.max(1000,remaining+1000):null});throw error;}
    }
    if(!expiredCurrentAction){
      const expected={...context.intent,wallets:context.wallets,...(context.event_signer_public?{event_signer_public:context.event_signer_public}:{})};
      verification={...verifyPlanBundle(session.current_action,expected,verificationNow),approval_v3:verifyApprovalBundleBounds(session.current_action,{direct_route_summary:context.direct_route_summary},approval)};
      walletHandoff=callerWalletHandoff(session.current_action,verification);
      if(args.wallet_handoff_output)walletHandoffPath=writeWalletHandoff(args.wallet_handoff_output,walletHandoff);
    }
  }else if(args.wallet_handoff_output)throw new Error("assetfare_session_wallet_handoff_unavailable");
  const remainingMs=session.current_action?Date.parse(session.current_action.expires_at)-verificationNow:null;
  const result = { status: "pass", operation: args.operation, session,verification,...(walletHandoff?{caller_wallet_handoff:walletHandoff}:{}),wallet_handoff_output_path:walletHandoffPath,current_action_expired_without_handoff:expiredCurrentAction,wallet_ready_auto_refreshed:autoRefreshed,wallet_ready_remaining_seconds:remainingMs===null?null:Math.floor(remainingMs/1000),session_capability_version:capability.version,strict_quote_binding_verified:approval!==null,session_capability_path: capability.path, raw_session_token_exposed: false, transaction_signed: false, transaction_submitted: false, server_signing: false, server_submission: false };
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function sessionFailure(error){
  const recovery=error?.reapproval||null;
  const message=String(error?.message||"");
  return { status: "fail", error: message || "assetfare_session_failed",...(recovery?{recovery}:{}),...(Number.isFinite(error?.retry_after_ms)?{retry_after_ms:error.retry_after_ms}:{}),next_action:recovery?.recovery_operation||(message.includes("wallet_ready_wait_for_expiry")?"wait until the current unsubmitted action expires, then rerun wallet-ready with the same session capability and a new idempotency key":message.includes("id_mismatch_or_missing") ? "rerun assetfare-plan with the same capability file before quote expiry, or supply the recorded session ID" : "inspect the session state and retry only the same logical operation"), server_signing: false, server_submission: false };
}

if (isMain(import.meta.url)) runSession(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify(sessionFailure(error))}\n`);
  process.exitCode = 1;
});

export { WALLET_READY_MINIMUM_REMAINING_MS, parseArgs, runSession, sessionFailure, usage };
