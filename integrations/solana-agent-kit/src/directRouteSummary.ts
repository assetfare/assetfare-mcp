type JsonRecord = Record<string, unknown>;

export interface DirectRouteIntent {
  fromChain: string;
  fromToken: string;
  toChain: string;
  toToken: string;
  amountUsd: number;
}

interface StepDefinition {
  index: number;
  action: "swap" | "bridge";
  provider: "raydium_clmm" | "orca_whirlpool" | "uniswap_v3" | "circle_cctp" | "paxos_usdg_layerzero_oft" | "across_intent_bridge";
  from: string;
  to: string;
  assetfare_fee_bps: 0 | 1;
  direct_protocol: boolean;
  external_intent_protocol: boolean;
}

interface RouteDefinition {
  classification: "direct_protocol_only" | "external_intent";
  mode: string;
  steps: StepDefinition[];
}

const ROOT_KEYS = ["version", "route", "from", "to", "classification", "mode", "route_aggregator_used", "external_intent_protocol_used", "provider_internal_dex_aggregation_possible", "assetfare_fee_bps", "fee_collection_step_index", "server_signing", "server_submission", "step_count", "steps"];
const STEP_KEYS = ["index", "action", "provider", "from", "to", "expected_input_base", "minimum_input_base", "expected_output_base", "minimum_output_base", "assetfare_fee_bps", "direct_protocol", "external_intent_protocol", "aggregator_api_used"];
const ROUTE_KEYS = ["status", "version", "route", "mode", "input_base", "expected_output_base", "minimum_output_base", "steps", "quote_latency_ms", "aggregator_api_used", "external_intent_protocol_used", "server_signing", "server_submission"];
const ADDED_STEP_KEYS = ["index", "expected_input_base", "floor_input_base", "expected_output_base", "minimum_output_base", "expected_evidence", "floor_evidence"];
const SWAP_PROVIDERS = new Set(["raydium_clmm", "orca_whirlpool", "uniswap_v3"]);
const AMOUNT = /^[1-9][0-9]*$/;

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("assetfare_v2_direct_route_shape_invalid");
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function rejectSensitive(value: unknown): void {
  const forbidden = ["privatekey", "privkey", "secretkey", "seedphrase", "seed", "mnemonic", "keypair", "signedtransaction", "signedtx", "rawtransaction", "password", "passphrase", "signature", "issafe"];
  const stack: Array<[unknown, number]> = [[value, 0]];
  let seen = 0;
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (++seen > 2048 || depth > 20) throw new Error("assetfare_v2_direct_route_unsafe");
    if (Array.isArray(node)) {
      for (const child of node) stack.push([child, depth + 1]);
    } else if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node)) {
        const normalized = key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
        if (forbidden.some((term) => normalized.includes(term)) || normalized === "safe") throw new Error("assetfare_v2_direct_route_unsafe");
        if ((normalized === "signed" || normalized === "submitted") && child !== false) throw new Error("assetfare_v2_direct_route_unsafe");
        stack.push([child, depth + 1]);
      }
    }
  }
}

function split(endpoint: string): [string, string] {
  const parts = endpoint.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("assetfare_v2_direct_route_binding_invalid");
  return [parts[0], parts[1]];
}

function buildDefinition(from: string, to: string): RouteDefinition {
  const [fromChain, fromToken] = split(from);
  const [toChain, toToken] = split(to);
  const steps: StepDefinition[] = [];
  const add = (action: "swap" | "bridge", provider: StepDefinition["provider"], stepFrom: string, stepTo: string, fee: 0 | 1, external = false) => {
    steps.push({ index: steps.length, action, provider, from: stepFrom, to: stepTo, assetfare_fee_bps: fee, direct_protocol: !external, external_intent_protocol: external });
  };
  const addSwap = (chain: string, source: string, destination: string, fee: 0 | 1) => {
    const provider = chain === "solana" ? (source === "USDG" || destination === "USDG" ? "orca_whirlpool" : "raydium_clmm") : "uniswap_v3";
    add("swap", provider, `${chain}:${source}`, `${chain}:${destination}`, fee);
  };

  if (fromChain === toChain) {
    if (fromChain === "solana" && fromToken === "SOL" && toToken === "USDG") {
      addSwap("solana", "SOL", "USDC", 0); addSwap("solana", "USDC", "USDG", 1);
      return { classification: "direct_protocol_only", mode: "same_chain_direct_composition", steps };
    }
    if (fromChain === "solana" && fromToken === "USDG" && toToken === "SOL") {
      addSwap("solana", "USDG", "USDC", 1); addSwap("solana", "USDC", "SOL", 0);
      return { classification: "direct_protocol_only", mode: "same_chain_direct_composition", steps };
    }
    addSwap(fromChain, fromToken, toToken, 1);
    return { classification: "direct_protocol_only", mode: "same_chain_direct", steps };
  }

  if (fromChain === "polygon" || fromChain === "optimism") {
    add("bridge", "circle_cctp", from, to, 1);
    return { classification: "direct_protocol_only", mode: `${fromChain}_source_cctp`, steps };
  }

  if (fromChain === "robinhood") {
    if (fromToken === "ETH") addSwap("robinhood", "ETH", "USDG", 0);
    add("bridge", "paxos_usdg_layerzero_oft", "robinhood:USDG", "solana:USDG", 1);
    if (toToken !== "USDG" || toChain !== "solana") addSwap("solana", "USDG", "USDC", 0);
    if (toChain === "solana") {
      if (toToken === "SOL") addSwap("solana", "USDC", "SOL", 0);
    } else {
      add("bridge", "circle_cctp", "solana:USDC", `${toChain}:USDC`, 0);
      if (toToken === "ETH") addSwap(toChain, "USDC", "ETH", 0);
    }
    return { classification: "direct_protocol_only", mode: "robinhood_paxos_egress_composition", steps };
  }

  if (toChain === "robinhood") {
    if (fromChain === "solana") {
      if (fromToken !== "USDC") addSwap("solana", fromToken, "USDC", 0);
      add("bridge", "circle_cctp", "solana:USDC", "base:USDC", 1);
      add("bridge", "across_intent_bridge", "base:USDC", "robinhood:USDG", 0, true);
      if (toToken === "ETH") addSwap("robinhood", "USDG", "ETH", 0);
    } else {
      if (fromToken === "ETH") addSwap(fromChain, "ETH", "USDC", 1);
      add("bridge", "across_intent_bridge", `${fromChain}:USDC`, "robinhood:USDG", fromToken === "USDC" && toToken === "USDG" ? 1 : 0, true);
      if (toToken === "ETH") addSwap("robinhood", "USDG", "ETH", fromToken === "USDC" ? 1 : 0);
    }
    return { classification: "external_intent", mode: "robinhood_across_ingress_composition", steps };
  }

  if (fromToken !== "USDC") addSwap(fromChain, fromToken, "USDC", 0);
  add("bridge", "circle_cctp", `${fromChain}:USDC`, `${toChain}:USDC`, 1);
  if (toToken !== "USDC") addSwap(toChain, "USDC", toToken, 0);
  return { classification: "direct_protocol_only", mode: "cctp_direct_composition", steps };
}

function rawStepKeys(definition: StepDefinition): string[] {
  if (SWAP_PROVIDERS.has(definition.provider)) return ["kind", "chain", "provider", "from", "to", "route_fee_bps", ...ADDED_STEP_KEYS];
  if (definition.provider === "across_intent_bridge") return ["kind", "provider", "from", "to", "from_asset", "to_asset", "external_intent_protocol", "route_fee_bps", ...ADDED_STEP_KEYS];
  const sourceOnly = definition.provider === "circle_cctp" && /^(polygon|optimism):/.test(definition.from);
  return ["kind", "provider", "from", "to", "asset", ...(sourceOnly ? ["cctp_mode", "finality_threshold", "destination_native_gas_required", "economics_informational_only"] : []), "route_fee_bps", ...ADDED_STEP_KEYS];
}

function rawEndpoints(raw: JsonRecord, definition: StepDefinition): [string, string] {
  if (SWAP_PROVIDERS.has(definition.provider)) return [`${raw.chain}:${raw.from}`, `${raw.chain}:${raw.to}`];
  if (definition.provider === "across_intent_bridge") return [`${raw.from}:${raw.from_asset}`, `${raw.to}:${raw.to_asset}`];
  return [`${raw.from}:${raw.asset}`, `${raw.to}:${raw.asset}`];
}

function evidenceValid(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as JsonRecord;
  return evidence.aggregatorApiUsed === false && (!("status" in evidence) || evidence.status === "pass") && evidence.signed !== true && evidence.submitted !== true;
}

function amount(value: unknown): string {
  if (typeof value !== "string" || !AMOUNT.test(value)) throw new Error("assetfare_v2_direct_route_amount_invalid");
  return value;
}

function rawNumberMatches(raw: unknown, exact: string): boolean {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 && Number(exact) === raw;
}

/** Validate and canonicalize the intent-bound direct path before exposing a quote to an agent. */
export function validateQuoteDirectRoute(quote: JsonRecord, requested: DirectRouteIntent): JsonRecord {
  const summary = record(quote.direct_route_summary);
  const route = record(quote.route);
  const risk = record(quote.risk);
  const intent = record(quote.intent);
  const offer = record(quote.offer);
  const execution = record(quote.execution);
  rejectSensitive({ summary, route });
  if (quote.status !== "capped_public_agent_release" || execution.supported !== true || !exactKeys(summary, ROOT_KEYS) || !exactKeys(route, ROUTE_KEYS)) throw new Error("assetfare_v2_direct_route_shape_invalid");

  const expectedFrom = `${requested.fromChain}:${requested.fromToken}`;
  const expectedTo = `${requested.toChain}:${requested.toToken}`;
  if (intent.from !== expectedFrom || intent.to !== expectedTo || intent.amount_usd !== requested.amountUsd) throw new Error("assetfare_v2_direct_route_intent_invalid");
  const routeName = `${expectedFrom}->${expectedTo}`;
  const definition = buildDefinition(expectedFrom, expectedTo);
  if (summary.version !== "assetfare-direct-route-summary-v1" || summary.route !== routeName || summary.from !== expectedFrom || summary.to !== expectedTo || summary.mode !== definition.mode || summary.classification !== definition.classification) throw new Error("assetfare_v2_direct_route_binding_invalid");
  const external = definition.classification === "external_intent";
  if (summary.route_aggregator_used !== false || summary.external_intent_protocol_used !== external || summary.provider_internal_dex_aggregation_possible !== external || summary.assetfare_fee_bps !== 1 || summary.server_signing !== false || summary.server_submission !== false || summary.step_count !== definition.steps.length || !Array.isArray(summary.steps) || summary.steps.length !== definition.steps.length) throw new Error("assetfare_v2_direct_route_boundary_invalid");
  if (route.status !== "pass" || route.version !== "assetfare-direct-multichain-quote-v2" || route.route !== routeName || route.mode !== definition.mode || route.aggregator_api_used !== false || route.external_intent_protocol_used !== external || route.server_signing !== false || route.server_submission !== false || !Array.isArray(route.steps) || route.steps.length !== definition.steps.length) throw new Error("assetfare_v2_direct_route_raw_invalid");
  if (risk.external_intent_protocol_used !== external || risk.provider_internal_dex_aggregation_possible !== external || risk.server_signing !== false || risk.server_submission !== false) throw new Error("assetfare_v2_direct_route_risk_invalid");

  let expectedCursor: string | undefined;
  let minimumCursor: string | undefined;
  let feeSum = 0;
  let feeIndex = -1;
  const safeSteps: JsonRecord[] = [];
  for (let index = 0; index < definition.steps.length; index += 1) {
    const expected = definition.steps[index];
    const step = record(summary.steps[index]);
    const raw = record(route.steps[index]);
    if (!exactKeys(step, STEP_KEYS) || !exactKeys(raw, rawStepKeys(expected))) throw new Error("assetfare_v2_direct_route_step_shape_invalid");
    for (const key of ["index", "action", "provider", "from", "to", "assetfare_fee_bps", "direct_protocol", "external_intent_protocol"] as const) if (step[key] !== expected[key]) throw new Error("assetfare_v2_direct_route_plan_invalid");
    if (step.aggregator_api_used !== false || raw.index !== index || raw.provider !== expected.provider || raw.route_fee_bps !== expected.assetfare_fee_bps) throw new Error("assetfare_v2_direct_route_step_invalid");
    const [rawFrom, rawTo] = rawEndpoints(raw, expected);
    const rawKind = expected.action === "swap" ? "direct_swap" : "direct_bridge";
    if (raw.kind !== rawKind || rawFrom !== expected.from || rawTo !== expected.to || (expected.provider === "across_intent_bridge" ? raw.external_intent_protocol !== true : Object.hasOwn(raw, "external_intent_protocol"))) throw new Error("assetfare_v2_direct_route_raw_plan_invalid");
    if (expected.provider === "circle_cctp" && /^(polygon|optimism):/.test(expected.from) && !(raw.cctp_mode === "no_forward" && raw.finality_threshold === 2000 && raw.destination_native_gas_required === true && raw.economics_informational_only === true)) throw new Error("assetfare_v2_direct_route_source_only_invalid");
    if (!evidenceValid(raw.expected_evidence) || (raw.floor_evidence !== null && !evidenceValid(raw.floor_evidence))) throw new Error("assetfare_v2_direct_route_evidence_invalid");
    const expectedInput = amount(step.expected_input_base);
    const minimumInput = amount(step.minimum_input_base);
    const expectedOutput = amount(step.expected_output_base);
    const minimumOutput = amount(step.minimum_output_base);
    if (BigInt(minimumOutput) > BigInt(expectedOutput) || (index > 0 && (expectedInput !== expectedCursor || minimumInput !== minimumCursor))) throw new Error("assetfare_v2_direct_route_continuity_invalid");
    if (![raw.expected_input_base, raw.floor_input_base, raw.expected_output_base, raw.minimum_output_base].every((value, offset) => rawNumberMatches(value, [expectedInput, minimumInput, expectedOutput, minimumOutput][offset]))) throw new Error("assetfare_v2_direct_route_amount_binding_invalid");
    expectedCursor = expectedOutput;
    minimumCursor = minimumOutput;
    feeSum += expected.assetfare_fee_bps;
    if (expected.assetfare_fee_bps === 1) feeIndex = index;
    safeSteps.push({ ...expected, expected_input_base: expectedInput, minimum_input_base: minimumInput, expected_output_base: expectedOutput, minimum_output_base: minimumOutput, aggregator_api_used: false });
  }

  if (!safeSteps.length || !rawNumberMatches(intent.estimated_input_base, safeSteps[0].expected_input_base as string) || !rawNumberMatches(route.input_base, safeSteps[0].expected_input_base as string) || safeSteps[0].minimum_input_base !== safeSteps[0].expected_input_base || !rawNumberMatches(route.expected_output_base, expectedCursor!) || !rawNumberMatches(route.minimum_output_base, minimumCursor!) || feeSum !== 1 || feeIndex !== summary.fee_collection_step_index || offer.assetfare_fee_bps !== 1 || offer.fee_modeled_bps !== 1 || offer.fee_collectible_now !== true || !Array.isArray(offer.fee_collection_steps) || offer.fee_collection_steps.length !== 1 || offer.fee_collection_steps[0] !== feeIndex) throw new Error("assetfare_v2_direct_route_fee_or_root_invalid");

  const canonicalSummary: JsonRecord = { version: "assetfare-direct-route-summary-v1", route: routeName, from: expectedFrom, to: expectedTo, classification: definition.classification, mode: definition.mode, route_aggregator_used: false, external_intent_protocol_used: external, provider_internal_dex_aggregation_possible: external, assetfare_fee_bps: 1, fee_collection_step_index: feeIndex, server_signing: false, server_submission: false, step_count: safeSteps.length, steps: safeSteps };
  return { ...quote, direct_route_summary: canonicalSummary };
}
