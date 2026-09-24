import assert from "node:assert/strict";
import test from "node:test";
import type { SolanaAgentKit } from "solana-agent-kit";
import { AssetFareQuoteSchema, createAssetFarePlugin } from "./index.js";

const inaccessibleAgent = new Proxy({}, {
  get() { throw new Error("read-only actions must not access the agent wallet"); },
}) as SolanaAgentKit;

test("schema accepts finite amounts at or above one and rejects unsafe values", () => {
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }).success, true);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 0.99 }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 2500.25 }).success, true);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: Number.NaN }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: Number.POSITIVE_INFINITY }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "base", fromToken: "SOL", toChain: "solana", toToken: "USDC", amountUsd: 1 }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "base", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 1 }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "optimism", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 250 }).success, true);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "base", fromToken: "USDC", toChain: "polygon", toToken: "USDC", amountUsd: 250 }).success, false);
});

test("plugin exposes only capability and quote actions", () => {
  const plugin = createAssetFarePlugin({ fetch: async () => new Response("{}") });
  assert.deepEqual(plugin.actions.map((action) => action.name), ["ASSETFARE_GET_CAPABILITIES", "ASSETFARE_QUOTE_ROUTE"]);
  assert.equal(plugin.actions.some((action) => /EXECUTE|SUBMIT|SIGN|BRIDGE_ORDER/.test(action.name)), false);
});

test("quote posts exactly five public fields without reading the wallet", async () => {
  let observed: { url: string; init?: RequestInit } | undefined;
  const plugin = createAssetFarePlugin({
    fetch: async (input, init) => {
      observed = { url: String(input), init };
      return Response.json({
        status: "capped_public_agent_release",
        execution: { supported: true },
        risk: { server_signing: false, server_submission: false },
        offer: { expected_receive_usd: 0.98, estimated_min_receive_usd: 0.95 },
      });
    },
  });
  const quote = plugin.actions[1];
  const result = await quote.handler(inaccessibleAgent, { fromChain: "solana", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 1000 });
  assert.equal(observed?.url, "https://api.assetfare.dev/v2/quote");
  assert.equal(observed?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(observed?.init?.body)), { from_chain: "solana", from_token: "USDC", to_chain: "base", to_token: "USDC", amount_usd: 1000 });
  const guidance = result.agentGuidance as Record<string, unknown>;
  assert.equal(guidance.transactionSubmitted, false);
  assert.equal(guidance.oneDollarPurpose, "reachability_and_schema_smoke_only");
  assert.equal(guidance.nativeUsdcComparisonStartUsd, 50);
  assert.equal(guidance.representativeComparisonAmountUsd, 1000);
  assert.equal(guidance.cheapestGuaranteed, false);
  assert.equal(guidance.compareAtIntendedAmount, true);
  assert.equal(guidance.solInputIncludesSwap, false);
});

test("capabilities fail closed if the server can submit", async () => {
  const plugin = createAssetFarePlugin({
    fetch: async (input) => String(input).endsWith("/v2/capabilities")
      ? Response.json({ public_api_enabled: true, server_signing: false, server_submission: false, directed_conversion_routes: 76, execution_implemented_routes: 76 })
      : Response.json({ status: "capped_public_agent_release", server_signing: false, server_submission: true }),
  });
  await assert.rejects(plugin.actions[0].handler(inaccessibleAgent, {}), /safety boundary/);
});

test("invalid JSON is wrapped and fails closed", async () => {
  const plugin = createAssetFarePlugin({ fetch: async () => new Response("not-json", { status: 502 }) });
  await assert.rejects(plugin.actions[1].handler(inaccessibleAgent, { fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }), /invalid JSON for HTTP 502/);
});

test("oversized responses fail before parsing", async () => {
  const plugin = createAssetFarePlugin({ fetch: async () => new Response("x", { headers: { "content-length": "1048577" } }) });
  await assert.rejects(plugin.actions[1].handler(inaccessibleAgent, { fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }), /one-megabyte safety limit/);
});
