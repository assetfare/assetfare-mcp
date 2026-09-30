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
  action: "swap" | "bridge" | "receive";
  provider: "raydium_clmm" | "orca_whirlpool" | "uniswap_v3" | "circle_cctp" | "circle_cctp_receive" | "paxos_usdg_layerzero_oft" | "across_intent_bridge";
  from: string;
  to: string;
  assetfare_fee_bps: 0 | 1;
  direct_protocol: boolean;
  external_intent_protocol: boolean;
  minimum_guard_bps?: number;
}

interface RouteDefinition {
  classification: "direct_protocol_only" | "external_intent";
  mode: string;
  steps: StepDefinition[];
}

const PRODUCT_KEYS = ["product_classification", "economic_eligibility", "public_execution_eligible", "primary_selection_eligible", "route_minimum_guard_bps"];
const ROOT_KEYS = ["version", "route", "from", "to", "classification", "mode", ...PRODUCT_KEYS, "route_aggregator_used", "external_intent_protocol_used", "provider_internal_dex_aggregation_possible", "assetfare_fee_bps", "fee_collection_step_index", "server_signing", "server_submission", "step_count", "steps"];
const LEGACY_ROOT_KEYS = ROOT_KEYS.filter((key) => !PRODUCT_KEYS.includes(key));
const STEP_KEYS = ["index", "action", "provider", "from", "to", "expected_input_base", "minimum_input_base", "expected_output_base", "minimum_output_base", "assetfare_fee_bps", "direct_protocol", "external_intent_protocol", "aggregator_api_used"];
const ROUTE_KEYS = ["status", "version", "route", "mode", ...PRODUCT_KEYS, "input_base", "expected_output_base", "minimum_output_base", "steps", "quote_latency_ms", "aggregator_api_used", "external_intent_protocol_used", "server_signing", "server_submission"];
const LEGACY_ROUTE_KEYS = ROUTE_KEYS.filter((key) => !PRODUCT_KEYS.includes(key));
const ADDED_STEP_KEYS = ["index", "expected_input_base", "floor_input_base", "expected_output_base", "minimum_output_base", "expected_evidence", "floor_evidence"];
const SWAP_PROVIDERS = new Set(["raydium_clmm", "orca_whirlpool", "uniswap_v3"]);
const AMOUNT = /^[1-9][0-9]*$/;
const GUIDANCE_KEYS = ["advisory_start_usd", "advisory_role", "status", "confidence", "basis", "tested_amounts_usd", "not_an_execution_minimum", "not_a_best_price_guarantee", "fresh_quote_required"];
const GUIDANCE_STARTS = new Set([50, 100, 250, 500, 1000, 2500, 5000, 10000]);
const GUIDANCE_ROLES = new Set(["observed_economic_zone_start", "structural_evaluation_start_not_observed_eligibility", "retest_start_not_economic_eligibility"]);
const GUIDANCE_STATUSES = new Set(["observed_near_parity", "observed_competitive_or_near_parity", "provisional_evaluation_start", "reworked_route_remeasure", "coverage_only_retest"]);
const GUIDANCE_CONFIDENCE = new Set(["measured_two_day", "measured_route_specific", "structural_estimate", "reworked_route_remeasure", "coverage_only_retest"]);
const CAPABILITY_GUIDANCE_KEYS = ["version", "as_of", "route_count", "currency", "technical_quote_minimum_usd", "economic_guidance_is_non_enforcing", "amount_is_never_rejected_by_economic_guidance", "values_change_with_market", "fresh_quote_and_caller_decision_control", "update_policy", "confidence_counts", "advisory_start_distribution"];
const TARGET_CAPABILITY_GUIDANCE_KEYS = ["version", "as_of", "route_count", "public_active_route_count", "public_inactive_route_count", "verified_best_from_route_count", "availability_only_route_count", "currency", "technical_quote_minimum_usd", "economic_guidance_is_non_enforcing", "amount_is_never_rejected_by_economic_guidance", "values_change_with_market", "fresh_quote_and_caller_decision_control", "update_policy", "first_use_zero_allowance_scenario", "expected_output_ranking", "incomplete_cost_never_promoted", "tested_ceiling_usd", "advisory_start_distribution", "recommendation_status_counts"];
const TARGET_GUIDANCE_KEYS = ["advisory_start_usd", "best_from_usd", "best_from_verified", "availability_only", "public_activation_status", "public_active", "recommendation_status", "recommended_action", "confidence", "basis", "tested_amounts_usd", "tested_ceiling_usd", "not_an_execution_minimum", "not_a_best_price_guarantee", "fresh_quote_required"];
const CONFIDENCE_KEYS = ["measured_two_day", "measured_route_specific", "structural_estimate", "reworked_route_remeasure", "coverage_only_retest"];
const DISTRIBUTION_KEYS = ["50", "100", "250", "500", "1000", "2500", "5000", "10000"];

function record(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("assetfare_v2_direct_route_shape_invalid");
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as JsonRecord;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Require the current route-specific guidance authority before exposing capabilities. */
export function validateCapabilitiesEconomicGuidance(capabilities: JsonRecord): void {
  const top = record(capabilities.economic_guidance);
  const policy = record(capabilities.route_product_policy);
  const nested = record(policy.economic_guidance);
  const distribution = record(top.advisory_start_distribution);
  const conditioned = record(policy.amount_conditioned_routes);
  const evaluation = record(capabilities.evaluation_guidance);
  const routeSpecific = record(evaluation.route_specific_guidance);
  if (top.version === "assetfare-route-economic-guidance-v3") {
    const recommendation = record(top.recommendation_status_counts);
    if (
      !exactKeys(top, TARGET_CAPABILITY_GUIDANCE_KEYS) ||
      canonical(top) !== canonical(nested) ||
      typeof top.as_of !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(top.as_of) ||
      top.route_count !== 98 || top.public_active_route_count !== 54 || top.public_inactive_route_count !== 44 ||
      top.verified_best_from_route_count !== 44 || top.availability_only_route_count !== 10 || top.currency !== "USD" ||
      top.technical_quote_minimum_usd !== 1 || top.economic_guidance_is_non_enforcing !== true ||
      top.amount_is_never_rejected_by_economic_guidance !== true || top.values_change_with_market !== true ||
      top.fresh_quote_and_caller_decision_control !== true || top.update_policy !== "daily_measurement_with_three_day_activation_hysteresis" ||
      top.first_use_zero_allowance_scenario !== true || top.expected_output_ranking !== true || top.incomplete_cost_never_promoted !== true || top.tested_ceiling_usd !== 10000 ||
      !exactKeys(distribution, DISTRIBUTION_KEYS) || Object.values(distribution).reduce<number>((sum,count)=>sum+(count as number),0)!==44 ||
      recommendation.active_price_verified !== 44 || recommendation.active_availability_only !== 10 || recommendation.inactive_economics !== 44 ||
      Object.keys(conditioned).length !== 44 || Object.values(conditioned).some((amount)=>!GUIDANCE_STARTS.has(amount as number)) ||
      policy.active_route_count !== 54 || policy.inactive_route_count !== 44 || !Array.isArray(policy.inactive_routes) || policy.inactive_routes.length !== 44 ||
      policy.economic_guidance_url !== "https://assetfare.dev/route-economics.json" || evaluation.schema_version !== 4 || Object.hasOwn(evaluation,"native_usdc_economic_evaluation_start_usd") ||
      routeSpecific.version !== "assetfare-route-economic-guidance-v3" || routeSpecific.url !== "https://assetfare.dev/route-economics.json" ||
      routeSpecific.required_on_every_quote !== true || routeSpecific.verified_best_from_only !== true || routeSpecific.nullable_when_unverified !== true ||
      routeSpecific.controls_recommendation_only_when_verified !== true || routeSpecific.catalog_routes !== 98 || routeSpecific.public_active_routes !== 54 || routeSpecific.public_inactive_routes !== 44 || routeSpecific.availability_only_routes !== 10
    ) throw new Error("assetfare_v2_economic_guidance_invalid");
    return;
  }
  const confidence = record(top.confidence_counts);
  if (
    !exactKeys(top, CAPABILITY_GUIDANCE_KEYS) ||
    canonical(top) !== canonical(nested) ||
    top.version !== "assetfare-route-economic-guidance-v1" ||
    typeof top.as_of !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(top.as_of) ||
    top.route_count !== 80 ||
    top.currency !== "USD" ||
    top.technical_quote_minimum_usd !== 1 ||
    top.economic_guidance_is_non_enforcing !== true ||
    top.amount_is_never_rejected_by_economic_guidance !== true ||
    top.values_change_with_market !== true ||
    top.fresh_quote_and_caller_decision_control !== true ||
    top.update_policy !== "append_daily_observations_then_replace_values_without_schema_change" ||
    !exactKeys(confidence, CONFIDENCE_KEYS) ||
    Object.values(confidence).some((count) => !Number.isInteger(count) || (count as number) < 0) ||
    Object.values(confidence).reduce<number>((sum, count) => sum + (count as number), 0) !== 80 ||
    !exactKeys(distribution, DISTRIBUTION_KEYS) ||
    Object.values(distribution).some((count) => !Number.isInteger(count) || (count as number) < 0) ||
    Object.values(distribution).reduce<number>((sum, count) => sum + (count as number), 0) !== 80 ||
    Object.keys(conditioned).length !== 0 ||
    policy.economic_guidance_url !== "https://assetfare.dev/route-economics.json" ||
    evaluation.schema_version !== 2 ||
    Object.hasOwn(evaluation, "native_usdc_economic_evaluation_start_usd") ||
    routeSpecific.version !== "assetfare-route-economic-guidance-v1" ||
    routeSpecific.url !== "https://assetfare.dev/route-economics.json" ||
    routeSpecific.required_on_every_quote !== true ||
    routeSpecific.controls_evaluation_start !== true
  ) throw new Error("assetfare_v2_economic_guidance_invalid");
}

function validateRouteEconomicGuidance(value: unknown): JsonRecord {
  let guidance: JsonRecord;
  try { guidance = record(value); }
  catch { throw new Error("assetfare_v2_economic_guidance_invalid"); }
  if (guidance.public_activation_status === "active_price_verified" || guidance.public_activation_status === "active_availability_only") {
    const price=guidance.public_activation_status === "active_price_verified";
    if (!exactKeys(guidance,TARGET_GUIDANCE_KEYS) || guidance.public_active!==true || guidance.recommendation_status!==guidance.public_activation_status || guidance.confidence!==(price?"paired_all_in_snapshot":"availability_only_no_price_claim") || guidance.tested_ceiling_usd!==10000 || !Array.isArray(guidance.tested_amounts_usd) || guidance.tested_amounts_usd.length!==8 || guidance.not_an_execution_minimum!==true || guidance.not_a_best_price_guarantee!==true || guidance.fresh_quote_required!==true || price!==guidance.best_from_verified || price===guidance.availability_only || guidance.advisory_start_usd!==guidance.best_from_usd || (price?!GUIDANCE_STARTS.has(guidance.advisory_start_usd as number):guidance.advisory_start_usd!==null) || (price?guidance.recommended_action!=="use_assetfare_first_at_or_above_best_from":guidance.recommended_action!=="use_assetfare_when_route_availability_is_required_without_price_claim")) throw new Error("assetfare_v2_economic_guidance_invalid");
    return guidance;
  }
  if (
    !exactKeys(guidance, GUIDANCE_KEYS) ||
    !GUIDANCE_STARTS.has(guidance.advisory_start_usd as number) ||
    !GUIDANCE_ROLES.has(guidance.advisory_role as string) ||
    !GUIDANCE_STATUSES.has(guidance.status as string) ||
    !GUIDANCE_CONFIDENCE.has(guidance.confidence as string) ||
    typeof guidance.basis !== "string" ||
    guidance.basis.length < 1 ||
    !Array.isArray(guidance.tested_amounts_usd) ||
    guidance.tested_amounts_usd.length > 8 ||
    !guidance.tested_amounts_usd.every((amount) => Number.isInteger(amount) && amount > 0) ||
    guidance.not_an_execution_minimum !== true ||
    guidance.not_a_best_price_guarantee !== true ||
    guidance.fresh_quote_required !== true
  ) throw new Error("assetfare_v2_economic_guidance_invalid");
  return guidance;
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

function buildDefinition(from: string, to: string, requestedMode?: unknown): RouteDefinition {
  const [fromChain, fromToken] = split(from);
  const [toChain, toToken] = split(to);
  const steps: StepDefinition[] = [];
  const add = (action: StepDefinition["action"], provider: StepDefinition["provider"], stepFrom: string, stepTo: string, fee: 0 | 1, external = false) => {
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

  if (fromChain === "aptos") {
    add("bridge", "circle_cctp", from, to, 1);
    return { classification: "direct_protocol_only", mode: "aptos_move_cctp_direct", steps };
  }

  if (fromChain === "polygon" || fromChain === "optimism") {
    add("bridge", "circle_cctp", from, to, 1);
    add("receive", "circle_cctp_receive", to, to, 0);
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
    if (requestedMode === "robinhood_across_ingress_composition") {
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
    if (fromChain === "solana") {
      if (fromToken === "SOL") addSwap("solana", "SOL", "USDC", 1);
      if (fromToken !== "USDG") addSwap("solana", "USDC", "USDG", fromToken === "USDC" ? 1 : 0);
      add("bridge", "paxos_usdg_layerzero_oft", "solana:USDG", "robinhood:USDG", fromToken === "USDG" && toToken === "USDG" ? 1 : 0);
      if (toToken === "ETH") addSwap("robinhood", "USDG", "ETH", fromToken === "USDG" ? 1 : 0);
    } else {
      if (fromToken === "ETH") addSwap(fromChain, "ETH", "USDC", 0);
      add("bridge", "circle_cctp", `${fromChain}:USDC`, "solana:USDC", 1);
      addSwap("solana", "USDC", "USDG", 0);
      add("bridge", "paxos_usdg_layerzero_oft", "solana:USDG", "robinhood:USDG", 0);
      if (toToken === "ETH") addSwap("robinhood", "USDG", "ETH", 0);
    }
    const base = Math.floor(50 / steps.length), remainder = 50 % steps.length;
    steps.forEach((step, index) => { step.minimum_guard_bps = base + (index < remainder ? 1 : 0); });
    return { classification: "direct_protocol_only", mode: "robinhood_paxos_ingress_composition", steps };
  }

  if (fromToken !== "USDC") addSwap(fromChain, fromToken, "USDC", 0);
  add("bridge", "circle_cctp", `${fromChain}:USDC`, `${toChain}:USDC`, 1);
  if (toToken !== "USDC") addSwap(toChain, "USDC", toToken, 0);
  return { classification: "direct_protocol_only", mode: "cctp_direct_composition", steps };
}

function rawStepKeys(definition: StepDefinition): string[] {
  const guard = definition.minimum_guard_bps === undefined ? [] : ["minimum_guard_bps"];
  if (SWAP_PROVIDERS.has(definition.provider)) return ["kind", "chain", "provider", "from", "to", "route_fee_bps", ...guard, ...ADDED_STEP_KEYS];
  if (definition.provider === "circle_cctp_receive") return ["kind", "provider", "chain", "from", "to", "source_chain", "cctp_mode", "destination_native_gas_required", "route_fee_bps", ...ADDED_STEP_KEYS];
  if (definition.provider === "across_intent_bridge") return ["kind", "provider", "from", "to", "from_asset", "to_asset", "external_intent_protocol", "route_fee_bps", ...ADDED_STEP_KEYS];
  const sourceOnly = definition.provider === "circle_cctp" && /^(polygon|optimism):/.test(definition.from);
  const candidateSource = definition.provider === "circle_cctp" && /^(xlayer|sei|sonic):/.test(definition.from);
  return ["kind", "provider", "from", "to", "asset", ...(sourceOnly ? ["cctp_mode", "finality_threshold", "destination_native_gas_required", "economics_informational_only"] : candidateSource?["finality_threshold"]:[]), "route_fee_bps", ...guard, ...ADDED_STEP_KEYS];
}

function rawEndpoints(raw: JsonRecord, definition: StepDefinition): [string, string] {
  if (SWAP_PROVIDERS.has(definition.provider)) return [`${raw.chain}:${raw.from}`, `${raw.chain}:${raw.to}`];
  if (definition.provider === "circle_cctp_receive") return [`${raw.chain}:${raw.from}`, `${raw.chain}:${raw.to}`];
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

function ceilGuardFloor(expected: string, guardBps: number): bigint {
  return (BigInt(expected) * (10_000n - BigInt(guardBps)) + 9_999n) / 10_000n;
}

/** Validate and canonicalize the intent-bound direct path before exposing a quote to an agent. */
export function validateQuoteDirectRoute(quote: JsonRecord, requested: DirectRouteIntent): JsonRecord {
  validateRouteEconomicGuidance(quote.economic_guidance);
  const summary = record(quote.direct_route_summary);
  const route = record(quote.route);
  const risk = record(quote.risk);
  const intent = record(quote.intent);
  const offer = record(quote.offer);
  const execution = record(quote.execution);
  rejectSensitive({ summary, route });
  const hasProductMetadata = PRODUCT_KEYS.every((key) => Object.hasOwn(summary, key)) && PRODUCT_KEYS.every((key) => Object.hasOwn(route, key));
  if (quote.status !== "capped_public_agent_release" || execution.supported !== true || !exactKeys(summary, hasProductMetadata ? ROOT_KEYS : LEGACY_ROOT_KEYS) || !exactKeys(route, hasProductMetadata ? ROUTE_KEYS : LEGACY_ROUTE_KEYS)) throw new Error("assetfare_v2_direct_route_shape_invalid");

  const expectedFrom = `${requested.fromChain}:${requested.fromToken}`;
  const expectedTo = `${requested.toChain}:${requested.toToken}`;
  if (intent.from !== expectedFrom || intent.to !== expectedTo || intent.amount_usd !== requested.amountUsd) throw new Error("assetfare_v2_direct_route_intent_invalid");
  const routeName = `${expectedFrom}->${expectedTo}`;
  const definition = buildDefinition(expectedFrom, expectedTo, summary.mode);
  if (summary.version !== "assetfare-direct-route-summary-v1" || summary.route !== routeName || summary.from !== expectedFrom || summary.to !== expectedTo || summary.mode !== definition.mode || summary.classification !== definition.classification) throw new Error("assetfare_v2_direct_route_binding_invalid");
  const external = definition.classification === "external_intent";
  const routeGuard = definition.steps.some((step) => step.minimum_guard_bps !== undefined) ? definition.steps.reduce((sum, step) => sum + (step.minimum_guard_bps ?? 0), 0) : null;
  const expectedProduct = external ? { product_classification: "external_coverage_only", economic_eligibility: "coverage_only_not_primary", public_execution_eligible: true, primary_selection_eligible: false, route_minimum_guard_bps: null } : { product_classification: "primary_direct", economic_eligibility: "not_asserted_by_capability", public_execution_eligible: true, primary_selection_eligible: true, route_minimum_guard_bps: routeGuard };
  if (hasProductMetadata && PRODUCT_KEYS.some((key) => summary[key] !== expectedProduct[key as keyof typeof expectedProduct] || route[key] !== expectedProduct[key as keyof typeof expectedProduct])) throw new Error("assetfare_v2_direct_route_product_metadata_invalid");
  if (summary.route_aggregator_used !== false || summary.external_intent_protocol_used !== external || summary.provider_internal_dex_aggregation_possible !== external || summary.assetfare_fee_bps !== 1 || summary.server_signing !== false || summary.server_submission !== false || summary.step_count !== definition.steps.length || !Array.isArray(summary.steps) || summary.steps.length !== definition.steps.length) throw new Error("assetfare_v2_direct_route_boundary_invalid");
  if (route.status !== "pass" || route.version !== "assetfare-direct-multichain-quote-v2" || route.route !== routeName || route.mode !== definition.mode || route.aggregator_api_used !== false || route.external_intent_protocol_used !== external || route.server_signing !== false || route.server_submission !== false || !Array.isArray(route.steps) || route.steps.length !== definition.steps.length) throw new Error("assetfare_v2_direct_route_raw_invalid");
  if (risk.external_intent_protocol_used !== external || risk.provider_internal_dex_aggregation_possible !== external || risk.server_signing !== false || risk.server_submission !== false) throw new Error("assetfare_v2_direct_route_risk_invalid");

  let expectedCursor: string | undefined;
  let minimumCursor: string | undefined;
  let feeSum = 0;
  let feeIndex = -1;
  let cumulativeGuard = 0;
  const safeSteps: JsonRecord[] = [];
  for (let index = 0; index < definition.steps.length; index += 1) {
    const expected = definition.steps[index];
    const step = record(summary.steps[index]);
    const raw = record(route.steps[index]);
    const stepKeys = expected.minimum_guard_bps === undefined ? STEP_KEYS : [...STEP_KEYS, "minimum_guard_bps"];
    if (!exactKeys(step, stepKeys) || !exactKeys(raw, rawStepKeys(expected))) throw new Error("assetfare_v2_direct_route_step_shape_invalid");
    for (const key of ["index", "action", "provider", "from", "to", "assetfare_fee_bps", "direct_protocol", "external_intent_protocol", ...(expected.minimum_guard_bps === undefined ? [] : ["minimum_guard_bps"])] as const) if (step[key] !== (expected as unknown as JsonRecord)[key]) throw new Error("assetfare_v2_direct_route_plan_invalid");
    if (step.aggregator_api_used !== false || raw.index !== index || raw.provider !== expected.provider || raw.route_fee_bps !== expected.assetfare_fee_bps) throw new Error("assetfare_v2_direct_route_step_invalid");
    const [rawFrom, rawTo] = rawEndpoints(raw, expected);
    const rawKind = expected.action === "swap" ? "direct_swap" : expected.action === "receive" ? "direct_receive" : "direct_bridge";
    if (raw.kind !== rawKind || rawFrom !== expected.from || rawTo !== expected.to || (expected.provider === "across_intent_bridge" ? raw.external_intent_protocol !== true : Object.hasOwn(raw, "external_intent_protocol"))) throw new Error("assetfare_v2_direct_route_raw_plan_invalid");
    if (expected.provider === "circle_cctp" && /^(polygon|optimism):/.test(expected.from) && !(raw.cctp_mode === "no_forward" && raw.finality_threshold === 2000 && raw.destination_native_gas_required === true && raw.economics_informational_only === true)) throw new Error("assetfare_v2_direct_route_source_only_invalid");
    if (expected.provider === "circle_cctp" && /^(xlayer|sei|sonic):/.test(expected.from) && raw.finality_threshold !== (expected.from.startsWith("xlayer:")?1000:2000)) throw new Error("assetfare_v2_direct_route_candidate_finality_invalid");
    if (expected.provider === "circle_cctp_receive" && !(raw.source_chain === requested.fromChain && raw.cctp_mode === "no_forward" && raw.destination_native_gas_required === true && raw.route_fee_bps === 0)) throw new Error("assetfare_v2_direct_route_receive_invalid");
    if (!evidenceValid(raw.expected_evidence) || (raw.floor_evidence !== null && !evidenceValid(raw.floor_evidence))) throw new Error("assetfare_v2_direct_route_evidence_invalid");
    const expectedInput = amount(step.expected_input_base);
    const minimumInput = amount(step.minimum_input_base);
    const expectedOutput = amount(step.expected_output_base);
    const minimumOutput = amount(step.minimum_output_base);
    if (BigInt(minimumOutput) > BigInt(expectedOutput) || (index > 0 && (expectedInput !== expectedCursor || minimumInput !== minimumCursor))) throw new Error("assetfare_v2_direct_route_continuity_invalid");
    if (expected.minimum_guard_bps !== undefined) {
      cumulativeGuard += expected.minimum_guard_bps;
      if (BigInt(minimumOutput) < ceilGuardFloor(expectedOutput, cumulativeGuard)) throw new Error("assetfare_v2_direct_route_component_guard_invalid");
    }
    if (![raw.expected_input_base, raw.floor_input_base, raw.expected_output_base, raw.minimum_output_base].every((value, offset) => rawNumberMatches(value, [expectedInput, minimumInput, expectedOutput, minimumOutput][offset]))) throw new Error("assetfare_v2_direct_route_amount_binding_invalid");
    expectedCursor = expectedOutput;
    minimumCursor = minimumOutput;
    feeSum += expected.assetfare_fee_bps;
    if (expected.assetfare_fee_bps === 1) feeIndex = index;
    safeSteps.push({ ...expected, expected_input_base: expectedInput, minimum_input_base: minimumInput, expected_output_base: expectedOutput, minimum_output_base: minimumOutput, aggregator_api_used: false });
  }

  if (routeGuard !== null && BigInt(minimumCursor!) < ceilGuardFloor(expectedCursor!, routeGuard)) throw new Error("assetfare_v2_direct_route_final_guard_invalid");
  if (!safeSteps.length || !rawNumberMatches(intent.estimated_input_base, safeSteps[0].expected_input_base as string) || !rawNumberMatches(route.input_base, safeSteps[0].expected_input_base as string) || safeSteps[0].minimum_input_base !== safeSteps[0].expected_input_base || !rawNumberMatches(route.expected_output_base, expectedCursor!) || !rawNumberMatches(route.minimum_output_base, minimumCursor!) || feeSum !== 1 || feeIndex !== summary.fee_collection_step_index || offer.assetfare_fee_bps !== 1 || offer.fee_modeled_bps !== 1 || offer.fee_collectible_now !== true || !Array.isArray(offer.fee_collection_steps) || offer.fee_collection_steps.length !== 1 || offer.fee_collection_steps[0] !== feeIndex) throw new Error("assetfare_v2_direct_route_fee_or_root_invalid");

  const canonicalSummary: JsonRecord = { version: "assetfare-direct-route-summary-v1", route: routeName, from: expectedFrom, to: expectedTo, classification: definition.classification, mode: definition.mode, ...(hasProductMetadata ? expectedProduct : {}), route_aggregator_used: false, external_intent_protocol_used: external, provider_internal_dex_aggregation_possible: external, assetfare_fee_bps: 1, fee_collection_step_index: feeIndex, server_signing: false, server_submission: false, step_count: safeSteps.length, steps: safeSteps };
  return { ...quote, direct_route_summary: canonicalSummary };
}
