// Read-only A2A v1 quote adapter. It never authenticates a wallet, creates an
// AssetFare session, prepares an action, signs, approves, funds, or submits.

import { isIP } from "node:net";
import {
  A2A_CONTENT_TYPE,
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_PATH,
  canonicalizeAgentCard,
  Role,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
} from "@a2a-js/sdk/server";
import { z } from "zod";

const MAX_BYTES = 1_048_576;
const FETCH_TIMEOUT_MS = 45_000;
const TOKENS_BY_CHAIN = {
  solana: ["SOL", "USDC", "USDG"],
  base: ["ETH", "USDC"],
  arbitrum: ["ETH", "USDC"],
  robinhood: ["ETH", "USDG"],
  polygon: ["USDC"],
};
const ENDPOINTS = new Set(Object.entries(TOKENS_BY_CHAIN).flatMap(([chain,tokens]) => tokens.map((token) => `${chain}:${token}`)));

const SourceChain = z.enum(["solana", "base", "arbitrum", "robinhood", "polygon"]);
const DestinationChain = z.enum(["solana", "base", "arbitrum", "robinhood"]);
const Token = z.enum(["SOL", "ETH", "USDC", "USDG"]);
const QuoteIntent = z.object({
  fromChain: SourceChain,
  fromToken: Token,
  toChain: DestinationChain,
  toToken: Token,
  amountUsd: z.number().finite().min(1).max(1000),
}).strict().superRefine((value, context) => {
  if (!TOKENS_BY_CHAIN[value.fromChain].includes(value.fromToken)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["fromToken"], message: "unsupported source token" });
  if (!TOKENS_BY_CHAIN[value.toChain].includes(value.toToken)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toToken"], message: "unsupported destination token" });
  if (value.fromChain === value.toChain && value.fromToken === value.toToken) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toToken"], message: "identity route" });
  if (value.fromChain === "polygon" && !(value.fromToken === "USDC" && ["base", "arbitrum"].includes(value.toChain) && value.toToken === "USDC")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toChain"], message: "unsupported Polygon source route" });
});

const Capabilities = z.object({ status: z.literal("capped_public_agent_release"), public_api_enabled: z.literal(true), chains: z.array(SourceChain).length(5), asset_endpoints: z.array(z.object({chain:SourceChain,token:Token}).passthrough()).length(10), directed_conversion_routes:z.literal(74), unsigned_route_plans_ready:z.literal(74), server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough();
const Status = z.object({ status: z.literal("capped_public_agent_release"), server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough();
const Quote = z.object({
  status: z.literal("capped_public_agent_release"),
  intent: z.object({from:z.string(),to:z.string(),amount_usd:z.number().finite(),estimated_input_base:z.number().int().positive()}).passthrough(),
  execution: z.object({ supported: z.literal(true) }).passthrough(),
  risk: z.object({ server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough(),
  offer: z.object({expected_receive_amount:z.number().finite().positive(),estimated_min_receive_amount:z.number().finite().positive(),output_symbol:Token}).passthrough(),
  route:z.object({route:z.string(),steps:z.array(z.record(z.unknown())).min(1),server_signing:z.literal(false),server_submission:z.literal(false)}).passthrough(),
}).passthrough();

function validateCapabilities(payload) {
  const value=Capabilities.parse(payload),chains=new Set(value.chains),endpoints=new Set(value.asset_endpoints.map((item)=>`${item.chain}:${item.token}`));
  if(chains.size!==5||Object.keys(TOKENS_BY_CHAIN).some((chain)=>!chains.has(chain))||endpoints.size!==ENDPOINTS.size||[...ENDPOINTS].some((endpoint)=>!endpoints.has(endpoint)))throw new Error("assetfare_safety_boundary_failed");
  return value;
}

function validateQuote(payload,intent) {
  const value=Quote.parse(payload),source=`${intent.fromChain}:${intent.fromToken}`,destination=`${intent.toChain}:${intent.toToken}`;
  if(value.intent.from!==source||value.intent.to!==destination||value.intent.amount_usd!==intent.amountUsd||value.offer.output_symbol!==intent.toToken||value.offer.estimated_min_receive_amount>value.offer.expected_receive_amount||value.route.route!==`${source}->${destination}`)throw new Error("assetfare_safety_boundary_failed");
  return value;
}

function provenance(headers = {}) {
  const raw = headers["x-forwarded-for"];
  const forwarded = Array.isArray(raw) ? "" : String(raw || "").trim();
  const userRaw = headers["user-agent"];
  const userAgent = (Array.isArray(userRaw) ? userRaw[0] : String(userRaw || "")).slice(0, 512);
  return { requestIdentity: forwarded && !forwarded.includes(",") && isIP(forwarded) ? forwarded : "", userAgent };
}

function requester(config, headers) {
  const apiBaseUrl = (config.apiBaseUrl || "https://api.assetfare.dev").replace(/\/$/, "");
  const fetchFn = config.fetch || fetch;
  const source = provenance(headers);
  return async (path, init = {}) => {
    const requestHeaders = new Headers(init.headers || {});
    requestHeaders.set("accept", "application/json");
    requestHeaders.set("x-assetfare-channel", "a2a");
    if (init.body) requestHeaders.set("content-type", "application/json");
    if (source.requestIdentity) requestHeaders.set("x-forwarded-for", source.requestIdentity);
    if (source.userAgent) requestHeaders.set("user-agent", source.userAgent);
    let response;
    try {
      response = await fetchFn(apiBaseUrl + path, { ...init, headers: requestHeaders, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      throw new Error("assetfare_upstream_unavailable");
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BYTES) throw new Error("assetfare_response_too_large");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error("assetfare_response_too_large");
    let body;
    try {
      body = JSON.parse(text);
      if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("shape");
    } catch {
      throw new Error("assetfare_response_invalid");
    }
    if (!response.ok) throw new Error("assetfare_upstream_status_error");
    return body;
  };
}

export function assetFareAgentCard(serviceUrl = "https://api.assetfare.dev/a2a") {
  if (!serviceUrl.startsWith("https://")) throw new Error("A2A service url must be https");
  const card = {
    name: "AssetFare Route Quotes",
    description: "Read-only cross-chain crypto bridge and same-chain swap route quotes for AI agents across Solana, Base, Arbitrum, Robinhood Chain, and Polygon native-USDC source routes. No wallet login is required for a quote; AssetFare never receives private keys, signs, or submits.",
    supportedInterfaces: [{ url: serviceUrl, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "AssetFare", url: "https://assetfare.dev" },
    version: "0.1.2",
    documentationUrl: "https://assetfare.dev/llms-full.txt",
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{
      id: "quote-cross-chain-route",
      name: "Quote a cross-chain route",
      description: "Return one fresh quote for ten supported source endpoints and 74 directed routes from USD 1 through 1,000. Polygon is native-USDC source-only to Base or Arbitrum USDC. Send exactly one application/json DataPart with fromChain, fromToken, toChain, toToken, and numeric amountUsd; stop before authentication, preparation, signing, or submission.",
      tags: ["cross-chain", "bridge", "swap", "crypto", "quote", "solana", "base", "arbitrum", "robinhood", "polygon", "non-custodial"],
      examples: ['{"fromChain":"solana","fromToken":"SOL","toChain":"base","toToken":"USDC","amountUsd":1}', '{"fromChain":"polygon","fromToken":"USDC","toChain":"arbitrum","toToken":"USDC","amountUsd":10}'],
      inputModes: ["application/json"],
      outputModes: ["application/json"],
      securityRequirements: [],
    }],
    signatures: [],
  };
  canonicalizeAgentCard(card);
  return card;
}

function dataValue(parts) {
  const values = parts.filter((part) => part.content?.$case === "data");
  if (values.length !== 1) throw new Error("quote_intent_required");
  return values[0].content.value;
}

class QuoteExecutor {
  constructor(config) { this.config = config; }
  publish(context,bus,value) {
    bus.publish(AgentEvent.message({
      messageId: `assetfare-${Date.now()}`,
      contextId: context.contextId,
      taskId: "",
      role: Role.ROLE_AGENT,
      parts: [{ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    }));
    bus.finished();
  }
  async execute(context, bus) {
    let intent;
    try { intent = QuoteIntent.parse(dataValue(context.userMessage.parts)); }
    catch { this.publish(context,bus,{error:{code:"quote_intent_invalid"}});return; }
    const headers = context.context.state.get("headers") || {};
    const request = requester(this.config, headers);
    const known = new Set(["assetfare_upstream_unavailable", "assetfare_response_too_large", "assetfare_response_invalid", "assetfare_upstream_status_error"]);
    let quote;
    try {
      const [capabilitiesRaw, statusRaw] = await Promise.all([request("/v2/capabilities"), request("/v2/status")]);
      validateCapabilities(capabilitiesRaw);Status.parse(statusRaw);
      quote = validateQuote(await request("/v2/quote", { method: "POST", body: JSON.stringify({ from_chain: intent.fromChain, from_token: intent.fromToken, to_chain: intent.toChain, to_token: intent.toToken, amount_usd: intent.amountUsd }) }),intent);
    } catch (error) {
      this.publish(context,bus,{error:{code:error instanceof Error && known.has(error.message) ? error.message : "assetfare_safety_boundary_failed"}});return;
    }
    this.publish(context,bus,{ quote, guidance: { compareWithOtherRoutes: true, requoteBeforeSelection: true, walletAuthenticationPerformed: false, sessionCreated: false, actionPrepared: false, transactionSigned: false, transactionSubmitted: false } });
  }
  async cancelTask(_taskId, bus) { bus.finished(); }
}

export function createAssetFareA2A(config = {}) {
  const card = assetFareAgentCard(config.serviceUrl);
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new QuoteExecutor(config));
  return { card, requestHandler };
}

export { A2A_CONTENT_TYPE, A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, MAX_BYTES };
