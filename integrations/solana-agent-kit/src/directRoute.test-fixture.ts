type JsonRecord = Record<string, any>;

const evidence = () => ({ status: "pass", inputAmount: "1000000", aggregatorApiUsed: false, signed: false, submitted: false });

export const solToBaseIntent = { fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 300 } as const;
export const usdcToBaseIntent = { fromChain: "solana", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 1000 } as const;
export const acrossIntent = { fromChain: "base", fromToken: "USDC", toChain: "robinhood", toToken: "USDG", amountUsd: 300 } as const;

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
    execution: { supported: true },
    intent: { from: "base:USDC", to: "robinhood:USDG", amount_usd: 300, estimated_input_base: 1000000 },
    risk: { external_intent_protocol_used: true, provider_internal_dex_aggregation_possible: true, server_signing: false, server_submission: false },
    offer: { assetfare_fee_bps: 1, fee_modeled_bps: 1, fee_collectible_now: true, fee_collection_steps: [0] },
    route: { status: "pass", version: "assetfare-direct-multichain-quote-v2", route: "base:USDC->robinhood:USDG", mode: "robinhood_across_ingress_composition", input_base: 1000000, expected_output_base: 999000, minimum_output_base: 998000, steps: [{ kind: "direct_bridge", provider: "across_intent_bridge", from: "base", to: "robinhood", from_asset: "USDC", to_asset: "USDG", external_intent_protocol: true, route_fee_bps: 1, index: 0, expected_input_base: 1000000, floor_input_base: 1000000, expected_output_base: 999000, minimum_output_base: 998000, expected_evidence: evidence(), floor_evidence: null }], quote_latency_ms: 1, aggregator_api_used: false, external_intent_protocol_used: true, server_signing: false, server_submission: false },
    direct_route_summary: { version: "assetfare-direct-route-summary-v1", route: "base:USDC->robinhood:USDG", from: "base:USDC", to: "robinhood:USDG", classification: "external_intent", mode: "robinhood_across_ingress_composition", route_aggregator_used: false, external_intent_protocol_used: true, provider_internal_dex_aggregation_possible: true, assetfare_fee_bps: 1, fee_collection_step_index: 0, server_signing: false, server_submission: false, step_count: 1, steps: [{ index: 0, action: "bridge", provider: "across_intent_bridge", from: "base:USDC", to: "robinhood:USDG", expected_input_base: "1000000", minimum_input_base: "1000000", expected_output_base: "999000", minimum_output_base: "998000", assetfare_fee_bps: 1, direct_protocol: false, external_intent_protocol: true, aggregator_api_used: false }] },
  };
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}
