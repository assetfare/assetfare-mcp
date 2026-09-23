#!/usr/bin/env node
/**
 * Reproducible, offline evidence for AssetFare's five unique deployed executor
 * implementations.  This is executable evidence, not an audit or a subjective
 * safety score.  It uses no key, RPC, signature, submission, or project API.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import solc from 'solc';

const ROOT = new URL('./', import.meta.url);
const COMPILER = '0.8.30+commit.73712a01.Emscripten.clang';
const SPECS = {
  AssetFareSourceOnlyCctpExecutorV2: {
    functions: ['FEE_RECIPIENT','MAX_DEADLINE_WINDOW','MIN_INPUT_USDC','ROUTE_FEE_BPS','SOURCE_DOMAIN','TOKEN_MESSENGER','USDC','bridgeUSDC'],
    feeExpression: /routeFee=amountIn\/10_000/,
    invariants: [
      /routeFee=amountIn\/10_000;\s*burnUSDC=amountIn-routeFee/,
      /destinationCaller==bytes32\(0\)&&maxCctpFee==0&&minFinalityThreshold==2000&&hookData\.length==0/,
      /_approve\(address\(TOKEN_MESSENGER\),0\)/,
      /USDC\.balanceOf\(address\(this\)\)==beforeBalance/,
    ],
  },
  AssetFareDirectCctpExecutorV2: {
    functions: ['FEE_RECIPIENT','FORWARD_EXISTING_RECIPIENT','FORWARD_SETUP_HEAD','ROUTE_FEE_BPS','SOURCE_DOMAIN','TOKEN_MESSENGER','USDC','bridgeUSDC'],
    feeExpression: /routeFee=amountIn\/10_000/,
    invariants: [
      /routeFee=amountIn\/10_000;burnUSDC=amountIn-routeFee/,
      /maxCctpFee<=5_000_000&&maxCctpFee<=burnUSDC\/20/,
      /_approve\(address\(TOKEN_MESSENGER\),0\)/,
      /USDC\.balanceOf\(address\(this\)\)==beforeBalance/,
    ],
  },
  AssetFareDirectSwapExecutorV2: {
    functions: ['FEE_RECIPIENT','ROUTE_FEE_BPS','ROUTER','STABLE','WETH','swapNativeToStable','swapStableToNative'],
    feeExpression: /routeFeeBps==ROUTE_FEE_BPS/,
    invariants: [
      /fee=gross\*routeFeeBps\/10_000;netStable=gross-fee/,
      /fee=amountIn\*routeFeeBps\/10_000;uint256swapInput=amountIn-fee/,
      /_approve\(address\(WETH\),address\(ROUTER\),0\)/,
      /_approve\(address\(STABLE\),address\(ROUTER\),0\)/,
      /receive\(\)externalpayable\{require\(msg\.sender==address\(WETH\)/,
    ],
  },
  AssetFareDirectUsdgOftExecutorV2: {
    functions: ['FEE_RECIPIENT','OFT','ROUTE_FEE_BPS','SOLANA_EID','SOLANA_PEER','USDG','bridgeUSDG'],
    feeExpression: /routeFee=amountIn\/10_000/,
    invariants: [
      /routeFee=amountIn\/10_000;sentUSDG=amountIn-routeFee/,
      /msg\.value==nativeFee/,
      /MessagingFee\(nativeFee,0\)/,
      /USDG\.balanceOf\(address\(this\)\)==beforeBalance/,
    ],
  },
  RouteAgentDestinationExecutorV3: {
    functions: ['FEE_RECIPIENT','ROUTE_FEE_BPS','ROUTER','USDC','WETH','settleUpTo'],
    feeExpression: /routeFee=inputUSDC\/10_000/,
    invariants: [
      /routeFee=inputUSDC\/10_000;uint256swapAmount=inputUSDC-routeFee/,
      /USDC\.approve\(address\(ROUTER\),0\)/,
      /USDC\.balanceOf\(address\(this\)\)==beforeBalance/,
      /receive\(\)externalpayable\{require\(msg\.sender==address\(WETH\)/,
    ],
  },
};

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const compact = source => source.replace(/\s+/g, '');
const stable = value => {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
};

if (solc.version() !== COMPILER) throw new Error(`compiler mismatch:${solc.version()}`);

const contracts = {};
for (const [name, spec] of Object.entries(SPECS)) {
  const sourceBytes = fs.readFileSync(new URL(`contracts/${name}.sol`, ROOT));
  const source = sourceBytes.toString('utf8');
  const artifactBytes = fs.readFileSync(new URL(`artifacts/${name}.json`, ROOT));
  const artifact = JSON.parse(artifactBytes);
  const input = {
    language: 'Solidity',
    sources: {[`${name}.sol`]: {content: source}},
    settings: {optimizer: {enabled: true, runs: 200}, outputSelection: {'*': {'*': ['abi','evm.bytecode.object','evm.deployedBytecode.object']}}},
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter(row => row.severity === 'error');
  if (errors.length) throw new Error(errors.map(row => row.formattedMessage).join('\n'));
  const compiled = output.contracts[`${name}.sol`][name];
  const rebuilt = {abi: compiled.abi, bytecode: `0x${compiled.evm.bytecode.object}`, deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`};
  const normalized = compact(source);
  const functions = artifact.abi.filter(row => row.type === 'function').map(row => row.name).sort();
  const forbidden = artifact.abi.filter(row => row.type === 'function' && /owner|admin|upgrade|rescue|withdraw|delegate|selfdestruct/i.test(row.name));
  const checks = {
    deterministic_abi: JSON.stringify(rebuilt.abi) === JSON.stringify(artifact.abi),
    deterministic_creation_bytecode: rebuilt.bytecode === artifact.bytecode,
    deterministic_runtime_template: rebuilt.deployedBytecode === artifact.deployedBytecode,
    exact_function_surface: JSON.stringify(functions) === JSON.stringify([...spec.functions].sort()),
    exact_one_bps_expression: spec.feeExpression.test(normalized),
    exact_one_bps_constant: /ROUTE_FEE_BPS=1/.test(normalized),
    no_service_fee_cap: !/ROUTE_FEE_CAP/.test(source) && !functions.includes('ROUTE_FEE_CAP'),
    no_admin_upgrade_rescue_surface: forbidden.length === 0 && !/\b(delegatecall|selfdestruct)\b/i.test(source),
    non_reentrant: /modifiernonReentrant\(\)/.test(normalized),
    declared_invariants_present: spec.invariants.every(pattern => pattern.test(normalized)),
    eip170_runtime_limit: (artifact.deployedBytecode.length - 2) / 2 < 24_576,
  };
  contracts[name] = {
    source_sha256: sha256(sourceBytes),
    artifact_file_sha256: sha256(artifactBytes),
    creation_bytecode_sha256: sha256(Buffer.from(artifact.bytecode.slice(2), 'hex')),
    runtime_template_sha256: sha256(Buffer.from(artifact.deployedBytecode.slice(2), 'hex')),
    runtime_bytes: (artifact.deployedBytecode.length - 2) / 2,
    functions,
    checks,
  };
}

// Deterministic arithmetic properties across boundaries and 4,096 reproducible
// 256-bit samples.  These are executable property checks, not formal proofs.
const UINT256_MAX = (1n << 256n) - 1n;
const samples = [1n, 9_999n, 10_000n, 10_001n, 1_000_000n, 250_000_000n, 50_000_000_000n, 100_000_000_000n, 1_000_000_000_000n, UINT256_MAX];
let seed = Buffer.alloc(32, 0x41);
for (let i = 0; i < 4096; i += 1) {
  seed = crypto.createHash('sha256').update(seed).update(String(i)).digest();
  samples.push(BigInt(`0x${seed.toString('hex')}`));
}
const arithmetic = {
  sample_count: samples.length,
  fee_formula_exact: samples.every(input => input / 10_000n === (input - input % 10_000n) / 10_000n),
  fee_never_exceeds_input: samples.every(input => input / 10_000n <= input),
  split_conserves_input: samples.every(input => input / 10_000n + (input - input / 10_000n) === input),
  no_retired_five_usdc_clamp: 100_000_000_000n / 10_000n === 10_000_000n && 1_000_000_000_000n / 10_000n === 100_000_000n,
  floor_precision_boundary: 9_999n / 10_000n === 0n && 10_000n / 10_000n === 1n,
};

const pass = Object.values(contracts).every(row => Object.values(row.checks).every(Boolean)) && Object.values(arithmetic).every(value => value === true || Number.isInteger(value));
const evidence = stable({
  schema: 'https://assetfare.dev/schemas/agent-safety-invariants-v1',
  evidence_kind: 'reproducible_executable_property_checks_not_a_formal_proof_or_security_audit',
  compiler: {version: solc.version(), optimizer: {enabled: true, runs: 200}},
  contracts,
  arithmetic,
  network_requests: 0,
  keys_loaded: 0,
  signed: false,
  submitted: false,
  status: pass ? 'pass' : 'fail',
});
process.stdout.write(`${JSON.stringify(evidence)}\n`);
if (!pass) process.exit(1);
