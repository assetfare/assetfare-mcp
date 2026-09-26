import { readFileSync } from "node:fs";

const CONTRACT = JSON.parse(readFileSync(new URL("./direct-route-contract.json", import.meta.url), "utf8"));
const PRODUCT_KEYS = ["product_classification", "economic_eligibility", "public_execution_eligible", "primary_selection_eligible", "route_minimum_guard_bps"];
const ROOT_KEYS = ["version", "route", "from", "to", "classification", "mode", ...PRODUCT_KEYS, "route_aggregator_used", "external_intent_protocol_used", "provider_internal_dex_aggregation_possible", "assetfare_fee_bps", "fee_collection_step_index", "server_signing", "server_submission", "step_count", "steps"];
const LEGACY_ROOT_KEYS = ROOT_KEYS.filter((key) => !PRODUCT_KEYS.includes(key));
const STEP_KEYS = ["index", "action", "provider", "from", "to", "expected_input_base", "minimum_input_base", "expected_output_base", "minimum_output_base", "assetfare_fee_bps", "direct_protocol", "external_intent_protocol", "aggregator_api_used"];
const ROUTE_KEYS = ["status", "version", "route", "mode", ...PRODUCT_KEYS, "input_base", "expected_output_base", "minimum_output_base", "steps", "quote_latency_ms", "aggregator_api_used", "external_intent_protocol_used", "server_signing", "server_submission"];
const LEGACY_ROUTE_KEYS = ROUTE_KEYS.filter((key) => !PRODUCT_KEYS.includes(key));
const ADDED_STEP_KEYS = ["index", "expected_input_base", "floor_input_base", "expected_output_base", "minimum_output_base", "expected_evidence", "floor_evidence"];
const SWAP_PROVIDERS = new Set(["raydium_clmm", "orca_whirlpool", "uniswap_v3"]);
const DIRECT_BRIDGE_PROVIDERS = new Set(["circle_cctp", "circle_cctp_receive", "paxos_usdg_layerzero_oft"]);
const AMOUNT = /^[1-9][0-9]*$/;

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function rejectSensitive(value) {
  const forbidden = ["privatekey", "privkey", "secretkey", "seedphrase", "seed", "mnemonic", "keypair", "signedtransaction", "signedtx", "rawtransaction", "password", "passphrase", "signature", "issafe"];
  const stack = [[value, 0]];
  let seen = 0;
  while (stack.length) {
    const [node, depth] = stack.pop();
    seen += 1;
    if (seen > 2048 || depth > 20) throw new Error("assetfare_v2_direct_route_unsafe");
    if (Array.isArray(node)) {
      for (const child of node) stack.push([child, depth + 1]);
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
        if (forbidden.some((term) => normalized.includes(term)) || normalized === "safe") throw new Error("assetfare_v2_direct_route_unsafe");
        if (["signed", "submitted"].includes(normalized) && child !== false) throw new Error("assetfare_v2_direct_route_unsafe");
        stack.push([child, depth + 1]);
      }
    }
  }
}

function amountString(value) {
  if (typeof value !== "string" || !AMOUNT.test(value)) throw new Error("assetfare_v2_direct_route_amount_invalid");
  return value;
}

function rawNumberMatches(raw, exact) {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 && Number(exact) === raw;
}

function ceilGuardFloor(expected,guardBps){
  return (BigInt(expected)*(10_000n-BigInt(guardBps))+9_999n)/10_000n;
}

function rawStepKeys(raw, definition) {
  const guard = Object.hasOwn(definition, "minimum_guard_bps") ? ["minimum_guard_bps"] : [];
  if (SWAP_PROVIDERS.has(definition.provider)) return ["kind", "chain", "provider", "from", "to", "route_fee_bps", ...guard, ...ADDED_STEP_KEYS];
  if (definition.provider === "circle_cctp_receive") return ["kind", "provider", "chain", "from", "to", "source_chain", "cctp_mode", "destination_native_gas_required", "route_fee_bps", ...ADDED_STEP_KEYS];
  if (definition.provider === "across_intent_bridge") return ["kind", "provider", "from", "to", "from_asset", "to_asset", "external_intent_protocol", "route_fee_bps", ...ADDED_STEP_KEYS];
  const sourceOnly = definition.provider === "circle_cctp" && /^(polygon|optimism):/.test(definition.from);
  return ["kind", "provider", "from", "to", "asset", ...(sourceOnly ? ["cctp_mode", "finality_threshold", "destination_native_gas_required", "economics_informational_only"] : []), "route_fee_bps", ...guard, ...ADDED_STEP_KEYS];
}

function rawEndpoints(raw, definition) {
  if (SWAP_PROVIDERS.has(definition.provider)) return [`${raw.chain}:${raw.from}`, `${raw.chain}:${raw.to}`];
  if (definition.provider === "circle_cctp_receive") return [`${raw.chain}:${raw.from}`, `${raw.chain}:${raw.to}`];
  if (definition.provider === "across_intent_bridge") return [`${raw.from}:${raw.from_asset}`, `${raw.to}:${raw.to_asset}`];
  return [`${raw.from}:${raw.asset}`, `${raw.to}:${raw.asset}`];
}

function evidenceValid(value) {
  return value && typeof value === "object" && !Array.isArray(value) && value.aggregatorApiUsed === false && (!("status" in value) || value.status === "pass") && value.signed !== true && value.submitted !== true;
}

export function validateDirectRouteSummary(summary, route, risk, intent, offer) {
  rejectSensitive({ summary, route });
  const hasProductMetadata=PRODUCT_KEYS.every((key)=>Object.hasOwn(summary||{},key))&&PRODUCT_KEYS.every((key)=>Object.hasOwn(route||{},key));
  if (!exactKeys(summary, hasProductMetadata?ROOT_KEYS:LEGACY_ROOT_KEYS) || !exactKeys(route, hasProductMetadata?ROUTE_KEYS:LEGACY_ROUTE_KEYS)) throw new Error("assetfare_v2_direct_route_shape_invalid");
  const routeName = `${intent.from}->${intent.to}`;
  const currentDefinition=CONTRACT.routes[routeName],legacyDefinition=CONTRACT.legacy_routes?.[routeName],definition=legacyDefinition&&summary?.mode===legacyDefinition.mode?legacyDefinition:currentDefinition;
  if (!definition || summary.version !== "assetfare-direct-route-summary-v1" || summary.route !== routeName || summary.from !== intent.from || summary.to !== intent.to || summary.mode !== definition.mode || summary.classification !== definition.classification) throw new Error("assetfare_v2_direct_route_binding_invalid");
  const routeGuard=definition.steps.some((step)=>Object.hasOwn(step,"minimum_guard_bps"))?definition.steps.reduce((sum,step)=>sum+Number(step.minimum_guard_bps||0),0):null;
  const expectedProduct=definition.classification==="external_intent"?{product_classification:"external_coverage_only",economic_eligibility:"coverage_only_not_primary",public_execution_eligible:true,primary_selection_eligible:false,route_minimum_guard_bps:null}:{product_classification:"primary_direct",economic_eligibility:"not_asserted_by_capability",public_execution_eligible:true,primary_selection_eligible:true,route_minimum_guard_bps:routeGuard};
  if(hasProductMetadata&&PRODUCT_KEYS.some((key)=>summary[key]!==expectedProduct[key]||route[key]!==expectedProduct[key]))throw new Error("assetfare_v2_direct_route_product_metadata_invalid");
  const legacySourceOnly=definition.steps.length===2&&definition.steps[1]?.provider==="circle_cctp_receive"&&summary.step_count===1&&route.steps?.length===1;
  const definitionSteps=legacySourceOnly?definition.steps.slice(0,1):definition.steps;
  const external = definition.classification === "external_intent";
  if (summary.route_aggregator_used !== false || summary.external_intent_protocol_used !== external || summary.provider_internal_dex_aggregation_possible !== external || summary.assetfare_fee_bps !== 1 || summary.server_signing !== false || summary.server_submission !== false || summary.step_count !== definitionSteps.length || !Array.isArray(summary.steps) || summary.steps.length !== definitionSteps.length) throw new Error("assetfare_v2_direct_route_boundary_invalid");
  if (route.status !== "pass" || route.version !== "assetfare-direct-multichain-quote-v2" || route.route !== routeName || route.mode !== definition.mode || route.aggregator_api_used !== false || route.external_intent_protocol_used !== external || route.server_signing !== false || route.server_submission !== false || !Array.isArray(route.steps) || route.steps.length !== definitionSteps.length) throw new Error("assetfare_v2_direct_route_raw_invalid");
  if (risk.external_intent_protocol_used !== external || risk.provider_internal_dex_aggregation_possible !== external || risk.server_signing !== false || risk.server_submission !== false) throw new Error("assetfare_v2_direct_route_risk_invalid");
  let expectedCursor;
  let minimumCursor;
  let feeSum = 0;
  let feeIndex = -1;
  let cumulativeGuard = 0;
  const safeSteps = [];
  for (let index = 0; index < definitionSteps.length; index += 1) {
    const expected = definitionSteps[index];
    const step = summary.steps[index];
    const raw = route.steps[index];
    const stepKeys=Object.hasOwn(expected,"minimum_guard_bps")?[...STEP_KEYS,"minimum_guard_bps"]:STEP_KEYS;
    if (!exactKeys(step, stepKeys) || !exactKeys(raw, rawStepKeys(raw, expected))) throw new Error("assetfare_v2_direct_route_step_shape_invalid");
    for (const key of ["index", "action", "provider", "from", "to", "assetfare_fee_bps", "direct_protocol", "external_intent_protocol",...(Object.hasOwn(expected,"minimum_guard_bps")?["minimum_guard_bps"]:[])]) if (step[key] !== expected[key]) throw new Error("assetfare_v2_direct_route_plan_invalid");
    if (step.aggregator_api_used !== false || raw.index !== index || raw.provider !== expected.provider || raw.route_fee_bps !== expected.assetfare_fee_bps) throw new Error("assetfare_v2_direct_route_step_invalid");
    const rawKind = expected.action === "swap" ? "direct_swap" : expected.action === "receive" ? "direct_receive" : "direct_bridge";
    const [rawFrom, rawTo] = rawEndpoints(raw, expected);
    if (raw.kind !== rawKind || rawFrom !== expected.from || rawTo !== expected.to || (expected.provider === "across_intent_bridge" ? raw.external_intent_protocol !== true : Object.hasOwn(raw, "external_intent_protocol"))) throw new Error("assetfare_v2_direct_route_raw_plan_invalid");
    if (expected.provider === "circle_cctp" && /^(polygon|optimism):/.test(expected.from) && !(raw.cctp_mode === "no_forward" && raw.finality_threshold === 2000 && raw.destination_native_gas_required === true && raw.economics_informational_only === true)) throw new Error("assetfare_v2_direct_route_source_only_invalid");
    if (expected.provider === "circle_cctp_receive" && !(raw.source_chain===(intent.from.split(":")[0])&&raw.cctp_mode==="no_forward"&&raw.destination_native_gas_required===true&&raw.route_fee_bps===0)) throw new Error("assetfare_v2_direct_route_receive_invalid");
    if (!evidenceValid(raw.expected_evidence) || (raw.floor_evidence !== null && !evidenceValid(raw.floor_evidence))) throw new Error("assetfare_v2_direct_route_evidence_invalid");
    const expectedInput = amountString(step.expected_input_base);
    const minimumInput = amountString(step.minimum_input_base);
    const expectedOutput = amountString(step.expected_output_base);
    const minimumOutput = amountString(step.minimum_output_base);
    if (BigInt(minimumOutput) > BigInt(expectedOutput) || (index && (expectedInput !== expectedCursor || minimumInput !== minimumCursor))) throw new Error("assetfare_v2_direct_route_continuity_invalid");
    if(Object.hasOwn(expected,"minimum_guard_bps")){
      cumulativeGuard+=expected.minimum_guard_bps;
      if(BigInt(minimumOutput)<ceilGuardFloor(expectedOutput,cumulativeGuard))throw new Error("assetfare_v2_direct_route_component_guard_invalid");
    }
    if (![raw.expected_input_base, raw.floor_input_base, raw.expected_output_base, raw.minimum_output_base].every((value, offset) => rawNumberMatches(value, [expectedInput, minimumInput, expectedOutput, minimumOutput][offset]))) throw new Error("assetfare_v2_direct_route_amount_binding_invalid");
    expectedCursor = expectedOutput;
    minimumCursor = minimumOutput;
    feeSum += step.assetfare_fee_bps;
    if (step.assetfare_fee_bps === 1) feeIndex = index;
    safeSteps.push({ index, action: expected.action, provider: expected.provider, from: expected.from, to: expected.to, expected_input_base: expectedInput, minimum_input_base: minimumInput, expected_output_base: expectedOutput, minimum_output_base: minimumOutput, assetfare_fee_bps: expected.assetfare_fee_bps,...(Object.hasOwn(expected,"minimum_guard_bps")?{minimum_guard_bps:expected.minimum_guard_bps}:{}), direct_protocol: expected.direct_protocol, external_intent_protocol: expected.external_intent_protocol, aggregator_api_used: false });
  }
  if(routeGuard!==null&&BigInt(minimumCursor)<ceilGuardFloor(expectedCursor,routeGuard))throw new Error("assetfare_v2_direct_route_final_guard_invalid");
  if (!rawNumberMatches(intent.estimated_input_base, safeSteps[0].expected_input_base) || !rawNumberMatches(route.input_base, safeSteps[0].expected_input_base) || safeSteps[0].minimum_input_base !== safeSteps[0].expected_input_base || !rawNumberMatches(route.expected_output_base, expectedCursor) || !rawNumberMatches(route.minimum_output_base, minimumCursor) || feeSum !== 1 || feeIndex !== summary.fee_collection_step_index || offer.assetfare_fee_bps !== 1 || offer.fee_modeled_bps !== 1 || offer.fee_collectible_now !== true || !Array.isArray(offer.fee_collection_steps) || offer.fee_collection_steps.length !== 1 || offer.fee_collection_steps[0] !== feeIndex) throw new Error("assetfare_v2_direct_route_fee_or_root_invalid");
  return { version: "assetfare-direct-route-summary-v1", route: routeName, from: intent.from, to: intent.to, classification: definition.classification, mode: definition.mode,...(hasProductMetadata?expectedProduct:{}), route_aggregator_used: false, external_intent_protocol_used: external, provider_internal_dex_aggregation_possible: external, assetfare_fee_bps: 1, fee_collection_step_index: feeIndex, server_signing: false, server_submission: false, step_count: safeSteps.length, steps: safeSteps };
}

export const DIRECT_ROUTE_CONTRACT_COUNTS = Object.freeze({ routes: CONTRACT.route_count, steps: CONTRACT.step_count });
