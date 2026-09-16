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
};

const Chain = z.enum(["solana", "base", "arbitrum", "robinhood"]);
const Token = z.enum(["SOL", "ETH", "USDC", "USDG"]);
const QuoteIntent = z.object({
  fromChain: Chain,
  fromToken: Token,
  toChain: Chain,
  toToken: Token,
  amountUsd: z.number().finite().min(1).max(1000),
}).strict().superRefine((value, context) => {
  if (!TOKENS_BY_CHAIN[value.fromChain].includes(value.fromToken)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["fromToken"], message: "unsupported source token" });
  if (!TOKENS_BY_CHAIN[value.toChain].includes(value.toToken)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toToken"], message: "unsupported destination token" });
  if (value.fromChain === value.toChain && value.fromToken === value.toToken) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toToken"], message: "identity route" });
});

const Capabilities = z.object({ public_api_enabled: z.literal(true), server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough();
const Status = z.object({ status: z.literal("capped_public_agent_release"), server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough();
const Quote = z.object({
  status: z.literal("capped_public_agent_release"),
  execution: z.object({ supported: z.literal(true) }).passthrough(),
  risk: z.object({ server_signing: z.literal(false), server_submission: z.literal(false) }).passthrough(),
  offer: z.record(z.unknown()),
}).passthrough();

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
    description: "Read-only non-custodial route quotes across Solana, Base, Arbitrum, and Robinhood Chain. AssetFare never receives a private key and never signs or submits.",
    supportedInterfaces: [{ url: serviceUrl, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }],
    provider: { organization: "AssetFare", url: "https://assetfare.dev" },
    version: "0.1.0",
    documentationUrl: "https://assetfare.dev/llms-full.txt",
    capabilities: { streaming: false, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [{
      id: "quote-cross-chain-route",
      name: "Quote a cross-chain route",
      description: "Return one fresh quote for nine supported asset endpoints and 72 directed routes from USD 1 through 1,000; stop before authentication, preparation, signing, or submission.",
      tags: ["cross-chain", "quote", "solana", "base", "arbitrum", "robinhood", "non-custodial"],
      examples: ["Quote a $1 route from solana:SOL to base:USDC", "Quote a $250 route from solana:SOL to arbitrum:ETH"],
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
  async execute(context, bus) {
    let intent;
    try { intent = QuoteIntent.parse(dataValue(context.userMessage.parts)); }
    catch { throw new Error("quote_intent_invalid"); }
    const headers = context.context.state.get("headers") || {};
    const request = requester(this.config, headers);
    const known = new Set(["assetfare_upstream_unavailable", "assetfare_response_too_large", "assetfare_response_invalid", "assetfare_upstream_status_error"]);
    let quote;
    try {
      const [capabilitiesRaw, statusRaw] = await Promise.all([request("/v2/capabilities"), request("/v2/status")]);
      Capabilities.parse(capabilitiesRaw);Status.parse(statusRaw);
      quote = Quote.parse(await request("/v2/quote", { method: "POST", body: JSON.stringify({ from_chain: intent.fromChain, from_token: intent.fromToken, to_chain: intent.toChain, to_token: intent.toToken, amount_usd: intent.amountUsd }) }));
    } catch (error) {
      throw new Error(error instanceof Error && known.has(error.message) ? error.message : "assetfare_safety_boundary_failed");
    }
    bus.publish(AgentEvent.message({
      messageId: `assetfare-${Date.now()}`,
      contextId: context.contextId,
      taskId: "",
      role: Role.ROLE_AGENT,
      parts: [{ content: { $case: "data", value: { quote, guidance: { compareWithOtherRoutes: true, requoteBeforeSelection: true, walletAuthenticationPerformed: false, sessionCreated: false, actionPrepared: false, transactionSigned: false, transactionSubmitted: false } } }, metadata: undefined, filename: "", mediaType: "application/json" }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    }));
    bus.finished();
  }
  async cancelTask(_taskId, bus) { bus.finished(); }
}

export function createAssetFareA2A(config = {}) {
  const card = assetFareAgentCard(config.serviceUrl);
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), new QuoteExecutor(config));
  return { card, requestHandler };
}

export { A2A_CONTENT_TYPE, A2A_PROTOCOL_VERSION, AGENT_CARD_PATH, MAX_BYTES };
