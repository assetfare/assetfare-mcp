import assert from "node:assert/strict";
import test from "node:test";
import type { HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import { AssetFareQuoteIntentSchema, createAssetFareElizaPlugin } from "./index.js";

const message = { content: { text: "Compare a $1 route from Solana SOL to Base USDC", source: "test" } } as Memory;
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
    return Response.json({ status: "capped_public_agent_release", execution: { supported: true }, risk: { server_signing: false, server_submission: false }, offer: { expected_receive_usd: 0.98 } });
  }});
  const runtime = new Proxy({
    composeState: async () => state,
    useModel: async () => ({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }),
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
  assert.deepEqual(JSON.parse(String(observed?.init?.body)), { from_chain: "solana", from_token: "SOL", to_chain: "base", to_token: "USDC", amount_usd: 1 });
  assert.equal(responses.length, 1);
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
