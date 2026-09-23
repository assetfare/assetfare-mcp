import assert from "node:assert/strict";
import test from "node:test";
import { AssetFareActionProvider } from "./assetFareActionProvider.js";
import { AssetFareQuoteSchema } from "./schemas.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("quote schema accepts supported non-identity intent and rejects invalid inputs", () => {
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 300 }).success, true);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }).success, true);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "optimism", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 250 }).success, true);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "base", fromToken: "USDC", toChain: "polygon", toToken: "USDC", amountUsd: 250 }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "base", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 300 }).success, false);
  assert.equal(AssetFareQuoteSchema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 0.99 }).success, false);
});

test("capabilities action enforces the non-custodial public boundary", async () => {
  const calls: string[] = [];
  const fetchMock: typeof fetch = async input => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v2/capabilities")) return response({ public_api_enabled: true, server_signing: false, server_submission: false, directed_conversion_routes: 76, execution_implemented_routes: 76 });
    if (url.endsWith("/v2/status")) return response({ status: "capped_public_agent_release", server_signing: false, server_submission: false });
    return response({ error: "not_found" }, 404);
  };
  const provider = new AssetFareActionProvider({ apiBaseUrl: "https://unit.test", fetch: fetchMock });
  const result = JSON.parse(await provider.getCapabilities({}));
  assert.equal(result.success, true);
  assert.deepEqual(calls.sort(), ["https://unit.test/v2/capabilities", "https://unit.test/v2/status"]);
});

test("quote action sends only the five quote fields and creates no execution state", async () => {
  let observed: { url: string; init?: RequestInit } | undefined;
  const fetchMock: typeof fetch = async (input, init) => {
    observed = { url: String(input), init };
    return response({
      status: "capped_public_agent_release",
      offer: { expected_receive_amount: 299, estimated_min_receive_amount: 294, output_symbol: "USDC" },
      risk: { non_atomic: true, server_signing: false, server_submission: false },
      execution: { supported: true },
    });
  };
  const provider = new AssetFareActionProvider({ apiBaseUrl: "https://unit.test", fetch: fetchMock });
  const result = JSON.parse(await provider.quoteRoute({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 300 }));
  assert.equal(observed?.url, "https://unit.test/v2/quote");
  assert.deepEqual(JSON.parse(String(observed?.init?.body)), { from_chain: "solana", from_token: "SOL", to_chain: "base", to_token: "USDC", amount_usd: 300 });
  assert.equal(result.success, true);
  assert.equal(result.agent_guidance.wallet_authentication_performed, false);
  assert.equal(result.agent_guidance.session_created, false);
  assert.equal(result.agent_guidance.action_prepared, false);
  assert.equal(result.agent_guidance.transaction_signed, false);
  assert.equal(result.agent_guidance.transaction_submitted, false);
});

test("quote action fails closed when server signing or submission is enabled", async () => {
  const fetchMock: typeof fetch = async () => response({
    status: "capped_public_agent_release",
    risk: { server_signing: true, server_submission: false },
    execution: { supported: true },
  });
  const provider = new AssetFareActionProvider({ fetch: fetchMock });
  await assert.rejects(
    provider.quoteRoute({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "ETH", amountUsd: 300 }),
    /outside the capped public safety boundary/,
  );
});
