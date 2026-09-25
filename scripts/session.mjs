#!/usr/bin/env node
/** Resume and advance a caller-owned AssetFare session. Never signs or submits. */

import { isMain } from "../src/is-main.js";
import { parseV2Session } from "../src/server.js";
import { readSessionCapability, requestJson, validatedBase } from "./plan.mjs";

const OPERATIONS = new Set(["get", "observe-source", "observe-output", "refresh"]);
const IDEMPOTENCY = /^[A-Za-z0-9._:-]{8,128}$/;
const HASH = /^[A-Za-z0-9:_-]{16,128}$/;

function usage() {
  return `Usage:
  assetfare-session --operation get \\
    --capability-file ./session-capability.json

  assetfare-session --operation observe-source \\
    --capability-file ./session-capability.json \\
    --idempotency-key source-0001 \\
    --transaction-hash <CALLER_SUBMITTED_HASH>

Operations: get | observe-source | observe-output | refresh

The mode-0600 capability file is created and updated by assetfare-plan and must
contain the session ID. This command sends the bearer token only in the
X-AssetFare-Session-Token header, never prints it, accepts only already-submitted
transaction hashes, validates the returned session, and never signs or submits.
`;
}

function parseArgs(argv) {
  const out = { transaction_hashes: [] };
  const valueKeys = new Set(["operation", "capability-file", "session-id", "idempotency-key", "transaction-hash", "api-base"]);
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
  return out;
}

async function runSession(argv, { fetchImpl = fetch, stdout = process.stdout } = {}) {
  const args = parseArgs(argv);
  if (args.help) { stdout.write(usage()); return { help: true }; }
  const capability = readSessionCapability(args.capability_file);
  const sessionId = args.session_id || capability.session_id;
  if (!sessionId || (args.session_id && capability.session_id && args.session_id !== capability.session_id)) throw new Error("assetfare_session_id_mismatch_or_missing");
  const apiBase = validatedBase(args.api_base || process.env.ASSETFARE_API_BASE_URL || "https://api.assetfare.dev");
  const root = `${apiBase}/v2/session/${sessionId}`;
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
  const session = parseV2Session(await requestJson(fetchImpl, url, options), null, capability.session_token);
  if (session.session_id !== sessionId) throw new Error("assetfare_session_response_id_mismatch");
  const result = { status: "pass", operation: args.operation, session, session_capability_path: capability.path, raw_session_token_exposed: false, transaction_signed: false, transaction_submitted: false, server_signing: false, server_submission: false };
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (isMain(import.meta.url)) runSession(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${JSON.stringify({ status: "fail", error: error?.message || "assetfare_session_failed", next_action: String(error?.message || "").includes("id_mismatch_or_missing") ? "rerun assetfare-plan with the same capability file before quote expiry, or supply the recorded session ID" : "inspect the session state and retry only the same logical operation", server_signing: false, server_submission: false })}\n`);
  process.exitCode = 1;
});

export { parseArgs, runSession, usage };
