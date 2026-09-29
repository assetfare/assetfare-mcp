type JsonRecord = Record<string, any>;

const evidence = () => ({ status: "pass", inputAmount: "1000000", aggregatorApiUsed: false, signed: false, submitted: false });
const guidance = () => ({ advisory_start_usd: 1000, best_from_usd: 1000, best_from_verified: true, availability_only: false, public_activation_status: "active_price_verified", public_active: true, recommendation_status: "active_price_verified", recommended_action: "use_assetfare_first_at_or_above_best_from", confidence: "paired_all_in_snapshot", basis: "offline_fixture_only", tested_amounts_usd: [50,100,250,500,1000,2500,5000,10000], tested_ceiling_usd: 10000, not_an_execution_minimum: true, not_a_best_price_guarantee: true, fresh_quote_required: true });
const capabilityGuidance = () => ({ version: "assetfare-route-economic-guidance-v3", as_of: "2026-09-29", route_count: 90, public_active_route_count: 42, public_inactive_route_count: 48, verified_best_from_route_count: 40, availability_only_route_count: 2, currency: "USD", technical_quote_minimum_usd: 1, economic_guidance_is_non_enforcing: true, amount_is_never_rejected_by_economic_guidance: true, values_change_with_market: true, fresh_quote_and_caller_decision_control: true, update_policy: "daily_measurement_with_three_day_activation_hysteresis", first_use_zero_allowance_scenario: true, expected_output_ranking: true, incomplete_cost_never_promoted: true, tested_ceiling_usd: 10000, advisory_start_distribution: { "50": 8, "100": 3, "250": 3, "500": 6, "1000": 1, "2500": 4, "5000": 12, "10000": 3 }, recommendation_status_counts: { active_price_verified: 40, active_unique_availability: 2, inactive_economics: 48 } });

export function currentCapabilities(): JsonRecord {
  const economic = capabilityGuidance();
  return {
    public_api_enabled: true,
    directed_conversion_routes: 42,
    execution_implemented_routes: 42,
    server_signing: false,
    server_submission: false,
    economic_guidance: economic,
    route_product_policy: { active_route_count: 42, inactive_route_count: 48, inactive_routes: Array.from({length:48},(_,index)=>`inactive-${index}`), amount_conditioned_routes: Object.fromEntries(Array.from({length:40},(_,index)=>[`active-${index}`,50])), economic_guidance: clone(economic), economic_guidance_url: "https://assetfare.dev/route-economics.json" },
    evaluation_guidance: { schema_version: 4, route_specific_guidance: { version: "assetfare-route-economic-guidance-v3", url: "https://assetfare.dev/route-economics.json", required_on_every_quote: true, verified_best_from_only: true, nullable_when_unverified: true, controls_recommendation_only_when_verified: true, values_change_with_market: true, catalog_routes: 90, public_active_routes: 42, public_inactive_routes: 48, availability_only_routes: 2 } },
  };
}

export const solToBaseIntent = { fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 300 } as const;
export const usdcToBaseIntent = { fromChain: "solana", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 1000 } as const;
export const acrossIntent = { fromChain: "base", fromToken: "USDC", toChain: "robinhood", toToken: "USDG", amountUsd: 300 } as const;
export const expansionIntent = { fromChain: "ethereum", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 500 } as const;

export function solanaSolToBaseUsdcQuote(amountUsd = 300): JsonRecord {
  const steps = [
    {
      index: 0, action: "swap", provider: "raydium_clmm", from: "solana:SOL", to: "solana:USDC",
      expected_input_base: "1000000", minimum_input_base: "1000000", expected_output_base: "900000", minimum_output_base: "899000",
      assetfare_fee_bps: 0, direct_protocol: true, external_intent_protocol: false, aggregator_api_used: false,
    },
    {
      index: 1, action: "bridge", provider: "circle_cctp", from: "solana:USDC", to: "base:USDC",
      expected_input_base: "900000", minimum_input_base: "899000", expected_output_base: "899000", minimum_output_base: "898000",
      assetfare_fee_bps: 1, direct_protocol: true, external_intent_protocol: false, aggregator_api_used: false,
    },
  ];
  const rawSteps = [
    {
      kind: "direct_swap", chain: "solana", provider: "raydium_clmm", from: "SOL", to: "USDC", route_fee_bps: 0, index: 0,
      expected_input_base: 1000000, floor_input_base: 1000000, expected_output_base: 900000, minimum_output_base: 899000,
      expected_evidence: evidence(), floor_evidence: null,
    },
    {
      kind: "direct_bridge", provider: "circle_cctp", from: "solana", to: "base", asset: "USDC", route_fee_bps: 1, index: 1,
      expected_input_base: 900000, floor_input_base: 899000, expected_output_base: 899000, minimum_output_base: 898000,
      expected_evidence: evidence(), floor_evidence: null,
    },
  ];
  return {
    status: "capped_public_agent_release",
    economic_guidance: guidance(),
    execution: { supported: true },
    intent: { from: "solana:SOL", to: "base:USDC", amount_usd: amountUsd, estimated_input_base: 1000000 },
    risk: { external_intent_protocol_used: false, provider_internal_dex_aggregation_possible: false, server_signing: false, server_submission: false },
    offer: { assetfare_fee_bps: 1, fee_modeled_bps: 1, fee_collectible_now: true, fee_collection_steps: [1] },
    route: { status: "pass", version: "assetfare-direct-multichain-quote-v2", route: "solana:SOL->base:USDC", mode: "cctp_direct_composition", input_base: 1000000, expected_output_base: 899000, minimum_output_base: 898000, steps: rawSteps, quote_latency_ms: 1, aggregator_api_used: false, external_intent_protocol_used: false, server_signing: false, server_submission: false },
    direct_route_summary: { version: "assetfare-direct-route-summary-v1", route: "solana:SOL->base:USDC", from: "solana:SOL", to: "base:USDC", classification: "direct_protocol_only", mode: "cctp_direct_composition", route_aggregator_used: false, external_intent_protocol_used: false, provider_internal_dex_aggregation_possible: false, assetfare_fee_bps: 1, fee_collection_step_index: 1, server_signing: false, server_submission: false, step_count: 2, steps },
  };
}

export function solanaUsdcToBaseUsdcQuote(amountUsd = 1000): JsonRecord {
  const quote = solanaSolToBaseUsdcQuote(amountUsd);
  quote.intent = { from: "solana:USDC", to: "base:USDC", amount_usd: amountUsd, estimated_input_base: 1000000 };
  quote.route.route = "solana:USDC->base:USDC";
  quote.route.input_base = 1000000;
  quote.route.expected_output_base = 999000;
  quote.route.minimum_output_base = 998000;
  quote.route.steps = [{ kind: "direct_bridge", provider: "circle_cctp", from: "solana", to: "base", asset: "USDC", route_fee_bps: 1, index: 0, expected_input_base: 1000000, floor_input_base: 1000000, expected_output_base: 999000, minimum_output_base: 998000, expected_evidence: evidence(), floor_evidence: null }];
  quote.offer.fee_collection_steps = [0];
  quote.direct_route_summary = { version: "assetfare-direct-route-summary-v1", route: "solana:USDC->base:USDC", from: "solana:USDC", to: "base:USDC", classification: "direct_protocol_only", mode: "cctp_direct_composition", route_aggregator_used: false, external_intent_protocol_used: false, provider_internal_dex_aggregation_possible: false, assetfare_fee_bps: 1, fee_collection_step_index: 0, server_signing: false, server_submission: false, step_count: 1, steps: [{ index: 0, action: "bridge", provider: "circle_cctp", from: "solana:USDC", to: "base:USDC", expected_input_base: "1000000", minimum_input_base: "1000000", expected_output_base: "999000", minimum_output_base: "998000", assetfare_fee_bps: 1, direct_protocol: true, external_intent_protocol: false, aggregator_api_used: false }] };
  return quote;
}

export function acrossQuote(): JsonRecord {
  return {
    status: "capped_public_agent_release",
    economic_guidance: guidance(),
    execution: { supported: true },
    intent: { from: "base:USDC", to: "robinhood:USDG", amount_usd: 300, estimated_input_base: 1000000 },
    risk: { external_intent_protocol_used: true, provider_internal_dex_aggregation_possible: true, server_signing: false, server_submission: false },
    offer: { assetfare_fee_bps: 1, fee_modeled_bps: 1, fee_collectible_now: true, fee_collection_steps: [0] },
    route: { status: "pass", version: "assetfare-direct-multichain-quote-v2", route: "base:USDC->robinhood:USDG", mode: "robinhood_across_ingress_composition", input_base: 1000000, expected_output_base: 999000, minimum_output_base: 998000, steps: [{ kind: "direct_bridge", provider: "across_intent_bridge", from: "base", to: "robinhood", from_asset: "USDC", to_asset: "USDG", external_intent_protocol: true, route_fee_bps: 1, index: 0, expected_input_base: 1000000, floor_input_base: 1000000, expected_output_base: 999000, minimum_output_base: 998000, expected_evidence: evidence(), floor_evidence: null }], quote_latency_ms: 1, aggregator_api_used: false, external_intent_protocol_used: true, server_signing: false, server_submission: false },
    direct_route_summary: { version: "assetfare-direct-route-summary-v1", route: "base:USDC->robinhood:USDG", from: "base:USDC", to: "robinhood:USDG", classification: "external_intent", mode: "robinhood_across_ingress_composition", route_aggregator_used: false, external_intent_protocol_used: true, provider_internal_dex_aggregation_possible: true, assetfare_fee_bps: 1, fee_collection_step_index: 0, server_signing: false, server_submission: false, step_count: 1, steps: [{ index: 0, action: "bridge", provider: "across_intent_bridge", from: "base:USDC", to: "robinhood:USDG", expected_input_base: "1000000", minimum_input_base: "1000000", expected_output_base: "999000", minimum_output_base: "998000", assetfare_fee_bps: 1, direct_protocol: false, external_intent_protocol: true, aggregator_api_used: false }] },
  };
}

export function expansionQuote(): JsonRecord {
  const product = { product_classification: "primary_direct", economic_eligibility: "not_asserted_by_capability", public_execution_eligible: true, primary_selection_eligible: true, route_minimum_guard_bps: null };
  const step = { index: 0, action: "bridge", provider: "circle_cctp", from: "ethereum:USDC", to: "base:USDC", expected_input_base: "500000000", minimum_input_base: "500000000", expected_output_base: "499950000", minimum_output_base: "499900000", assetfare_fee_bps: 1, direct_protocol: true, external_intent_protocol: false, aggregator_api_used: false };
  const rawStep = { kind: "direct_bridge", provider: "circle_cctp", from: "ethereum", to: "base", asset: "USDC", route_fee_bps: 1, index: 0, expected_input_base: 500000000, floor_input_base: 500000000, expected_output_base: 499950000, minimum_output_base: 499900000, expected_evidence: evidence(), floor_evidence: null };
  return {
    status: "capped_public_agent_release",
    economic_guidance: guidance(),
    execution: { supported: true },
    intent: { from: "ethereum:USDC", to: "base:USDC", amount_usd: 500, estimated_input_base: 500000000 },
    risk: { external_intent_protocol_used: false, provider_internal_dex_aggregation_possible: false, server_signing: false, server_submission: false },
    offer: { assetfare_fee_bps: 1, fee_modeled_bps: 1, fee_collectible_now: true, fee_collection_steps: [0] },
    route: { status: "pass", version: "assetfare-direct-multichain-quote-v2", route: "ethereum:USDC->base:USDC", mode: "cctp_direct_composition", ...product, input_base: 500000000, expected_output_base: 499950000, minimum_output_base: 499900000, steps: [rawStep], quote_latency_ms: 1, aggregator_api_used: false, external_intent_protocol_used: false, server_signing: false, server_submission: false },
    direct_route_summary: { version: "assetfare-direct-route-summary-v1", route: "ethereum:USDC->base:USDC", from: "ethereum:USDC", to: "base:USDC", classification: "direct_protocol_only", mode: "cctp_direct_composition", ...product, route_aggregator_used: false, external_intent_protocol_used: false, provider_internal_dex_aggregation_possible: false, assetfare_fee_bps: 1, fee_collection_step_index: 0, server_signing: false, server_submission: false, step_count: 1, steps: [step] },
  };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
