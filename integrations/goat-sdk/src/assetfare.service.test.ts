import assert from "node:assert/strict";
import test from "node:test";
import { AssetFareService } from "./assetfare.service.js";
import { AssetFareNoParams, AssetFareQuoteParameters } from "./parameters.js";

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("quote parameter model enforces capped non-identity intents", () => {
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 300 }).success, true);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 }).success, true);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "polygon", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd: 250 }).success, true);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "base", fromToken: "USDC", toChain: "optimism", toToken: "USDC", amountUsd: 250 }).success, false);
  assert.equal(AssetFareQuoteParameters.schema.safeParse({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 0.99 }).success, false);
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
    return response({
      status: "capped_public_agent_release",
      offer: { expected_receive_amount: 299, estimated_min_receive_amount: 294, output_symbol: "USDC" },
      risk: { non_atomic: true, server_signing: false, server_submission: false },
      execution: { supported: true },
    });
  };
  const service = new AssetFareService("https://unit.test", fetchMock);
  const result = await service.quoteRoute({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 300 } as AssetFareQuoteParameters);
  assert.deepEqual(JSON.parse(body), { from_chain: "solana", from_token: "SOL", to_chain: "base", to_token: "USDC", amount_usd: 300 });
  assert.equal(result.success, true);
  assert.equal(result.agentGuidance.walletAuthenticationPerformed, false);
  assert.equal(result.agentGuidance.sessionCreated, false);
  assert.equal(result.agentGuidance.actionPrepared, false);
  assert.equal(result.agentGuidance.transactionSigned, false);
  assert.equal(result.agentGuidance.transactionSubmitted, false);
});

test("quote tool fails closed if the server boundary changes", async () => {
  const service = new AssetFareService("https://unit.test", (async () => response({ status: "capped_public_agent_release", risk: { server_signing: true, server_submission: false }, execution: { supported: true } })) as typeof fetch);
  await assert.rejects(
    service.quoteRoute({ fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "ETH", amountUsd: 300 } as AssetFareQuoteParameters),
    /outside the capped public safety boundary/,
  );
});
