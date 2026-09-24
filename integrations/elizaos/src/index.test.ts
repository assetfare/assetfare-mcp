import assert from "node:assert/strict";
import test from "node:test";
import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { AssetFareQuoteIntentSchema, createAssetFareElizaPlugin, validateQuoteDirectRoute } from "./index.js";
import { acrossIntent, acrossQuote, clone, solanaSolToBaseUsdcQuote, solanaUsdcToBaseUsdcQuote, solToBaseIntent } from "./directRoute.test-fixture.js";

const message = { content: { text: "Compare a USD 1,000 route from Solana native USDC to Base native USDC", source: "test" } } as Memory;
const state = { recentMessages: message.content.text } as unknown as State;

test("intent schema accepts the gap route and rejects unsupported inputs", () => {
  assert.equal(AssetFareQuoteIntentSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }).success, true);
  assert.equal(AssetFareQuoteIntentSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 2500.25 }).success, true);
  assert.equal(AssetFareQuoteIntentSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 0.99 }).success, false);
  assert.equal(AssetFareQuoteIntentSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: Number.NaN }).success, false);
  assert.equal(AssetFareQuoteIntentSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: Number.POSITIVE_INFINITY }).success, false);
  assert.equal(AssetFareQuoteIntentSchema.safeParse({ fromChain: "base", fromToken: "SOL", toChain: "solana", toToken: "USDC", amountUsd: 1 }).success, false);
  assert.equal(AssetFareQuoteIntentSchema.safeParse({ fromChain: "polygon", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd: 250 }).success, true);
  assert.equal(AssetFareQuoteIntentSchema.safeParse({ fromChain: "base", fromToken: "USDC", toChain: "optimism", toToken: "USDC", amountUsd: 250 }).success, false);
});

test("plugin exposes only read-only capability and quote actions", () => {
  const plugin = createAssetFareElizaPlugin({ fetch: async () => Response.json({}) });
  assert.deepEqual(plugin.actions?.map((action) => action.name), ["ASSETFARE_GET_CAPABILITIES", "ASSETFARE_QUOTE_ROUTE"]);
  assert.equal(plugin.actions?.some((action) => /sign|submit|execute|fund|swap|bridge_order/i.test(action.name)), false);
});

test("quote action sends five fields and never reads wallet settings", async () => {
  let observed: { url: string; init?: RequestInit } | undefined;
  const plugin = createAssetFareElizaPlugin({ fetch: async (input, init) => {
    observed = { url: String(input), init };
    return Response.json(solanaUsdcToBaseUsdcQuote());
  }});
  const runtime = new Proxy({
    composeState: async () => state,
    useModel: async () => ({ fromChain: "solana", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 1000 }),
  }, {
    get(target, property, receiver) {
      if (property === "getSetting") throw new Error("plugin must not read wallet settings");
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as IAgentRuntime;
  const responses: unknown[] = [];
  const callback: HandlerCallback = async (response) => { responses.push(response); return []; };
  const result = await plugin.actions?.[1].handler(runtime, message, state, {}, callback);
  assert.equal(result?.success, true);
  assert.equal(observed?.url, "https://api.assetfare.dev/v2/quote");
  assert.deepEqual(JSON.parse(String(observed?.init?.body)), { from_chain: "solana", from_token: "USDC", to_chain: "base", to_token: "USDC", amount_usd: 1000 });
  assert.equal(responses.length, 1);
  const guidance = (result?.data as { guidance?: Record<string, unknown> } | undefined)?.guidance;
  assert.equal(guidance?.oneDollarPurpose, "reachability_and_schema_smoke_only");
  assert.equal(guidance?.directRouteSummaryVerified, true);
  assert.equal(guidance?.nativeUsdcComparisonStartUsd, 50);
  assert.equal(guidance?.representativeComparisonAmountUsd, 1000);
  assert.equal(guidance?.cheapestGuaranteed, false);
  assert.equal(guidance?.compareAtIntendedAmount, true);
  assert.equal(guidance?.solInputIncludesSwap, false);
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

test("quote action fails closed if server submission is enabled", async () => {
  const plugin = createAssetFareElizaPlugin({ fetch: async () => Response.json({ status: "capped_public_agent_release", execution: { supported: true }, risk: { server_signing: false, server_submission: true }, offer: {} }) });
  const runtime = { composeState: async () => state, useModel: async () => ({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }) } as unknown as IAgentRuntime;
  const result = await plugin.actions?.[1].handler(runtime, message, state);
  assert.equal(result?.success, false);
  assert.match(String(result?.error), /safety boundary|Invalid input/);
});

test("invalid and oversized responses fail closed", async () => {
  const runtime = { composeState: async () => state, useModel: async () => ({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }) } as unknown as IAgentRuntime;
  const invalid = createAssetFareElizaPlugin({ fetch: async () => new Response("not-json", { status: 502 }) });
  assert.equal((await invalid.actions?.[1].handler(runtime, message, state))?.success, false);
  const oversized = createAssetFareElizaPlugin({ fetch: async () => new Response("x", { headers: { "content-length": "1048577" } }) });
  assert.equal((await oversized.actions?.[1].handler(runtime, message, state))?.success, false);
});
