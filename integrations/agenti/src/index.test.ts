import assert from "node:assert/strict";
import test from "node:test";
import { AssetFareQuoteSchema, assetFareTools, createAssetFareClient } from "./index.js";

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
    return Response.json({ status: "capped_public_agent_release", execution: { supported: true }, risk: { server_signing: false, server_submission: false }, offer: { expected_receive_usd: 0.98 } });
  }});
  const quote = await client.quote({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 });
  assert.equal(observed?.url, "https://api.assetfare.dev/v2/quote");
  assert.equal(observed?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(observed?.init?.body)), { from_chain: "solana", from_token: "SOL", to_chain: "base", to_token: "USDC", amount_usd: 1 });
  assert.equal(quote.risk.server_submission, false);
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
