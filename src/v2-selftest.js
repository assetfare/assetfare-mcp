#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { V2_MAX_RESPONSE_BYTES, V2_TIMEOUT_MS, createServer, serverCard } from "./server.js";

const ENDPOINTS = [
  ["solana", "SOL"], ["solana", "USDC"], ["solana", "USDG"],
  ["base", "ETH"], ["base", "USDC"],
  ["arbitrum", "ETH"], ["arbitrum", "USDC"],
  ["robinhood", "ETH"], ["robinhood", "USDG"],
];
const EXPECTED_KEYWORDS = ["ai-agents", "route-quotes", "cross-chain", "bridge", "swap", "solana", "base", "arbitrum", "robinhood-chain", "mcp", "a2a", "openapi", "non-custodial"];
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const lockMetadata = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const registryMetadata = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8"));
assert.equal(packageMetadata.version, "0.4.1");
assert.equal(lockMetadata.version, "0.4.1");
assert.equal(lockMetadata.packages[""].version, "0.4.1");
assert.equal(registryMetadata.version, "0.4.1");
assert.deepEqual(packageMetadata.keywords, EXPECTED_KEYWORDS);
assert.ok(registryMetadata.description.length <= 100);
assert.match(registryMetadata.description, /Solana.*Base.*Arbitrum.*Robinhood/);
assert.doesNotMatch(registryMetadata.description, /best|leading|fastest|cheapest/i);

function importedV2Base(extraEnvironment) {
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "--eval",
    "import('./src/server.js').then((module) => process.stdout.write(module.V2_API_BASE))",
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      ASSETFARE_API_BASE_URL: "http://127.0.0.1:8788",
      ASSETFARE_A2A_API_BASE_URL: "http://127.0.0.1:8791",
      ...extraEnvironment,
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

assert.equal(importedV2Base({ ASSETFARE_V2_API_BASE_URL: "" }), "http://127.0.0.1:8791");
assert.equal(importedV2Base({ ASSETFARE_V2_API_BASE_URL: "http://127.0.0.1:8792/" }), "http://127.0.0.1:8792");

function capabilities(overrides = {}) {
  return {
    version: "assetfare-multichain-api-v2",
    status: "capped_public_agent_release",
    public_api_enabled: true,
    chains: ["arbitrum", "base", "robinhood", "solana"],
    asset_endpoints: ENDPOINTS.map(([chain, token]) => ({ chain, token })),
    directed_conversion_routes: 72,
    unsigned_route_plans_ready: 72,
    server_signing: false,
    server_submission: false,
    ...overrides,
  };
}

function quote(intent, overrides = {}) {
  return {
    quote_id: "00000000-0000-4000-8000-000000000001",
    status: "capped_public_agent_release",
    as_of: "2026-09-17T00:00:00Z",
    ttl_seconds: 20,
    intent: { from: `${intent.from_chain}:${intent.from_token}`, to: `${intent.to_chain}:${intent.to_token}`, amount_usd: intent.amount_usd, estimated_input_base: 2_500_000 },
    offer: { expected_receive_amount: 2.49, estimated_min_receive_amount: 2.45, output_symbol: intent.to_token, estimated_time_seconds: 23, assetfare_fee_bps: 1, fee_collection_steps: [0] },
    route: { steps: [{ index: 0, provider: "fixture" }], server_signing: false, server_submission: false },
    risk: { non_atomic: true, server_signing: false, server_submission: false },
    execution: { supported: true },
    ...overrides,
  };
}

function parse(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.ok(text, "tool returned no text content");
  return JSON.parse(text);
}

async function call(client, name, args) {
  return client.callTool({ name, arguments: args });
}

function normalizedInputSchema(schema) {
  const value = structuredClone(schema);
  delete value.$schema;
  value.required ||= [];
  return value;
}

const originalFetch = globalThis.fetch;
const calls = [];
let mode = "success";
const validIntent = { from_chain: "robinhood", from_token: "USDG", to_chain: "solana", to_token: "USDC", amount_usd: 2.5 };

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), init });
  if (mode === "network") throw new Error("secret network detail");
  if (mode === "oversized") return new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": String(V2_MAX_RESPONSE_BYTES + 1) } });
  if (mode === "invalid-json") return new Response("<secret>", { status: 200, headers: { "content-type": "text/html" } });
  if (mode === "wrong-content-type") return new Response(JSON.stringify(quote(validIntent)), { status: 200, headers: { "content-type": "text/plain" } });
  if (mode === "unsafe-error") return new Response(JSON.stringify({ error: "SECRET leak\n", reason_class: "unsafe detail!", retry_after_seconds: 99999 }), { status: 502, headers: { "content-type": "application/json" } });
  if (String(url).endsWith("/v2/capabilities")) return Response.json(mode === "unsafe-capabilities" ? capabilities({ server_submission: true }) : capabilities());
  if (String(url).endsWith("/v2/quote")) {
    const intent = JSON.parse(String(init.body));
    return Response.json(mode === "unsafe-quote" ? quote(intent, { risk: { server_signing: true, server_submission: false } }) : quote(intent));
  }
  throw new Error(`unexpected upstream URL ${url}`);
};

const server = createServer({ requestIdentity: "203.0.113.10", userAgent: "v2-selftest/1" });
const client = new Client({ name: "assetfare-v2-selftest", version: "0.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const dynamicCapabilities = listed.tools.find((tool) => tool.name === "assetfare_v2_capabilities");
  const dynamicQuote = listed.tools.find((tool) => tool.name === "assetfare_v2_quote");
  const card = serverCard();
  const staticCapabilities = card.tools.find((tool) => tool.name === "assetfare_v2_capabilities");
  const staticQuote = card.tools.find((tool) => tool.name === "assetfare_v2_quote");
  assert.equal(listed.tools.length, 15);
  assert.equal(card.serverInfo.version, "0.4.1");
  assert.equal(card.tools.length, 15);
  assert.equal(dynamicCapabilities.description, staticCapabilities.description);
  assert.equal(dynamicQuote.description, staticQuote.description);
  assert.deepEqual(normalizedInputSchema(dynamicCapabilities.inputSchema), normalizedInputSchema(staticCapabilities.inputSchema));
  assert.deepEqual(normalizedInputSchema(dynamicQuote.inputSchema), normalizedInputSchema(staticQuote.inputSchema));
  assert.deepEqual(dynamicQuote.inputSchema.properties.from_chain.enum, staticQuote.inputSchema.properties.from_chain.enum);
  assert.deepEqual(dynamicQuote.inputSchema.properties.from_token.enum, staticQuote.inputSchema.properties.from_token.enum);
  assert.equal(dynamicQuote.inputSchema.properties.amount_usd.type, "number");
  assert.equal(dynamicQuote.inputSchema.additionalProperties, false);
  assert.equal(dynamicQuote.annotations.readOnlyHint, true);
  assert.equal(dynamicQuote.annotations.destructiveHint, false);
  assert.equal(dynamicQuote.annotations.idempotentHint, false);
  assert.equal(V2_TIMEOUT_MS, 45_000);
  assert.equal(V2_MAX_RESPONSE_BYTES, 1_048_576);
  const forbidden = new Set(["wallets", "wallet", "access_token", "token", "idempotency_key", "session_id", "event_signer_public", "signature", "transaction_hash"]);
  for (const tool of [dynamicCapabilities, dynamicQuote]) {
    for (const key of Object.keys(tool.inputSchema.properties || {})) assert.ok(!forbidden.has(key), `forbidden v2 input ${key}`);
  }

  const invalidCapabilities = await call(client, "assetfare_v2_capabilities", { extra: "forbidden" });
  assert.equal(invalidCapabilities.isError, true);
  assert.equal(calls.length, 0, "invalid capabilities input reached upstream");
  const capabilityValue = parse(await call(client, "assetfare_v2_capabilities", {}));
  assert.equal(capabilityValue.asset_endpoints.length, 9);
  assert.equal(capabilityValue.directed_conversion_routes, 72);
  let quoteValue;
  let routeCount = 0;
  for (const [from_chain, from_token] of ENDPOINTS) {
    for (const [to_chain, to_token] of ENDPOINTS) {
      if (from_chain === to_chain && from_token === to_token) continue;
      const intent = { from_chain, from_token, to_chain, to_token, amount_usd: 2.5 };
      const quoteResult = await call(client, "assetfare_v2_quote", intent);
      assert.equal(quoteResult.isError, false, `valid route rejected: ${JSON.stringify(intent)}`);
      const value = parse(quoteResult);
      assert.equal(value.intent.from, `${from_chain}:${from_token}`);
      assert.equal(value.intent.to, `${to_chain}:${to_token}`);
      assert.equal(value.intent.amount_usd, 2.5);
      if (from_chain === validIntent.from_chain && from_token === validIntent.from_token && to_chain === validIntent.to_chain && to_token === validIntent.to_token) quoteValue = value;
      routeCount += 1;
    }
  }
  assert.equal(routeCount, 72);
  assert.equal(quoteValue.intent.from, "robinhood:USDG");
  assert.equal(quoteValue.intent.to, "solana:USDC");
  assert.equal(quoteValue.intent.amount_usd, 2.5);
  assert.equal(quoteValue.guidance.legacyWorkflowCompatible, false);
  assert.equal(quoteValue.guidance.walletAuthenticationPerformed, false);
  assert.equal(quoteValue.guidance.sessionCreated, false);
  assert.equal(quoteValue.guidance.actionPrepared, false);
  assert.equal(quoteValue.guidance.transactionSigned, false);
  assert.equal(quoteValue.guidance.transactionSubmitted, false);

  assert.equal(calls.length, 73);
  assert.equal(calls[0].url, "https://api.assetfare.dev/v2/capabilities");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[1].url, "https://api.assetfare.dev/v2/quote");
  assert.equal(calls[1].init.method, "POST");
  assert.equal(calls.slice(1).filter((item) => item.url.endsWith("/v2/quote") && item.init.method === "POST").length, 72);
  for (const item of calls) {
    assert.equal(item.init.redirect, "error");
    assert.ok(item.init.signal instanceof AbortSignal);
    assert.equal(item.init.headers["x-assetfare-channel"], "mcp");
    assert.equal(item.init.headers["x-forwarded-for"], "203.0.113.10");
    assert.equal(item.init.headers["user-agent"], "v2-selftest/1");
    assert.equal(item.init.headers.authorization, undefined);
  }

  const invalid = [
    { ...validIntent, from_chain: "base", from_token: "SOL" },
    { ...validIntent, to_chain: "robinhood", to_token: "USDC" },
    { ...validIntent, to_chain: "robinhood", to_token: "USDG", from_chain: "robinhood", from_token: "USDG" },
    { ...validIntent, amount_usd: true },
    { ...validIntent, amount_usd: Number.NaN },
    { ...validIntent, amount_usd: Number.POSITIVE_INFINITY },
    { ...validIntent, amount_usd: 0.99 },
    { ...validIntent, amount_usd: 1000.01 },
    { ...validIntent, extra: "forbidden" },
  ];
  const beforeInvalid = calls.length;
  for (const args of invalid) {
    const result = await call(client, "assetfare_v2_quote", args);
    assert.equal(result.isError, true, `invalid input accepted: ${JSON.stringify(args)}`);
  }
  assert.equal(calls.length, beforeInvalid, "invalid input reached upstream");

  for (const failureMode of ["unsafe-capabilities", "unsafe-quote", "oversized", "invalid-json", "wrong-content-type", "unsafe-error", "network"]) {
    mode = failureMode;
    const result = await call(client, failureMode === "unsafe-capabilities" ? "assetfare_v2_capabilities" : "assetfare_v2_quote", failureMode === "unsafe-capabilities" ? {} : validIntent);
    assert.equal(result.isError, true, `${failureMode} did not fail closed`);
    const value = parse(result);
    const serialized = JSON.stringify(value);
    assert.ok(serialized.length < 1024, `${failureMode} error was unbounded`);
    assert.ok(!serialized.includes("SECRET") && !serialized.includes("secret network detail") && !serialized.includes("unsafe detail"), `${failureMode} leaked upstream detail`);
  }

  assert.ok(calls.every((item) => item.url.endsWith("/v2/capabilities") || item.url.endsWith("/v2/quote")), "v2 tools reached an unauthorized path");
  console.log(JSON.stringify({ status: "pass", version: packageMetadata.version, registry_description_chars: registryMetadata.description.length, keyword_count: packageMetadata.keywords.length, tool_count: listed.tools.length, v2_tools: [dynamicCapabilities.name, dynamicQuote.name], valid_routes: routeCount, valid_upstream_calls: 73, invalid_upstream_calls: 0, timeout_ms: V2_TIMEOUT_MS, max_response_bytes: V2_MAX_RESPONSE_BYTES, signed: false, submitted: false }));
} finally {
  globalThis.fetch = originalFetch;
  await client.close();
  await server.close();
}
