import assert from "node:assert/strict";
import test from "node:test";
import { AssetFareQuoteSchema, assetFareTools, createAssetFareClient, validateQuoteDirectRoute } from "./index.js";
import { acrossIntent, acrossQuote, clone, solanaSolToBaseUsdcQuote, solToBaseIntent } from "./directRoute.test-fixture.js";

test("schema accepts the one-dollar roadmap route and rejects unsafe intent", () => {
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }).success, true);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 2500.25 }).success, true);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 0.99 }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: Number.NaN }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: Number.POSITIVE_INFINITY }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "base", fromToken: "SOL", toChain: "solana", toToken: "USDC", amountUsd: 1 }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "base", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 1 }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "optimism", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd: 250 }).success, true);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "base", fromToken: "USDC", toChain: "polygon", toToken: "USDC", amountUsd: 250 }).success, false);
});

test("client sends only the five public quote fields", async () => {
  let observed: { url: string; init?: RequestInit } | undefined;
  const client = createAssetFareClient({ fetch: async (input, init) => {
    observed = { url: String(input), init };
    return Response.json(solanaSolToBaseUsdcQuote(1));
  }});
  const quote = await client.quote({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 });
  assert.equal(observed?.url, "https://api.assetfare.dev/v2/quote");
  assert.equal(observed?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(observed?.init?.body)), { from_chain: "solana", from_token: "SOL", to_chain: "base", to_token: "USDC", amount_usd: 1 });
  assert.equal((quote.risk as Record<string, unknown>).server_submission, false);
  assert.equal((quote.direct_route_summary as any).steps[0].provider, "raydium_clmm");
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

test("Vercel tools add only capability and quote functions", () => {
  const tools = assetFareTools({ fetch: async () => Response.json({}) });
  assert.deepEqual(Object.keys(tools), ["assetfareGetCapabilities", "assetfareQuoteRoute"]);
  assert.equal(Object.keys(tools).some((name) => /sign|submit|execute|fund|bridge/i.test(name)), false);
  assert.equal("inputSchema" in tools.assetfareGetCapabilities, true);
  assert.equal("inputSchema" in tools.assetfareQuoteRoute, true);
});

test("client fails closed when server submission is enabled", async () => {
  const client = createAssetFareClient({ fetch: async () => Response.json({ status: "capped_public_agent_release", execution: { supported: true }, risk: { server_signing: false, server_submission: true }, offer: {} }) });
  await assert.rejects(client.quote({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }), /safety boundary/);
});

test("invalid and oversized responses fail closed", async () => {
  const invalid = createAssetFareClient({ fetch: async () => new Response("not-json", { status: 502 }) });
  await assert.rejects(invalid.quote({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }), /invalid JSON/);
  const oversized = createAssetFareClient({ fetch: async () => new Response("x", { headers: { "content-length": "1048577" } }) });
  await assert.rejects(oversized.quote({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }), /one-megabyte/);
});
