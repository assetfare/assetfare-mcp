#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { generateKeyPairSync, sign } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLE_SCHEMA,
  BUNDLE_URL,
  CANONICALIZATION,
  MANIFEST_SCHEMA,
  RPC_PROVIDERS,
  canonical,
  fetchCanonicalJson,
  keccak256Hex,
  run,
  sha256Hex,
  validateBundle,
  validateManifest,
  verifyPublicEvidence,
  verifyRpcQuorum,
} from "./assetfare-verify.mjs";

const { privateKey: PRIVATE_KEY, publicKey: publicKeyObject } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = publicKeyObject.export({ type: "spki", format: "pem" });
const RELEASE = "96cc132896cc132896cc132896cc132896cc1328";
const PUBLIC_EVIDENCE_COMMIT = "8fbc3a475406203525c752d1b628ad8ea3ca51d8";
const NOW = Date.parse("2026-09-23T00:00:00Z");
const ADDRESS = (number) => `0x${number.toString(16).padStart(40, "0")}`;
const HASH = (number) => `0x${number.toString(16).padStart(64, "0")}`;
const SHA = (text) => sha256Hex(Buffer.from(text));

const deployments = [
  ["arbitrum:cctp", "arbitrum", 42161, "cctp", "AssetFareDirectCctpExecutorV2", ["fee_recipient", "source_domain", "token_messenger", "usdc"]],
  ["arbitrum:destination", "arbitrum", 42161, "destination", "RouteAgentDestinationExecutorV3", ["fee_recipient", "router", "usdc", "weth"]],
  ["arbitrum:swap", "arbitrum", 42161, "swap", "AssetFareDirectSwapExecutorV2", ["fee_recipient", "router", "stable", "weth"]],
  ["base:cctp", "base", 8453, "cctp", "AssetFareDirectCctpExecutorV2", ["fee_recipient", "source_domain", "token_messenger", "usdc"]],
  ["base:destination", "base", 8453, "destination", "RouteAgentDestinationExecutorV3", ["fee_recipient", "router", "usdc", "weth"]],
  ["base:swap", "base", 8453, "swap", "AssetFareDirectSwapExecutorV2", ["fee_recipient", "router", "stable", "weth"]],
  ["optimism:source_only_cctp", "optimism", 10, "source_only_cctp", "AssetFareSourceOnlyCctpExecutorV2", ["fee_recipient", "source_domain", "token_messenger", "usdc"]],
  ["polygon:source_only_cctp", "polygon", 137, "source_only_cctp", "AssetFareSourceOnlyCctpExecutorV2", ["fee_recipient", "source_domain", "token_messenger", "usdc"]],
  ["robinhood:swap", "robinhood", 4663, "swap", "AssetFareDirectSwapExecutorV2", ["fee_recipient", "router", "stable", "weth"]],
  ["robinhood:usdg_oft", "robinhood", 4663, "usdg_oft", "AssetFareDirectUsdgOftExecutorV2", ["fee_recipient", "oft", "solana_peer", "usdg"]],
];

function fixtureBundle() {
  const sourceNames = [...new Set(deployments.map((row) => row[4]))].sort();
  return {
    bundle_version: 1,
    claims: {
      administration_policy: { arbitrary_call: false, owner_role: false, rescue_function: false, upgradeability: false },
      amount_policy: { maximum_usd: null, minimum_usd: 1 },
      fee_policy: { assetfare_service_fee_bps: 1, formula: "floor(fee_basis_stable_base * 1 / 10000)", maximum_stable_base: null, provider_and_network_fees_additional: true, zero_fee_routes_allowed: false },
      noncustody_policy: { accepts_private_keys: false, caller_verifies_signs_submits: true, server_signing: false, server_submission: false },
      scope: { chains: Object.keys(RPC_PROVIDERS), evm_deployments: 10, unique_solidity_sources: 5 },
    },
    evidence: {
      build: {
        build_script_paths: ["verification/core/agent_safety_invariants_preflight.mjs"],
        compiler: "solc-js",
        compiler_version: "0.8.30+commit.73712a01",
        evm_version: "compiler_default",
        language: "Solidity",
        metadata_bytecode_hash: "ipfs",
        optimizer: { enabled: true, runs: 200 },
        package_lock_path: "verification/core/package-lock.json",
        package_lock_sha256: SHA("lock"),
      },
      deployments: deployments.map(([id, chain, chainId, kind, sourceContract, configKeys], index) => {
        const runtimeCode = `0x6000${index.toString(16).padStart(2, "0")}`;
        const configuration = Object.fromEntries(configKeys.map((key, keyIndex) => [key, key === "source_domain" ? index : key === "solana_peer" ? HASH(index + keyIndex + 1) : ADDRESS(index * 10 + keyIndex + 1)]));
        return {
          address: ADDRESS(index + 1),
          block_hash: HASH(index + 100),
          block_number: String(index + 1),
          chain,
          chain_id: chainId,
          configuration,
          explorer_transaction_url: `https://example.com/${chain}/tx/${index}`,
          id,
          kind,
          runtime_code: runtimeCode,
          runtime_code_keccak256: `0x${keccak256Hex(Buffer.from(runtimeCode.slice(2), "hex"))}`,
          runtime_code_sha256: sha256Hex(Buffer.from(runtimeCode.slice(2), "hex")),
          source_contract: sourceContract,
          transaction_hash: HASH(index + 200),
        };
      }),
      public_urls: {
        incidents: null,
        manifest: "https://api.assetfare.dev/.well-known/assetfare-manifest.json",
        onchain_evidence: "https://assetfare.dev/evidence/",
        reproducible_invariants: `https://raw.githubusercontent.com/odaiin/assetfare-mcp/${PUBLIC_EVIDENCE_COMMIT}/verification/core/agent_safety_invariants_preflight.mjs`,
        security_reviews: "https://assetfare.dev/security-reviews/",
        source_repository: "https://github.com/odaiin/assetfare-mcp",
        source_tree: `https://github.com/odaiin/assetfare-mcp/tree/${PUBLIC_EVIDENCE_COMMIT}/verification/core`,
        status: "https://api.assetfare.dev/v2/status",
        uptime: null,
        verifier: `https://github.com/odaiin/assetfare-mcp/blob/${PUBLIC_EVIDENCE_COMMIT}/scripts/assetfare-verify.mjs`,
      },
      sources: sourceNames.map((contract) => ({
        artifact_path: `verification/core/artifacts/${contract}.json`,
        artifact_sha256: SHA(`artifact-${contract}`),
        artifact_url: `https://raw.githubusercontent.com/odaiin/assetfare-mcp/${PUBLIC_EVIDENCE_COMMIT}/verification/core/artifacts/${contract}.json`,
        contract,
        path: `verification/core/contracts/${contract}.sol`,
        sha256: SHA(`source-${contract}`),
        source_url: `https://raw.githubusercontent.com/odaiin/assetfare-mcp/${PUBLIC_EVIDENCE_COMMIT}/verification/core/contracts/${contract}.sol`,
      })),
    },
    known_limitations: ["This proves published bytecode identity and factual invariants, not the absence of unknown defects."],
    operational_disclosures: {
      last_updated_at: "2026-09-23T00:00:00Z",
      public_incident_count_claimed: null,
      public_incident_log_url: null,
      status_url: "https://api.assetfare.dev/v2/status",
      third_party_uptime_monitor_url: null,
      uptime_percentage_claimed: null,
      uptime_slo_published: null,
    },
    release: {
      bundle_url: BUNDLE_URL,
      canonicalization: CANONICALIZATION,
      commit: RELEASE,
      public_evidence_commit: PUBLIC_EVIDENCE_COMMIT,
      public_evidence_repository: "https://github.com/odaiin/assetfare-mcp",
      public_evidence_tree_url: `https://github.com/odaiin/assetfare-mcp/tree/${PUBLIC_EVIDENCE_COMMIT}/verification/core`,
    },
    schema: BUNDLE_SCHEMA,
    service: "AssetFare",
    verifier_rules: {
      artifact_sha256: "Hash every published artifact byte-for-byte.",
      bundle_sha256: "Hash the recursively canonicalized complete bundle.",
      deployment_receipt: "Check the transaction and canonical block receipt.",
      runtime_code: "Check raw bytes with two RPCs, SHA-256, and Keccak-256.",
      source_sha256: "Hash every published Solidity source byte-for-byte.",
    },
  };
}

function fixtureManifest(bundle) {
  const manifest = {
    endpoints: {},
    execution: { multichain_v2: { fee_policy: { exact_bps: 1, fee_maximum_stable_base: null, maximum_bps: 1, minimum_bps: 1, policy: "exact_one_bps_no_maximum", zero_fee_routes_allowed: false }, server_signing: false, server_submission: false } },
    issued_at: "2026-09-23T00:00:00Z",
    limits: {},
    mainnet_evidence: {},
    release_commit: RELEASE,
    safety_bundle: { canonicalization: CANONICALIZATION, schema: BUNDLE_SCHEMA, sha256: sha256Hex(Buffer.from(canonical(bundle))), url: BUNDLE_URL },
    schema: MANIFEST_SCHEMA,
    service: "AssetFare",
    valid_until: "2099-09-23T00:10:00Z",
    verification: {},
  };
  manifest.signature = {
    algorithm: "Ed25519",
    canonicalization: "UTF-8 JSON with lexicographically sorted keys and compact separators; omit signature",
    key_id: "assetfare-selftest",
    public_key_url: "https://assetfare.dev/.well-known/assetfare-manifest.pub",
    value: sign(null, Buffer.from(canonical(manifest)), PRIVATE_KEY).toString("base64url"),
  };
  return manifest;
}

function resign(manifest) {
  const copy = structuredClone(manifest);
  delete copy.signature;
  manifest.signature.value = sign(null, Buffer.from(canonical(copy)), PRIVATE_KEY).toString("base64url");
}

async function expectReject(fn, pattern) {
  await assert.rejects(fn, pattern);
}

const bundle = fixtureBundle();
const manifest = fixtureManifest(bundle);
validateManifest(manifest, PUBLIC_KEY, "assetfare-selftest", NOW);
const chains = validateBundle(bundle, manifest);
assert.equal(chains.size, 5);
assert.equal(keccak256Hex(Buffer.alloc(0)), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
assert.equal(keccak256Hex(Buffer.from("abc")), "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");

async function publicEvidenceFixture(url) {
  const source = bundle.evidence.sources.find((row) => row.source_url === url);
  if (source) return new Response(`source-${source.contract}`, { status: 200, headers: { "content-type": "text/plain" } });
  const artifact = bundle.evidence.sources.find((row) => row.artifact_url === url);
  if (artifact) return new Response(`artifact-${artifact.contract}`, { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/package-lock.json")) return new Response("lock", { status: 200, headers: { "content-type": "application/json" } });
  if (bundle.evidence.build.build_script_paths.some((path) => url.endsWith(`/${path}`))) return new Response("script", { status: 200, headers: { "content-type": "text/javascript" } });
  throw new Error(`unexpected public evidence URL ${url}`);
}
const publicEvidence = await verifyPublicEvidence(bundle, publicEvidenceFixture);
assert.equal(publicEvidence.hashed_files.length, 11);
assert.equal(publicEvidence.build_scripts.length, 1);
await expectReject(() => verifyPublicEvidence(bundle, async (url) => url.includes("/contracts/") ? new Response("mutated", { status: 200, headers: { "content-type": "text/plain" } }) : publicEvidenceFixture(url)), /SHA-256 mismatch/);

const fixtureDirectory = await mkdtemp(join(tmpdir(), "assetfare-verify-"));
try {
  const manifestPath = join(fixtureDirectory, "manifest.json");
  const bundlePath = join(fixtureDirectory, "bundle.json");
  const publicKeyPath = join(fixtureDirectory, "manifest.pub");
  await Promise.all([
    writeFile(manifestPath, canonical(manifest)),
    writeFile(bundlePath, canonical(bundle)),
    writeFile(publicKeyPath, PUBLIC_KEY),
  ]);
  const result = await run({ mode: "offline", manifest: manifestPath, bundle: bundlePath, pubkey: publicKeyPath }, { now: NOW });
  assert.equal(result.status, "offline_evidence_verified");
  assert.equal(result.rpc_quorum.performed, false);
  assert.equal(result.safety_bundle.raw_runtime_code_hashes_verified, 10);
} finally {
  await rm(fixtureDirectory, { recursive: true, force: true });
}

const badSignature = structuredClone(manifest);
badSignature.signature.value = `${badSignature.signature.value[0] === "A" ? "B" : "A"}${badSignature.signature.value.slice(1)}`;
assert.throws(() => validateManifest(badSignature, PUBLIC_KEY, "assetfare-selftest", NOW), /signature verification failed/);

const badHash = structuredClone(manifest);
badHash.safety_bundle.sha256 = "0".repeat(64);
resign(badHash);
validateManifest(badHash, PUBLIC_KEY, "assetfare-selftest", NOW);
assert.throws(() => validateBundle(bundle, badHash), /bundle SHA-256 mismatch/);

const badSchemaBundle = structuredClone(bundle);
badSchemaBundle.schema = `${BUNDLE_SCHEMA}-unknown`;
const badSchemaManifest = fixtureManifest(badSchemaBundle);
assert.throws(() => validateBundle(badSchemaBundle, badSchemaManifest), /identity or version/);

const subjectiveBundle = structuredClone(bundle);
subjectiveBundle.safe = true;
const subjectiveManifest = fixtureManifest(subjectiveBundle);
assert.throws(() => validateBundle(subjectiveBundle, subjectiveManifest), /subjective claim|unexpected or missing keys/);

await expectReject(() => fetchCanonicalJson(BUNDLE_URL, 1024, "redirect fixture", async () => new Response(null, { status: 302, headers: { location: "https://example.com/redirected" } })), /redirect is forbidden/);
await expectReject(() => fetchCanonicalJson(BUNDLE_URL, 1024, "MIME fixture", async () => new Response("{}", { status: 200, headers: { "content-type": "text/plain" } })), /invalid MIME/);

function rpcFixture(fault = {}) {
  return async (url, init) => {
    const provider = Object.entries(RPC_PROVIDERS).find(([, pin]) => pin.urls.includes(url));
    assert.ok(provider, `unexpected RPC URL ${url}`);
    const [chainName, pin] = provider;
    const chain = chains.get(chainName);
    const host = new URL(url).hostname;
    const request = JSON.parse(init.body);
    if (fault.type === "incomplete" && fault.host === host && request.id === "code:source_only_cctp") return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id }), { status: 200, headers: { "content-type": "application/json" } });
    if (request.method === "eth_chainId") {
      const chainId = fault.type === "chain" && fault.host === host ? pin.chainId + 1 : pin.chainId;
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: `0x${chainId.toString(16)}` }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (request.method === "eth_getTransactionReceipt") {
      const contract = [...chain.contracts.values()].find((row) => row.transaction_hash === request.params[0]);
      assert.ok(contract);
      const receipt = { blockHash: contract.block_hash, blockNumber: `0x${BigInt(contract.block_number).toString(16)}`, contractAddress: contract.address, status: "0x1", to: null, transactionHash: contract.transaction_hash };
      if (fault.type === "receipt" && fault.host === host && request.id === `receipt:${fault.contract}`) receipt.blockHash = HASH(9999);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: receipt }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const address = request.params[0].toLowerCase();
    const contract = [...chain.contracts.values()].find((row) => row.address.toLowerCase() === address);
    assert.ok(contract);
    let code = contract.runtime_code;
    if (fault.type === "code" && fault.host === host && request.id === `code:${fault.contract}`) code = "0x6001";
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: code }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const goodQuorum = await verifyRpcQuorum(chains, rpcFixture());
assert.equal(goodQuorum.length, 5);
await expectReject(() => verifyRpcQuorum(chains, rpcFixture({ type: "chain", host: "mainnet.base.org" })), /chain id mismatch/);
await expectReject(() => verifyRpcQuorum(chains, rpcFixture({ type: "code", host: "arbitrum.drpc.org", contract: "swap" })), /raw code mismatch/);
await expectReject(() => verifyRpcQuorum(chains, rpcFixture({ type: "receipt", host: "base.drpc.org", contract: "cctp" })), /deployment receipt mismatch/);
await expectReject(() => verifyRpcQuorum(chains, rpcFixture({ type: "incomplete", host: "polygon.drpc.org" })), /invalid response|incomplete evidence/);

process.stdout.write("assetfare verifier hostile selftest: pass\n");
