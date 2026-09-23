#!/usr/bin/env node

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const MANIFEST_URL = "https://api.assetfare.dev/.well-known/assetfare-manifest.json";
const BUNDLE_URL = "https://api.assetfare.dev/.well-known/assetfare-safety.json";
const MANIFEST_SCHEMA = "https://assetfare.dev/.well-known/assetfare-manifest-v1";
const BUNDLE_SCHEMA = "https://assetfare.dev/.well-known/assetfare-safety-bundle-v1";
const CANONICALIZATION = "UTF-8 JSON with lexicographically sorted keys and compact separators";
const PINNED_KEY_ID = "assetfare-8b85e25475df3caf";
const PINNED_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA11pNC8NZXpVrCffmUe6/jtoM9RyrpU5miBPkRJqY9Vw=
-----END PUBLIC KEY-----
`;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024;
const MAX_RPC_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;

const RPC_PROVIDERS = Object.freeze({
  arbitrum: Object.freeze({
    chainId: 42161,
    urls: Object.freeze(["https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org"]),
    contractNames: Object.freeze(["cctp", "destination", "swap"]),
  }),
  base: Object.freeze({
    chainId: 8453,
    urls: Object.freeze(["https://mainnet.base.org", "https://base.drpc.org"]),
    contractNames: Object.freeze(["cctp", "destination", "swap"]),
  }),
  optimism: Object.freeze({
    chainId: 10,
    urls: Object.freeze(["https://mainnet.optimism.io", "https://optimism.drpc.org"]),
    contractNames: Object.freeze(["source_only_cctp"]),
  }),
  polygon: Object.freeze({
    chainId: 137,
    urls: Object.freeze(["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"]),
    contractNames: Object.freeze(["source_only_cctp"]),
  }),
  robinhood: Object.freeze({
    chainId: 4663,
    urls: Object.freeze(["https://rpc.mainnet.chain.robinhood.com", "https://robinhood-rpc.publicnode.com"]),
    contractNames: Object.freeze(["swap", "usdg_oft"]),
  }),
});

const MANIFEST_KEYS = ["endpoints", "execution", "issued_at", "limits", "mainnet_evidence", "release_commit", "safety_bundle", "schema", "service", "signature", "valid_until", "verification"];
const SIGNATURE_KEYS = ["algorithm", "canonicalization", "key_id", "public_key_url", "value"];
const MANIFEST_BUNDLE_KEYS = ["canonicalization", "schema", "sha256", "url"];
const BUNDLE_KEYS = ["bundle_version", "claims", "evidence", "known_limitations", "operational_disclosures", "release", "schema", "service", "verifier_rules"];
const RELEASE_KEYS = ["bundle_url", "canonicalization", "commit", "commit_url", "repository_url"];
const CLAIM_KEYS = ["administration_policy", "amount_policy", "fee_policy", "noncustody_policy", "scope"];
const SCOPE_KEYS = ["chains", "evm_deployments", "unique_solidity_sources"];
const FEE_KEYS = ["assetfare_service_fee_bps", "formula", "maximum_stable_base", "provider_and_network_fees_additional", "zero_fee_routes_allowed"];
const AMOUNT_KEYS = ["maximum_usd", "minimum_usd"];
const NONCUSTODY_KEYS = ["accepts_private_keys", "caller_verifies_signs_submits", "server_signing", "server_submission"];
const ADMIN_KEYS = ["arbitrary_call", "owner_role", "rescue_function", "upgradeability"];
const EVIDENCE_KEYS = ["build", "deployments", "public_urls", "sources"];
const SOURCE_KEYS = ["artifact_path", "artifact_sha256", "artifact_url", "contract", "path", "sha256", "source_url"];
const BUILD_KEYS = ["build_script_paths", "compiler", "compiler_version", "evm_version", "language", "metadata_bytecode_hash", "optimizer", "package_lock_path", "package_lock_sha256"];
const OPTIMIZER_KEYS = ["enabled", "runs"];
const DEPLOYMENT_KEYS = ["address", "block_hash", "block_number", "chain", "chain_id", "config_path", "config_sha256", "configuration", "explorer_transaction_url", "id", "kind", "runtime_code", "runtime_code_keccak256", "runtime_code_sha256", "source_contract", "transaction_hash"];
const PUBLIC_URL_KEYS = ["incidents", "manifest", "onchain_evidence", "reproducible_invariants", "security_reviews", "source_repository", "source_tree", "status", "uptime", "verifier"];
const VERIFIER_RULE_KEYS = ["artifact_sha256", "bundle_sha256", "config_sha256", "deployment_receipt", "runtime_code", "source_sha256"];
const OPERATIONAL_KEYS = ["last_updated_at", "public_incident_count_claimed", "public_incident_log_url", "status_url", "third_party_uptime_monitor_url", "uptime_percentage_claimed", "uptime_slo_published"];
const SUBJECTIVE_KEYS = new Set(["audit_passed", "audited", "risk_score", "safe", "safety_rating", "secure", "trust_score", "verdict"]);
const DEPLOYMENTS = Object.freeze({
  "arbitrum:cctp": Object.freeze({ chain: "arbitrum", kind: "cctp", source: "AssetFareDirectCctpExecutorV2", configuration: Object.freeze(["fee_recipient", "source_domain", "token_messenger", "usdc"]) }),
  "arbitrum:destination": Object.freeze({ chain: "arbitrum", kind: "destination", source: "RouteAgentDestinationExecutorV3", configuration: Object.freeze(["fee_recipient", "router", "usdc", "weth"]) }),
  "arbitrum:swap": Object.freeze({ chain: "arbitrum", kind: "swap", source: "AssetFareDirectSwapExecutorV2", configuration: Object.freeze(["fee_recipient", "router", "stable", "weth"]) }),
  "base:cctp": Object.freeze({ chain: "base", kind: "cctp", source: "AssetFareDirectCctpExecutorV2", configuration: Object.freeze(["fee_recipient", "source_domain", "token_messenger", "usdc"]) }),
  "base:destination": Object.freeze({ chain: "base", kind: "destination", source: "RouteAgentDestinationExecutorV3", configuration: Object.freeze(["fee_recipient", "router", "usdc", "weth"]) }),
  "base:swap": Object.freeze({ chain: "base", kind: "swap", source: "AssetFareDirectSwapExecutorV2", configuration: Object.freeze(["fee_recipient", "router", "stable", "weth"]) }),
  "optimism:source_only_cctp": Object.freeze({ chain: "optimism", kind: "source_only_cctp", source: "AssetFareSourceOnlyCctpExecutorV2", configuration: Object.freeze(["fee_recipient", "source_domain", "token_messenger", "usdc"]) }),
  "polygon:source_only_cctp": Object.freeze({ chain: "polygon", kind: "source_only_cctp", source: "AssetFareSourceOnlyCctpExecutorV2", configuration: Object.freeze(["fee_recipient", "source_domain", "token_messenger", "usdc"]) }),
  "robinhood:swap": Object.freeze({ chain: "robinhood", kind: "swap", source: "AssetFareDirectSwapExecutorV2", configuration: Object.freeze(["fee_recipient", "router", "stable", "weth"]) }),
  "robinhood:usdg_oft": Object.freeze({ chain: "robinhood", kind: "usdg_oft", source: "AssetFareDirectUsdgOftExecutorV2", configuration: Object.freeze(["fee_recipient", "oft", "solana_peer", "usdg"]) }),
});

function fail(message) {
  throw new Error(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, expected, label) {
  if (!isObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} has unexpected or missing keys`);
  }
}

function expectString(value, label, pattern) {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) fail(`${label} is invalid`);
}

function canonical(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite JSON number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!isObject(value)) fail("unsupported JSON value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const KECCAK_ROUND_CONSTANTS = Object.freeze([
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]);
const KECCAK_ROTATIONS = Object.freeze([
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
]);
const UINT64_MASK = (1n << 64n) - 1n;

function rotateLeft64(value, count) {
  if (count === 0) return value & UINT64_MASK;
  const shift = BigInt(count);
  return ((value << shift) | (value >> (64n - shift))) & UINT64_MASK;
}

function keccakPermutation(state) {
  for (const roundConstant of KECCAK_ROUND_CONSTANTS) {
    const columns = new Array(5);
    for (let x = 0; x < 5; x += 1) columns[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
    const deltas = columns.map((_, x) => columns[(x + 4) % 5] ^ rotateLeft64(columns[(x + 1) % 5], 1));
    for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) state[x + 5 * y] = (state[x + 5 * y] ^ deltas[x]) & UINT64_MASK;
    const moved = new Array(25).fill(0n);
    for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) moved[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLeft64(state[x + 5 * y], KECCAK_ROTATIONS[x + 5 * y]);
    for (let y = 0; y < 5; y += 1) for (let x = 0; x < 5; x += 1) state[x + 5 * y] = moved[x + 5 * y] ^ ((~moved[((x + 1) % 5) + 5 * y]) & moved[((x + 2) % 5) + 5 * y]);
    state[0] = (state[0] ^ roundConstant) & UINT64_MASK;
  }
}

function keccak256Hex(bytes) {
  const rate = 136;
  const input = Buffer.from(bytes);
  const paddedLength = Math.ceil((input.length + 1) / rate) * rate;
  const padded = Buffer.alloc(paddedLength);
  input.copy(padded);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const state = new Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let lane = 0; lane < rate / 8; lane += 1) state[lane] ^= padded.readBigUInt64LE(offset + lane * 8);
    keccakPermutation(state);
  }
  const output = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane += 1) output.writeBigUInt64LE(state[lane] & UINT64_MASK, lane * 8);
  return output.toString("hex");
}

function parseCanonicalJson(bytes, label) {
  let value;
  const text = Buffer.from(bytes).toString("utf8");
  if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) fail(`${label} is not valid UTF-8`);
  try { value = JSON.parse(text); } catch { fail(`${label} is not valid JSON`); }
  if (text !== canonical(value)) fail(`${label} is not canonical JSON`);
  return value;
}

function assertNoSubjectiveClaims(value, label = "bundle", seen = { nodes: 0 }) {
  seen.nodes += 1;
  if (seen.nodes > 10_000) fail(`${label} is too complex`);
  if (Array.isArray(value)) {
    for (const item of value) assertNoSubjectiveClaims(item, label, seen);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SUBJECTIVE_KEYS.has(key.toLowerCase())) fail(`${label} contains forbidden subjective claim ${key}`);
    assertNoSubjectiveClaims(child, label, seen);
  }
}

function validateTimestamp(value, label) {
  expectString(value, label, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(`${label} must be an ISO-8601 UTC timestamp`);
  return milliseconds;
}

function validateManifest(manifest, publicKeyPem, expectedKeyId, now = Date.now()) {
  exactKeys(manifest, MANIFEST_KEYS, "manifest");
  if (manifest.schema !== MANIFEST_SCHEMA || manifest.service !== "AssetFare") fail("manifest identity is invalid");
  expectString(manifest.release_commit, "manifest.release_commit", /^[0-9a-f]{40}$/);
  const issued = validateTimestamp(manifest.issued_at, "manifest.issued_at");
  const validUntil = validateTimestamp(manifest.valid_until, "manifest.valid_until");
  if (issued >= validUntil || validUntil <= now) fail("manifest is expired or has an invalid validity window");

  exactKeys(manifest.signature, SIGNATURE_KEYS, "manifest.signature");
  const signature = manifest.signature;
  if (signature.algorithm !== "Ed25519" || signature.key_id !== expectedKeyId) fail("manifest signature algorithm or pinned key id is invalid");
  if (signature.canonicalization !== "UTF-8 JSON with lexicographically sorted keys and compact separators; omit signature") fail("manifest signature canonicalization is invalid");
  if (signature.public_key_url !== "https://assetfare.dev/.well-known/assetfare-manifest.pub") fail("manifest public key URL is invalid");
  expectString(signature.value, "manifest.signature.value", /^[A-Za-z0-9_-]{86}$/);
  const unsigned = structuredClone(manifest);
  delete unsigned.signature;
  let key;
  try { key = createPublicKey(publicKeyPem); } catch { fail("public key is invalid"); }
  const ok = verifySignature(null, Buffer.from(canonical(unsigned)), key, Buffer.from(signature.value, "base64url"));
  if (!ok) fail("manifest Ed25519 signature verification failed");

  exactKeys(manifest.safety_bundle, MANIFEST_BUNDLE_KEYS, "manifest.safety_bundle");
  if (manifest.safety_bundle.schema !== BUNDLE_SCHEMA || manifest.safety_bundle.url !== BUNDLE_URL || manifest.safety_bundle.canonicalization !== CANONICALIZATION) fail("manifest safety bundle binding is invalid");
  expectString(manifest.safety_bundle.sha256, "manifest.safety_bundle.sha256", /^[0-9a-f]{64}$/);

  const multichain = manifest.execution?.multichain_v2;
  if (!isObject(multichain) || multichain.server_signing !== false || multichain.server_submission !== false) fail("manifest does not assert server signing and submission are disabled");
  const fee = multichain.fee_policy;
  if (!isObject(fee) || fee.exact_bps !== 1 || fee.minimum_bps !== 1 || fee.maximum_bps !== 1 || fee.fee_maximum_stable_base !== null || fee.zero_fee_routes_allowed !== false || fee.policy !== "exact_one_bps_no_maximum") fail("manifest exact 1bp/no-maximum fee policy is invalid");
  return { issued, validUntil };
}

function validateBundle(bundle, manifest) {
  exactKeys(bundle, BUNDLE_KEYS, "bundle");
  assertNoSubjectiveClaims(bundle);
  if (bundle.schema !== BUNDLE_SCHEMA || bundle.bundle_version !== 1 || bundle.service !== "AssetFare") fail("bundle identity or version is invalid");
  if (sha256Hex(Buffer.from(canonical(bundle))) !== manifest.safety_bundle.sha256) fail("signed safety bundle SHA-256 mismatch");

  exactKeys(bundle.release, RELEASE_KEYS, "bundle.release");
  expectString(bundle.release.commit, "bundle.release.commit", /^[0-9a-f]{40}$/);
  if (bundle.release.repository_url !== "https://github.com/odaiin/assetfare" || bundle.release.commit_url !== `https://github.com/odaiin/assetfare/tree/${bundle.release.commit}` || bundle.release.bundle_url !== BUNDLE_URL || bundle.release.canonicalization !== CANONICALIZATION) fail("bundle release provenance is invalid");
  if (manifest.release_commit !== bundle.release.commit) fail("bundle release commit does not match the signed manifest");

  exactKeys(bundle.claims, CLAIM_KEYS, "bundle.claims");
  exactKeys(bundle.claims.scope, SCOPE_KEYS, "bundle.claims.scope");
  if (bundle.claims.scope.unique_solidity_sources !== 5 || bundle.claims.scope.evm_deployments !== Object.keys(DEPLOYMENTS).length || !Array.isArray(bundle.claims.scope.chains) || canonical(bundle.claims.scope.chains) !== canonical(Object.keys(RPC_PROVIDERS))) fail("bundle deployment scope is invalid");
  exactKeys(bundle.claims.fee_policy, FEE_KEYS, "bundle.claims.fee_policy");
  const fee = bundle.claims.fee_policy;
  if (fee.assetfare_service_fee_bps !== 1 || fee.formula !== "floor(fee_basis_stable_base * 1 / 10000)" || fee.maximum_stable_base !== null || fee.zero_fee_routes_allowed !== false || fee.provider_and_network_fees_additional !== true) fail("bundle exact 1bp/no-maximum fee policy is invalid");
  exactKeys(bundle.claims.amount_policy, AMOUNT_KEYS, "bundle.claims.amount_policy");
  if (bundle.claims.amount_policy.minimum_usd !== 1 || bundle.claims.amount_policy.maximum_usd !== null) fail("bundle amount policy is invalid");
  exactKeys(bundle.claims.noncustody_policy, NONCUSTODY_KEYS, "bundle.claims.noncustody_policy");
  const noncustody = bundle.claims.noncustody_policy;
  if (noncustody.accepts_private_keys !== false || noncustody.server_signing !== false || noncustody.server_submission !== false || noncustody.caller_verifies_signs_submits !== true) fail("bundle noncustody policy is invalid");
  exactKeys(bundle.claims.administration_policy, ADMIN_KEYS, "bundle.claims.administration_policy");
  const administration = bundle.claims.administration_policy;
  if (administration.owner_role !== false && administration.owner_role !== null) fail("bundle owner role policy is invalid");
  if (administration.upgradeability !== false || administration.rescue_function !== false || administration.arbitrary_call !== false) fail("bundle administration policy is invalid");

  exactKeys(bundle.evidence, EVIDENCE_KEYS, "bundle.evidence");
  if (!Array.isArray(bundle.evidence.sources) || bundle.evidence.sources.length !== 5) fail("bundle must include all five Solidity sources");
  const sourceContracts = new Set();
  for (const [index, source] of bundle.evidence.sources.entries()) {
    exactKeys(source, SOURCE_KEYS, `bundle.evidence.sources[${index}]`);
    expectString(source.contract, "source contract", /^[A-Za-z][A-Za-z0-9]{0,127}$/);
    if (sourceContracts.has(source.contract)) fail(`duplicate source evidence ${source.contract}`);
    sourceContracts.add(source.contract);
    for (const key of ["path", "artifact_path"]) expectString(source[key], `source ${key}`, /^(?!\/)(?!.*\.\.)(?!.*\\).+$/);
    for (const key of ["sha256", "artifact_sha256"]) expectString(source[key], `source ${key}`, /^[0-9a-f]{64}$/);
    for (const key of ["source_url", "artifact_url"]) {
      expectString(source[key], `source ${key}`);
      if (!source[key].startsWith(`https://github.com/odaiin/assetfare/blob/${bundle.release.commit}/`)) fail(`source ${key} is not pinned to the release commit`);
    }
  }

  exactKeys(bundle.evidence.build, BUILD_KEYS, "bundle.evidence.build");
  const build = bundle.evidence.build;
  if (build.language !== "Solidity" || build.compiler !== "solc-js" || build.evm_version !== "compiler_default" || build.metadata_bytecode_hash !== "ipfs") fail("bundle build identity is invalid");
  expectString(build.compiler_version, "build compiler_version", /^0\.[0-9]+\.[0-9]+(?:\+[A-Za-z0-9.-]+)?$/);
  exactKeys(build.optimizer, OPTIMIZER_KEYS, "bundle.evidence.build.optimizer");
  if (build.optimizer.enabled !== true || !Number.isSafeInteger(build.optimizer.runs) || build.optimizer.runs < 1) fail("bundle optimizer settings are invalid");
  expectString(build.package_lock_path, "build package_lock_path", /^(?!\/)(?!.*\.\.)(?!.*\\).+$/);
  expectString(build.package_lock_sha256, "build package_lock_sha256", /^[0-9a-f]{64}$/);
  if (!Array.isArray(build.build_script_paths) || build.build_script_paths.length === 0 || build.build_script_paths.some((path) => typeof path !== "string" || !/^(?!\/)(?!.*\.\.)(?!.*\\).+$/.test(path))) fail("bundle build script paths are invalid");
  if (!build.build_script_paths.includes("gasless_validator/agent_safety_invariants_preflight.mjs")) fail("bundle omits the reproducible invariant script");

  if (!Array.isArray(bundle.evidence.deployments) || bundle.evidence.deployments.length !== Object.keys(DEPLOYMENTS).length) fail("bundle must include every deployment exactly once");
  if (canonical(bundle.evidence.deployments.map(({ id }) => id)) !== canonical(Object.keys(DEPLOYMENTS))) fail("bundle deployments must use the complete sorted id set");
  const chains = new Map(Object.entries(RPC_PROVIDERS).map(([name, pin]) => [name, { name, chain_id: pin.chainId, contracts: new Map() }]));
  for (const [index, deployment] of bundle.evidence.deployments.entries()) {
    exactKeys(deployment, DEPLOYMENT_KEYS, `bundle.evidence.deployments[${index}]`);
    const expected = DEPLOYMENTS[deployment.id];
    if (!expected || deployment.chain !== expected.chain || deployment.kind !== expected.kind || deployment.source_contract !== expected.source) fail(`bundle deployment ${deployment.id} identity is invalid`);
    const pin = RPC_PROVIDERS[deployment.chain];
    if (deployment.chain_id !== pin.chainId) fail(`bundle deployment ${deployment.id} chain id is invalid`);
    if (!sourceContracts.has(deployment.source_contract)) fail(`bundle deployment ${deployment.id} lacks source evidence`);
    expectString(deployment.address, "deployment address", /^0x[0-9A-Fa-f]{40}$/);
    expectString(deployment.transaction_hash, "deployment transaction hash", /^0x[0-9a-f]{64}$/);
    if (typeof deployment.block_number !== "string" || !/^[1-9][0-9]*$/.test(deployment.block_number)) fail(`bundle deployment ${deployment.id} block number is invalid`);
    expectString(deployment.block_hash, "deployment block hash", /^0x[0-9a-f]{64}$/);
    expectString(deployment.runtime_code, "deployment runtime code", /^0x(?:[0-9a-f]{2})+$/);
    if (deployment.runtime_code.length > 49_154) fail(`bundle deployment ${deployment.id} runtime code exceeds the EVM limit`);
    expectString(deployment.runtime_code_sha256, "deployment runtime code SHA-256", /^[0-9a-f]{64}$/);
    expectString(deployment.runtime_code_keccak256, "deployment runtime code Keccak-256", /^0x[0-9a-f]{64}$/);
    const rawCode = Buffer.from(deployment.runtime_code.slice(2), "hex");
    if (sha256Hex(rawCode) !== deployment.runtime_code_sha256 || `0x${keccak256Hex(rawCode)}` !== deployment.runtime_code_keccak256) fail(`bundle runtime code hashes mismatch for ${deployment.id}`);
    expectString(deployment.config_path, "deployment config_path", /^(?!\/)(?!.*\.\.)(?!.*\\).+$/);
    expectString(deployment.config_sha256, "deployment config_sha256", /^[0-9a-f]{64}$/);
    exactKeys(deployment.configuration, expected.configuration, `bundle deployment ${deployment.id} configuration`);
    for (const [key, value] of Object.entries(deployment.configuration)) {
      if (key === "source_domain") {
        if (!Number.isSafeInteger(value) || value < 0) fail(`bundle deployment ${deployment.id} source domain is invalid`);
      } else if (key === "solana_peer") expectString(value, `bundle deployment ${deployment.id} solana_peer`, /^0x[0-9a-f]{64}$/);
      else expectString(value, `bundle deployment ${deployment.id} ${key}`, /^0x[0-9A-Fa-f]{40}$/);
    }
    expectString(deployment.explorer_transaction_url, "deployment explorer URL", /^https:\/\//);
    const contractName = deployment.id.split(":", 2)[1];
    chains.get(deployment.chain).contracts.set(contractName, { ...deployment, name: contractName });
  }
  for (const [name, chain] of chains) {
    const expectedNames = RPC_PROVIDERS[name].contractNames;
    if (chain.contracts.size !== expectedNames.length || expectedNames.some((contract) => !chain.contracts.has(contract))) fail(`bundle chain ${name} has incomplete contract evidence`);
  }

  exactKeys(bundle.evidence.public_urls, PUBLIC_URL_KEYS, "bundle.evidence.public_urls");
  for (const [key, value] of Object.entries(bundle.evidence.public_urls)) {
    if (value === null && ["incidents", "uptime"].includes(key)) continue;
    expectString(value, `bundle public URL ${key}`, /^https:\/\//);
  }
  if (bundle.evidence.public_urls.manifest !== MANIFEST_URL || bundle.evidence.public_urls.source_repository !== bundle.release.repository_url || bundle.evidence.public_urls.verifier !== "https://github.com/odaiin/assetfare-mcp/blob/main/scripts/assetfare-verify.mjs") fail("bundle required public URLs are invalid");

  exactKeys(bundle.verifier_rules, VERIFIER_RULE_KEYS, "bundle.verifier_rules");
  for (const [key, value] of Object.entries(bundle.verifier_rules)) expectString(value, `bundle verifier rule ${key}`, /^.{8,500}$/);
  if (!Array.isArray(bundle.known_limitations) || bundle.known_limitations.length === 0 || bundle.known_limitations.some((item) => typeof item !== "string" || item.length < 8 || item.length > 500)) fail("bundle known limitations must be non-empty bounded strings");
  exactKeys(bundle.operational_disclosures, OPERATIONAL_KEYS, "bundle.operational_disclosures");
  const operations = bundle.operational_disclosures;
  if (operations.status_url !== bundle.evidence.public_urls.status) fail("bundle operational status URL is inconsistent");
  for (const key of ["third_party_uptime_monitor_url", "public_incident_log_url"]) if (operations[key] !== null) expectString(operations[key], `bundle operational ${key}`, /^https:\/\//);
  if (operations.uptime_percentage_claimed !== null && (typeof operations.uptime_percentage_claimed !== "number" || operations.uptime_percentage_claimed < 0 || operations.uptime_percentage_claimed > 100)) fail("bundle uptime percentage claim is invalid");
  if (operations.uptime_slo_published !== null && typeof operations.uptime_slo_published !== "boolean") fail("bundle uptime SLO disclosure is invalid");
  if (operations.public_incident_count_claimed !== null && (!Number.isSafeInteger(operations.public_incident_count_claimed) || operations.public_incident_count_claimed < 0)) fail("bundle incident count claim is invalid");
  validateTimestamp(operations.last_updated_at, "bundle.operational_disclosures.last_updated_at");
  return chains;
}

async function readBoundedBody(response, maximumBytes, label) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes)) fail(`${label} exceeds size limit`);
  const chunks = [];
  let size = 0;
  if (!response.body) fail(`${label} has no response body`);
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximumBytes) {
      try { await response.body.cancel(); } catch { /* best effort */ }
      fail(`${label} exceeds size limit`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function requireJsonMime(response, label) {
  const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") fail(`${label} has invalid MIME type`);
}

async function fetchCanonicalJson(url, maximumBytes, label, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { accept: "application/json" } });
  } catch (error) {
    fail(`${label} fetch failed: ${error instanceof Error ? error.message : "network error"}`);
  }
  if (response.status >= 300 && response.status < 400) fail(`${label} redirect is forbidden`);
  if (!response.ok) fail(`${label} fetch failed with HTTP ${response.status}`);
  requireJsonMime(response, label);
  return parseCanonicalJson(await readBoundedBody(response, maximumBytes, label), label);
}

async function rpcRead(providerUrl, chain, fetchImpl = fetch) {
  const requests = [
    { jsonrpc: "2.0", id: "chain-id", method: "eth_chainId", params: [] },
    ...[...chain.contracts.values()].flatMap((contract) => [
      { jsonrpc: "2.0", id: `code:${contract.name}`, method: "eth_getCode", params: [contract.address, "latest"] },
      { jsonrpc: "2.0", id: `receipt:${contract.name}`, method: "eth_getTransactionReceipt", params: [contract.transaction_hash] },
    ]),
  ];
  const hostname = new URL(providerUrl).hostname;
  const rows = await Promise.all(requests.map(async (request) => {
    let response;
    try {
      response = await fetchImpl(providerUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify(request),
      });
    } catch (error) {
      fail(`RPC ${hostname} failed: ${error instanceof Error ? error.message : "network error"}`);
    }
    if (response.status >= 300 && response.status < 400) fail(`RPC ${hostname} redirect is forbidden`);
    if (!response.ok) fail(`RPC ${hostname} failed with HTTP ${response.status}`);
    requireJsonMime(response, `RPC ${hostname}`);
    try { return JSON.parse((await readBoundedBody(response, MAX_RPC_BYTES, "RPC response")).toString("utf8")); } catch { fail(`RPC ${hostname} returned invalid JSON`); }
  }));
  const byId = new Map();
  for (const row of rows) {
    if (!isObject(row) || row.jsonrpc !== "2.0" || typeof row.id !== "string" || Object.keys(row).some((key) => !["id", "jsonrpc", "result"].includes(key)) || !("result" in row) || byId.has(row.id)) fail(`RPC ${hostname} returned an invalid response`);
    byId.set(row.id, row.result);
  }
  const expectedChainId = `0x${chain.chain_id.toString(16)}`;
  if (byId.size !== requests.length) fail(`RPC ${hostname} returned incomplete evidence`);
  if (byId.get("chain-id") !== expectedChainId) fail(`RPC ${hostname} chain id mismatch`);
  const codes = new Map();
  const receipts = new Map();
  for (const contract of chain.contracts.values()) {
    const code = byId.get(`code:${contract.name}`);
    if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) fail(`RPC ${hostname} returned invalid or empty code for ${chain.name}:${contract.name}`);
    const normalized = code.toLowerCase();
    if (normalized !== contract.runtime_code.toLowerCase()) fail(`RPC ${hostname} raw code mismatch for ${chain.name}:${contract.name}`);
    if (sha256Hex(Buffer.from(normalized.slice(2), "hex")) !== contract.runtime_code_sha256) fail(`RPC ${hostname} code SHA-256 mismatch for ${chain.name}:${contract.name}`);
    codes.set(contract.name, normalized);
    const receipt = byId.get(`receipt:${contract.name}`);
    if (!isObject(receipt) || typeof receipt.transactionHash !== "string" || typeof receipt.blockHash !== "string" || typeof receipt.blockNumber !== "string" || typeof receipt.contractAddress !== "string" || receipt.transactionHash.toLowerCase() !== contract.transaction_hash || receipt.blockHash.toLowerCase() !== contract.block_hash || receipt.contractAddress.toLowerCase() !== contract.address.toLowerCase() || receipt.status !== "0x1" || receipt.to !== null) fail(`RPC ${hostname} deployment receipt mismatch for ${chain.name}:${contract.name}`);
    try {
      if (BigInt(receipt.blockNumber) !== BigInt(contract.block_number)) fail(`RPC ${hostname} deployment block mismatch for ${chain.name}:${contract.name}`);
    } catch { fail(`RPC ${hostname} deployment block is invalid for ${chain.name}:${contract.name}`); }
    receipts.set(contract.name, canonical({ blockHash: receipt.blockHash.toLowerCase(), blockNumber: receipt.blockNumber.toLowerCase(), contractAddress: receipt.contractAddress.toLowerCase(), status: receipt.status, to: receipt.to, transactionHash: receipt.transactionHash.toLowerCase() }));
  }
  return { host: hostname, chainId: chain.chain_id, codes, receipts };
}

async function verifyRpcQuorum(chains, fetchImpl = fetch) {
  const output = [];
  for (const name of Object.keys(RPC_PROVIDERS)) {
    const chain = chains.get(name);
    const pin = RPC_PROVIDERS[name];
    if (new Set(pin.urls.map((url) => new URL(url).hostname)).size !== 2) fail(`RPC pins for ${name} are not independent hosts`);
    const observations = await Promise.all(pin.urls.map((url) => rpcRead(url, chain, fetchImpl)));
    for (const contractName of pin.contractNames) {
      if (observations[0].codes.get(contractName) !== observations[1].codes.get(contractName)) fail(`RPC providers disagree on ${name}:${contractName}`);
      if (observations[0].receipts.get(contractName) !== observations[1].receipts.get(contractName)) fail(`RPC providers disagree on deployment receipt ${name}:${contractName}`);
    }
    output.push({ chain: name, chain_id: chain.chain_id, providers: observations.map(({ host }) => host), contracts_verified: pin.contractNames });
  }
  return output;
}

function parseArgs(argv) {
  const args = { mode: null, manifest: null, bundle: null, pubkey: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { args.help = true; continue; }
    if (arg === "--live" || arg === "--offline") {
      const mode = arg.slice(2);
      if (args.mode) fail("choose exactly one of --live or --offline");
      args.mode = mode;
      continue;
    }
    if (["--manifest", "--bundle", "--pubkey"].includes(arg)) {
      const key = arg.slice(2);
      if (args[key] !== null || !argv[index + 1] || argv[index + 1].startsWith("--")) fail(`${arg} requires exactly one path`);
      args[key] = argv[index + 1];
      index += 1;
      continue;
    }
    fail(`unknown argument: ${arg}`);
  }
  if (args.help) return args;
  if (!args.mode) fail("choose exactly one of --live or --offline");
  if (args.mode === "live" && [args.manifest, args.bundle, args.pubkey].some(Boolean)) fail("--live does not accept trust-material overrides");
  if (args.mode === "offline" && [args.manifest, args.bundle, args.pubkey].some((value) => !value)) fail("--offline requires --manifest, --bundle, and --pubkey");
  return args;
}

const USAGE = `Usage:
  assetfare-verify --live
  assetfare-verify --offline --manifest FILE --bundle FILE --pubkey FILE

Live mode uses an embedded AssetFare Ed25519 public key and key id, fetches only
the pinned manifest/bundle URLs, and performs read-only quorum checks against two
pinned public RPC providers per supported EVM chain. Offline mode performs no
network requests and treats the explicitly supplied public key as its trust root.`;

async function run(args, options = {}) {
  const now = options.now ?? Date.now();
  let manifest;
  let bundle;
  let publicKey;
  let expectedKeyId;
  if (args.mode === "live") {
    manifest = await fetchCanonicalJson(MANIFEST_URL, MAX_MANIFEST_BYTES, "manifest", options.fetchImpl);
    publicKey = PINNED_PUBLIC_KEY;
    expectedKeyId = PINNED_KEY_ID;
  } else {
    const [manifestBytes, bundleBytes, keyBytes] = await Promise.all([
      readFile(args.manifest), readFile(args.bundle), readFile(args.pubkey),
    ]);
    if (manifestBytes.length > MAX_MANIFEST_BYTES || bundleBytes.length > MAX_BUNDLE_BYTES || keyBytes.length > 4096) fail("offline fixture exceeds size limit");
    manifest = parseCanonicalJson(manifestBytes, "manifest");
    bundle = parseCanonicalJson(bundleBytes, "bundle");
    publicKey = keyBytes.toString("utf8");
    expectedKeyId = manifest.signature?.key_id;
  }
  const validity = validateManifest(manifest, publicKey, expectedKeyId, now);
  if (args.mode === "live") bundle = await fetchCanonicalJson(manifest.safety_bundle.url, MAX_BUNDLE_BYTES, "safety bundle", options.fetchImpl);
  const chains = validateBundle(bundle, manifest);
  const rpc = args.mode === "live" ? await verifyRpcQuorum(chains, options.fetchImpl) : [];
  return {
    status: args.mode === "live" ? "live_verified" : "offline_evidence_verified",
    mode: args.mode,
    manifest: { key_id: manifest.signature.key_id, release_commit: manifest.release_commit, valid_until: new Date(validity.validUntil).toISOString() },
    safety_bundle: { sha256: manifest.safety_bundle.sha256, chains_verified: [...chains.keys()], raw_runtime_code_hashes_verified: [...chains.values()].reduce((sum, chain) => sum + chain.contracts.size, 0) },
    rpc_quorum: { performed: args.mode === "live", chains: rpc },
    limitations: bundle.known_limitations,
    signing_or_submission_performed: false,
  };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) { process.stdout.write(`${USAGE}\n`); return; }
    process.stdout.write(`${JSON.stringify(await run(args), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "verification_failed", error: error instanceof Error ? error.message : String(error), signing_or_submission_performed: false })}\n`);
    process.exitCode = 1;
  }
}

export {
  BUNDLE_SCHEMA,
  BUNDLE_URL,
  CANONICALIZATION,
  MANIFEST_SCHEMA,
  MANIFEST_URL,
  PINNED_KEY_ID,
  PINNED_PUBLIC_KEY,
  RPC_PROVIDERS,
  canonical,
  fetchCanonicalJson,
  keccak256Hex,
  parseArgs,
  parseCanonicalJson,
  run,
  sha256Hex,
  validateBundle,
  validateManifest,
  verifyRpcQuorum,
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
