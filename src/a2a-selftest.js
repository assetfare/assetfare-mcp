import assert from "node:assert/strict";
import { Message, Role, canonicalizeAgentCard } from "@a2a-js/sdk";
import { JsonRpcTransportHandler, defaultServerCallContextBuilder } from "@a2a-js/sdk/server";
import { A2A_PROTOCOL_VERSION, assetFareAgentCard, createAssetFareA2A } from "./a2a.js";

const ok = (value) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
const caps = { public_api_enabled: true, server_signing: false, server_submission: false };
const status = { status: "capped_public_agent_release", server_signing: false, server_submission: false };
const quote = { status: "capped_public_agent_release", execution: { supported: true }, risk: { server_signing: false, server_submission: false }, offer: { expected_receive_usd: .98 } };
const data = (value) => ({ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" });
const text = (value) => ({ content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" });
const message = (parts) => Message.toJSON({ messageId: "m", contextId: "", taskId: "", role: Role.ROLE_USER, parts, metadata: undefined, extensions: [], referenceTaskIds: [] });
const request = (parts, id = "1", method = "SendMessage") => ({ jsonrpc: "2.0", id, method, params: { message: message(parts) } });
const context = (headers = {}) => defaultServerCallContextBuilder({ headers, user: undefined, extensions: undefined, requestedVersion: A2A_PROTOCOL_VERSION });

const card = assetFareAgentCard();
canonicalizeAgentCard(card);
assert.equal(card.version, "0.1.2");
assert.equal(card.supportedInterfaces[0].protocolVersion, "1.0");
assert.equal(card.supportedInterfaces[0].protocolBinding, "JSONRPC");
assert.equal(card.supportedInterfaces[0].url, "https://api.assetfare.dev/a2a");
assert.match(card.description,/cross-chain.*crypto.*bridge.*same-chain.*swap.*route quotes.*AI agents/);
assert.deepEqual(card.skills[0].tags.slice(0,5),["cross-chain","bridge","swap","crypto","quote"]);
assert.match(card.skills[0].description,/fromChain.*fromToken.*toChain.*toToken.*amountUsd/);
assert.equal(JSON.parse(card.skills[0].examples[0]).amountUsd,1);
assert.equal(JSON.stringify(card).match(/BEGIN PRIVATE KEY|seed phrase|secret[_-]?key|api[_-]?key|bearer [A-Za-z0-9]/i), null);

let observedBody;let observedHeaders;
const fetchMock = async (url, init = {}) => {
  if (String(url).endsWith("/v2/quote")) { observedBody = JSON.parse(String(init.body));observedHeaders = init.headers;return ok(quote); }
  if (String(url).endsWith("/v2/capabilities")) return ok(caps);
  if (String(url).endsWith("/v2/status")) return ok(status);
  return new Response("{}", { status: 404 });
};
const { requestHandler } = createAssetFareA2A({ apiBaseUrl: "http://127.0.0.1:8791", fetch: fetchMock });
const transport = new JsonRpcTransportHandler(requestHandler);
const intent = { fromChain: "solana", fromToken: "SOL", toChain: "base", toToken: "USDC", amountUsd: 1 };
const result = await transport.handle(request([data(intent)]), context({ "x-forwarded-for": "203.0.113.10", "user-agent": "external-agent/1" }));
assert.deepEqual(observedBody, { from_chain: "solana", from_token: "SOL", to_chain: "base", to_token: "USDC", amount_usd: 1 });
assert.equal(observedHeaders.get("x-forwarded-for"), "203.0.113.10");
assert.equal(observedHeaders.get("x-assetfare-channel"), "a2a");
assert.equal(result.result.message.role, "ROLE_AGENT");
assert.ok(result.result.message.parts[0].data.quote);
assert.equal(result.result.message.parts[0].data.guidance.transactionSubmitted, false);

const polygonIntent = { fromChain: "polygon", fromToken: "USDC", toChain: "arbitrum", toToken: "USDC", amountUsd: 10 };
const polygonResult = await transport.handle(request([data(polygonIntent)], "polygon"), context());
assert.deepEqual(observedBody, { from_chain: "polygon", from_token: "USDC", to_chain: "arbitrum", to_token: "USDC", amount_usd: 10 });
assert.ok(polygonResult.result.message.parts[0].data.quote);
const polygonDestination = await transport.handle(request([data({ ...polygonIntent, fromChain: "base", toChain: "polygon" })], "polygon-destination"), context());
assert.equal(polygonDestination.result.message.parts[0].data.error.code, "quote_intent_invalid");

const oldMethod = await transport.handle(request([data(intent)], "2", "message/send"), context());
assert.equal(oldMethod.error.code, -32601);
const freeText = await transport.handle(request([text("send money")], "3"), context());
assert.equal(freeText.result.message.parts[0].data.error.code, "quote_intent_invalid");
assert.equal(JSON.stringify(freeText).includes('"quote"'), false);

const unsafeFetch = async (url) => String(url).endsWith("/v2/capabilities") ? ok(caps) : String(url).endsWith("/v2/status") ? ok(status) : ok({ ...quote, risk: { server_signing: false, server_submission: true } });
const unsafe = new JsonRpcTransportHandler(createAssetFareA2A({ fetch: unsafeFetch }).requestHandler);
const unsafeResult = await unsafe.handle(request([data(intent)], "4"), context());
assert.equal(unsafeResult.result.message.parts[0].data.error.code, "assetfare_safety_boundary_failed");
assert.equal(JSON.stringify(unsafeResult).includes('"quote"'), false);

const leaky = new JsonRpcTransportHandler(createAssetFareA2A({ fetch: async()=>{throw Error("SECRET https://internal/?key=bad");} }).requestHandler);
const leakyResult = await leaky.handle(request([data(intent)], "5"), context());
assert.equal(JSON.stringify(leakyResult).match(/SECRET|internal|https?:\/\//), null);
assert.equal(leakyResult.result.message.parts[0].data.error.code, "assetfare_upstream_unavailable");

console.log(JSON.stringify({ status: "pass", official_sdk: "@a2a-js/sdk@1.1.0", card: true, quote: true, provenance: true, v0_method_rejected: true, free_text_rejected: true, unsafe_quote_rejected: true, sanitized_errors: true, signed: false, submitted: false }));
