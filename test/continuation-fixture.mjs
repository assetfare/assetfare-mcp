import { CONTINUATION_V3_VERSION, QUOTE_FINGERPRINT_SPEC, QUOTE_PAYLOAD_SHA256_SPEC, APPROVAL_V3_KEYS, quotePayloadSha256, sha256Canonical } from "../src/continuation-v3.js";

function decimal(value) {
  const text=String(value);
  if(!text.includes("e")&&!text.includes("E"))return text.includes(".")?text.replace(/0+$/,"").replace(/\.$/,""):text;
  return Number(value).toLocaleString("en-US",{useGrouping:false,maximumSignificantDigits:21});
}

export function continuationCapability() {
  return {version:CONTINUATION_V3_VERSION,required_on_every_quote:true,enforcement:"server_enforced_quote_binding",selection_status:"unranked_candidate",automatic_selection_forbidden:true,caller_approved_boolean_is_not_human_proof:true,cache_scope:"bounded_process_local_ttl_restart_fails_closed",maximum_ttl_seconds:60,maximum_cache_records:2048,multistep_allowed_modes:["session"],one_step_allowed_modes:["one_shot","session"],session_owner_binding:"sha256_of_caller_generated_session_token_raw_token_never_stored",whole_session_path_and_bounds_enforced:true,future_actions_requote_and_enforce_original_step_minimums:true,quote_payload_sha256_spec:QUOTE_PAYLOAD_SHA256_SPEC,server_signing:false,server_submission:false};
}

export function attachContinuation(quote,{issuedAt=Date.now(),ttl=quote.ttl_seconds||60}={}) {
  delete quote.continuation_v3;
  quote.ttl_seconds=ttl;
  const summary=quote.direct_route_summary,input=summary.steps[0].expected_input_base,minimum=summary.steps.at(-1).minimum_output_base;
  const required=[...new Set(summary.steps.flatMap((step)=>[step.from.split(":")[0],step.to.split(":")[0]]))].sort();
  const signer=summary.steps.some((step)=>step.provider==="circle_cctp"&&step.from.startsWith("solana:"));
  const allowed=summary.step_count>1?["session"]:["one_shot","session"];
  const issued=new Date(issuedAt).toISOString().replace(".000Z",".000Z"),expires=new Date(issuedAt+ttl*1000).toISOString().replace(".000Z",".000Z");
  const summaryHash=sha256Canonical(summary),payloadHash=quotePayloadSha256(quote);
  const claim={version:CONTINUATION_V3_VERSION,quote_id:quote.quote_id,issued_at:issued,expires_at:expires,ttl_seconds:String(ttl),intent:{from:quote.intent.from,to:quote.intent.to,amount_usd_decimal:decimal(quote.intent.amount_usd),estimated_input_base:input},direct_route_summary_sha256:summaryHash,quote_payload_sha256:payloadHash,quote_payload_sha256_spec:QUOTE_PAYLOAD_SHA256_SPEC,input_base_bounds:{minimum:input,maximum:input},minimum_output_base:minimum,required_wallet_chains:required,event_signer_public_required:signer,step_count:String(summary.step_count),allowed_modes:allowed,server_signing:false,server_submission:false};
  quote.continuation_v3={version:CONTINUATION_V3_VERSION,enforcement:"server_enforced_quote_binding",selection_status:"unranked_candidate",automatic_selection_forbidden:true,caller_approved_boolean_is_not_human_proof:true,quote_id:quote.quote_id,quote_fingerprint:sha256Canonical(claim),quote_fingerprint_spec:QUOTE_FINGERPRINT_SPEC,quote_fingerprint_claim:claim,issued_at:issued,expires_at:expires,ttl_seconds:ttl,intent:structuredClone(quote.intent),direct_route_summary_sha256:summaryHash,quote_payload_sha256:payloadHash,quote_payload_sha256_spec:QUOTE_PAYLOAD_SHA256_SPEC,input_base_bounds:{minimum:input,maximum:input},minimum_output_base:minimum,required_wallet_chains:required,event_signer_public_required:signer,step_count:summary.step_count,recommended_mode:summary.step_count>1?"session":"one_shot_or_session",allowed_modes:allowed,session_header:{name:"X-AssetFare-Session-Token",required_for:"session",caller_generated:true,minimum_entropy_bits:256,server_returns_raw_value:false},idempotency:{required:true,field:"idempotency_key",pattern:"^[A-Za-z0-9._:-]{8,128}$",scope:"quote_and_selected_mode"},approval_v3_required_fields:[...APPROVAL_V3_KEYS],legacy_handoff_enforcement:"legacy_advisory",server_signing:false,server_submission:false};
  return quote;
}

export function approvalFor(quote,mode,key=`test.${mode}.0001`,changes={}) {
  const continuation=quote.continuation_v3;
  return {version:"assetfare-quote-bound-approval-v3",quote_id:continuation.quote_id,quote_fingerprint:continuation.quote_fingerprint,selection_status:"selected",selected_mode:mode,maximum_input_base:continuation.input_base_bounds.maximum,minimum_output_base:continuation.minimum_output_base,direct_route_summary_sha256:continuation.direct_route_summary_sha256,idempotency_key:key,...changes};
}

export function sessionBindingFor(approval=null) {
  return approval?{version:"assetfare-quote-bound-session-constraints-v1",quote_id:approval.quote_id,quote_fingerprint:approval.quote_fingerprint,selected_mode:"session",whole_session_path_and_bounds_enforced:true,server_signing:false,server_submission:false}:{version:"legacy_advisory",whole_session_path_and_bounds_enforced:false,server_signing:false,server_submission:false};
}
