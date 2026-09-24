import assert from "node:assert/strict";
import test from "node:test";
import { AssetFareService } from "./assetfare.service.js";
import { acrossIntent, acrossQuote, clone, solanaSolToBaseUsdcQuote, solToBaseIntent } from "./directRoute.test-fixture.js";
import { validateQuoteDirectRoute } from "./directRouteSummary.js";
import { AssetFareNoParams, AssetFareQuoteParameters } from "./parameters.js";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("quote parameter model enforces finite, minimum-one, non-identity intents", () => {
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 300 }).success, true);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }).success, true);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 2500.25 }).success, true);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "polygon", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd: 250 }).success, true);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "base", fromToken: "USDC", toChain: "optimism", toToken: "USDC", amountUsd: 250 }).success, false);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 0.99 }).success, false);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: Number.NaN }).success, false);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: Number.POSITIVE_INFINITY }).success, false);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "base", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 300 }).success, false);
});

test("capabilities tool checks public non-custodial status", async () => {
  const calls: string[] = [];
  const fetchMock: typeof fetch = async input => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v2/capabilities")) return response({ public_api_enabled: true, server_signing: false, server_submission: false, directed_conversion_routes: 76, execution_implemented_routes: 76 });
    if (url.endsWith("/v2/status")) return response({ status: "capped_public_agent_release", server_signing: false, server_submission: false });
    return response({ error: "not_found" }, 404);
  };
  const service = new AssetFareService("https://unit.test", fetchMock);
  const result = await service.getCapabilities({} as AssetFareNoParams);
  assert.equal(result.success, true);
  assert.deepEqual(calls.sort(), ["https://unit.test/v2/capabilities", "https://unit.test/v2/status"]);
});

test("quote tool sends only public quote fields and does not create execution state", async () => {
  let body = "";
  const fetchMock: typeof fetch = async (_input, init) => {
    body = String(init?.body);
    return response(solanaSolToBaseUsdcQuote());
  };
  const service = new AssetFareService("https://unit.test", fetchMock);
  const result = await service.quoteRoute({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 300 } as AssetFareQuoteParameters);
  assert.deepEqual(JSON.parse(body), { from_chain: "solana", from_token: "SOL", to_chain: "base", to_token: "USDC", amount_usd: 300 });
  assert.equal(result.success, true);
  assert.equal((result.quote.direct_route_summary as any).steps[0].provider, "raydium_clmm");
  assert.equal(result.agentGuidance.directRouteSummaryVerified, true);
  assert.equal(result.agentGuidance.walletAuthenticationPerformed, false);
  assert.equal(result.agentGuidance.sessionCreated, false);
  assert.equal(result.agentGuidance.actionPrepared, false);
  assert.equal(result.agentGuidance.transactionSigned, false);
  assert.equal(result.agentGuidance.transactionSubmitted, false);
});

test("direct route contract rejects provider, amount, fee, aggregator, and private-field hostiles", () => {
  const mutations: Array<(quote: any) => void> = [
    quote => { quote.direct_route_summary.steps[0].provider = "unknown_provider"; quote.route.steps[0].provider = "unknown_provider"; },
    quote => { quote.direct_route_summary.steps[0].provider = "uniswap_v3"; quote.route.steps[0].provider = "uniswap_v3"; },
    quote => { quote.direct_route_summary.steps[1].expected_input_base = "900001"; quote.route.steps[1].expected_input_base = 900001; },
    quote => { quote.direct_route_summary.fee_collection_step_index = 0; },
    quote => { quote.direct_route_summary.route_aggregator_used = true; },
    quote => { quote.direct_route_summary.steps[0].aggregator_api_used = true; },
    quote => { quote.direct_route_summary.private_key = "forbidden"; },
  ];
  assert.equal((validateQuoteDirectRoute(solanaSolToBaseUsdcQuote(), solToBaseIntent).direct_route_summary as any).fee_collection_step_index, 1);
  for (const mutate of mutations) { const hostile = clone(solanaSolToBaseUsdcQuote()); mutate(hostile); assert.throws(() => validateQuoteDirectRoute(hostile, solToBaseIntent)); }
});

test("Across ingress is external_intent and cannot be relabeled false-direct", () => {
  assert.equal((validateQuoteDirectRoute(acrossQuote(), acrossIntent).direct_route_summary as any).classification, "external_intent");
  const hostile = clone(acrossQuote());
  hostile.direct_route_summary.classification = "direct_protocol_only";
  hostile.direct_route_summary.external_intent_protocol_used = false;
  hostile.direct_route_summary.provider_internal_dex_aggregation_possible = false;
  hostile.route.external_intent_protocol_used = false;
  hostile.risk.external_intent_protocol_used = false;
  hostile.risk.provider_internal_dex_aggregation_possible = false;
  assert.throws(() => validateQuoteDirectRoute(hostile, acrossIntent));
});

test("quote tool fails closed if the server boundary changes", async () => {
  const service = new AssetFareService("https://unit.test", (async () => response({ status: "capped_public_agent_release", risk: { server_signing: true, server_submission: false }, execution: { supported: true } })) as typeof fetch);
  await assert.rejects(
    service.quoteRoute({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "ETH", amountUsd: 300 } as AssetFareQuoteParameters),
    /outside the public safety boundary/,
  );
});
