#!/usr/bin/env node
import express from "express";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const VERSION = "0.2.1";
const API_BASE = (process.env.ASSETFARE_API_BASE_URL || "https://api.assetfare.dev").replace(/\/$/, "");
const HOST = process.env.ASSETFARE_MCP_HOST || "127.0.0.1";
const PORT = Number(process.env.ASSETFARE_MCP_PORT || "8790");
const ORIGINS = new Set((process.env.ASSETFARE_MCP_ALLOWED_ORIGINS || "https://chatgpt.com,https://chat.openai.com,https://claude.ai,https://claude.com").split(",").map((value) => value.trim()).filter(Boolean));
const PUBLIC_HOST = process.env.ASSETFARE_MCP_PUBLIC_HOST || "api.assetfare.dev";
const LOCAL_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, "127.0.0.1", "localhost"]);

const accessToken = z.string().min(20).max(512);
const sessionId = z.string().uuid();
const idempotencyKey = z.string().min(8).max(128);
const sourceWallet = z.string().min(32).max(64);
const destinationWallet = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

function asText(value, isError = false) {
  return { isError, content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function provenanceFromHeaders(headers) {
  const forwarded = typeof headers["x-forwarded-for"] === "string" ? headers["x-forwarded-for"].trim() : "";
  const userAgent = typeof headers["user-agent"] === "string" ? headers["user-agent"].trim().slice(0, 512) : "";
  return { requestIdentity: forwarded && !forwarded.includes(",") && isIP(forwarded) ? forwarded : "", userAgent };
}

function apiClient(provenance = {}) {
  return async function api(path, { method = "GET", body, token } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (provenance.requestIdentity) headers["x-forwarded-for"] = provenance.requestIdentity;
  if (provenance.userAgent) headers["user-agent"] = provenance.userAgent;
  headers["x-assetfare-channel"] = "mcp";
  const response = await fetch(API_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => ({ error: "assetfare_non_json_response" }));
  if (!response.ok) {
    const error = typeof payload.error === "string" ? payload.error : "assetfare_request_failed";
    throw Object.assign(new Error(error), { status: response.status, payload });
  }
  return payload;
  };
}

function readonly() { return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }; }
function stateful(idempotent = false) { return { readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: true }; }

// Wallet-bound workflow tools use an access token produced by the preceding
// non-transactional signMessage flow. They never require a server-side API key
// or give the server signing/submission authority.
function serverCard() {
  const token = { type: "string", minLength: 20, maxLength: 512 };
  const uuid = { type: "string", format: "uuid" };
  const wallet = { type: "string", minLength: 32, maxLength: 64 };
  const evmWallet = { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" };
  const idempotency = { type: "string", minLength: 8, maxLength: 128 };
  const signature = { type: "string", minLength: 64, maxLength: 128 };
  const object = (properties, required = Object.keys(properties)) => ({ type: "object", additionalProperties: false, properties, required });
  return {
    serverInfo: { name: "AssetFare", version: VERSION },
    authentication: { required: false, schemes: [] },
    tools: [
      { name: "assetfare_status", description: "Read current route capabilities, caps, and safety gates.", inputSchema: object({}) },
      { name: "assetfare_manifest", description: "Read the signed release, contract, and mainnet-evidence manifest.", inputSchema: object({}) },
      { name: "assetfare_quote", description: "Get a fee-inclusive, non-binding Solana SOL to Base or Arbitrum ETH quote without creating a transaction.", inputSchema: object({ amount_usd: { type: "integer", minimum: 1, maximum: 1000 }, destination_chain: { type: "string", enum: ["base", "arbitrum"], default: "base" } }, ["amount_usd"]) },
      { name: "assetfare_start_wallet_auth", description: "Create a signMessage-only wallet login challenge. It cannot authorize or submit a transaction.", inputSchema: object({ source_wallet: wallet }) },
      { name: "assetfare_finish_wallet_auth", description: "Verify the exact wallet-login message and return a wallet-bound access token. The token is sensitive.", inputSchema: object({ challenge_id: uuid, source_wallet: wallet, signature, terms_version: { type: "string", minLength: 1, maxLength: 160 } }) },
      { name: "assetfare_create_session", description: "Lock a fresh quote into one wallet-bound execution session. Creates no blockchain transaction.", inputSchema: object({ access_token: token, quote_id: uuid, idempotency_key: idempotency, source_wallet: wallet, destination_wallet: evmWallet }) },
      { name: "assetfare_read_session", description: "Read a session, workflow, receipt, or current unsigned action without submitting anything.", inputSchema: object({ access_token: token, session_id: uuid, view: { type: "string", enum: ["session", "workflow", "receipt", "next_action"] } }, ["access_token", "session_id"]) },
      { name: "assetfare_prepare_source_action", description: "Prepare a bounded unsigned Solana source action. Verify it before the caller's own wallet signs/submits.", inputSchema: object({ access_token: token, session_id: uuid }) },
      { name: "assetfare_verify_source_receipt", description: "Verify a caller-submitted finalized Solana signature; never submits a transaction.", inputSchema: object({ access_token: token, session_id: uuid, signature, idempotency_key: idempotency }) },
      { name: "assetfare_prepare_cctp_action", description: "Prepare an unsigned CCTP burn action. The caller owns signing and submission.", inputSchema: object({ access_token: token, session_id: uuid, event_signer_public: wallet, idempotency_key: idempotency }) },
      { name: "assetfare_observe_cctp", description: "Observe an already-submitted CCTP burn and forwarded mint; never submits a transaction.", inputSchema: object({ access_token: token, session_id: uuid, burn_signature: signature, idempotency_key: idempotency }) },
      { name: "assetfare_prepare_destination_action", description: "Prepare an unsigned ERC-4337 settlement plan with bounded permit and deadline.", inputSchema: object({ access_token: token, session_id: uuid, idempotency_key: idempotency }) },
      { name: "assetfare_observe_destination", description: "Verify an already-submitted destination UserOperation receipt; never submits a transaction.", inputSchema: object({ access_token: token, session_id: uuid, transaction_hash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, idempotency_key: idempotency }) },
    ],
    resources: [],
    prompts: [],
  };
}

function addTool(server, name, description, inputSchema, annotations, action) {
  server.registerTool(name, { description, inputSchema, annotations }, async (args) => {
    try { return asText(await action(args)); }
    catch (error) {
      return asText({ error: error?.message || "assetfare_mcp_request_failed", http_status: error?.status || null, details: error?.payload || null }, true);
    }
  });
}

function createServer(provenance = {}) {
  const api = apiClient(provenance);
  const server = new McpServer(
    { name: "AssetFare", version: VERSION },
    { instructions: "This optional MCP adapter covers only the original Solana SOL to Base or Arbitrum ETH routes. Use AssetFare REST/OpenAPI v2 for the four-chain matrix. AssetFare is non-custodial: never request a private key, and verify every unsigned action before the caller signs and submits it." },
  );

  addTool(server, "assetfare_status", "Read current capabilities, caps, pause state, and independent RPC quorum.", {}, readonly(), () => api("/v1/status"));
  addTool(server, "assetfare_manifest", "Read the Ed25519-signed capability, contract, release, and mainnet-evidence manifest.", {}, readonly(), () => api("/.well-known/assetfare-manifest.json"));
  addTool(server, "assetfare_quote", "Get a fee-inclusive Solana SOL to Base or Arbitrum ETH quote. This does not create a session or transaction.", { amount_usd: z.number().int().min(1).max(1000), destination_chain: z.enum(["base", "arbitrum"]).default("base") }, readonly(), ({ amount_usd, destination_chain }) => api("/v1/quote", { method: "POST", body: { from_chain: "solana", from_token: "SOL", to_chain: destination_chain, to_token: "ETH", amount_usd } }));

  addTool(server, "assetfare_start_wallet_auth", "Create a non-transactional Solana signMessage challenge. Requires caller approval because it creates a short-lived login challenge; it cannot move funds.", { source_wallet: sourceWallet }, stateful(false), ({ source_wallet }) => api("/v1/auth/challenge", { method: "POST", body: { source_wallet } }));
  addTool(server, "assetfare_finish_wallet_auth", "Verify a wallet signature over the exact challenge message and return a wallet-bound access token. Requires caller approval; the returned token is sensitive.", { challenge_id: z.string().uuid(), source_wallet: sourceWallet, signature: z.string().min(64).max(128), terms_version: z.string().min(1).max(160) }, stateful(false), (args) => api("/v1/auth/verify", { method: "POST", body: args }));

  addTool(server, "assetfare_create_session", "Lock a fresh quote into a wallet-bound execution session. This creates no transaction, but reserves the caller's one active session slot.", { access_token: accessToken, quote_id: z.string().uuid(), idempotency_key: idempotencyKey, source_wallet: sourceWallet, destination_wallet: destinationWallet }, stateful(true), ({ access_token, ...body }) => api("/v1/session", { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_read_session", "Read a wallet-bound session, workflow, receipt, or current unsigned action. Read-only.", { access_token: accessToken, session_id: sessionId, view: z.enum(["session", "workflow", "receipt", "next_action"]).default("session") }, readonly(), ({ access_token, session_id, view }) => api(`/v1/session/${session_id}${view === "session" ? "" : `/${view === "next_action" ? "next-action" : view}`}`, { token: access_token }));
  addTool(server, "assetfare_prepare_source_action", "Prepare a bounded unsigned Solana source action. Requires caller approval; it never signs or submits.", { access_token: accessToken, session_id: sessionId }, stateful(true), ({ access_token, session_id }) => api(`/v1/session/${session_id}/prepare-source-action`, { method: "POST", token: access_token, body: {} }));
  addTool(server, "assetfare_verify_source_receipt", "Verify a caller-submitted finalized Solana source signature and advance the workflow. Requires caller approval; it never submits a transaction.", { access_token: accessToken, session_id: sessionId, signature: z.string().min(64).max(128), idempotency_key: idempotencyKey }, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/verify-source`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_prepare_cctp_action", "Prepare an unsigned CCTP burn action using a caller-generated event signer public key. Requires caller approval; it never signs or submits.", { access_token: accessToken, session_id: sessionId, event_signer_public: sourceWallet, idempotency_key: idempotencyKey }, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/prepare-cctp-action`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_observe_cctp", "Verify Circle attestation and the forwarded Base or Arbitrum USDC mint for an already-submitted burn. Read-only on chain, but advances the session record.", { access_token: accessToken, session_id: sessionId, burn_signature: z.string().min(64).max(128), idempotency_key: idempotencyKey }, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/observe-cctp`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_prepare_destination_action", "Prepare the exact-cap permit and unsigned ERC-4337 destination settlement plan. Requires caller approval; it never signs or submits.", { access_token: accessToken, session_id: sessionId, idempotency_key: idempotencyKey }, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/prepare-destination-action`, { method: "POST", token: access_token, body }));
  addTool(server, "assetfare_observe_destination", "Verify an already-submitted destination UserOperation receipt and finalize the workflow. Requires caller approval; it never submits a transaction.", { access_token: accessToken, session_id: sessionId, transaction_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/), idempotency_key: idempotencyKey }, stateful(true), ({ access_token, session_id, ...body }) => api(`/v1/session/${session_id}/observe-destination`, { method: "POST", token: access_token, body }));

  server.registerResource("assetfare-trust-manifest", "assetfare://trust/manifest", { description: "Current signed AssetFare trust manifest." }, async () => ({ contents: [{ uri: "assetfare://trust/manifest", mimeType: "application/json", text: JSON.stringify(await api("/.well-known/assetfare-manifest.json"), null, 2) }] }));
  return server;
}

function allowedOrigin(origin) { return !origin || ORIGINS.has(origin); }
function allowedHost(host) { return host === PUBLIC_HOST || LOCAL_HOSTS.has(host); }

async function serveHttp() {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => allowedHost(req.get("host") || "") ? next() : res.status(421).json({ error: "mcp_host_not_allowed" }));
  app.use(express.json({ limit: "32kb", type: ["application/json", "application/*+json"] }));
  app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok", service: "assetfare-mcp", version: VERSION }));
  app.get("/.well-known/mcp/server-card.json", (_req, res) => res.status(200).type("application/json").json(serverCard()));
  app.head("/mcp", (req, res) => {
    if (!allowedOrigin(req.get("origin"))) return res.status(403).end();
    return res.set("allow", "GET, HEAD, POST, OPTIONS").set("cache-control", "no-store").status(200).end();
  });
  app.all("/mcp", async (req, res) => {
    if (!allowedOrigin(req.get("origin"))) return res.status(403).json({ error: "mcp_origin_not_allowed" });
    try {
      const server = createServer(provenanceFromHeaders(req.headers));
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => transport.close().catch(() => {}));
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (_error) {
      if (!res.headersSent) res.status(500).json({ error: "assetfare_mcp_internal_error" });
    }
  });
  app.listen(PORT, HOST, () => process.stdout.write(`assetfare-mcp listening on ${HOST}:${PORT}\n`));
}

async function main() {
  if (process.env.ASSETFARE_MCP_TRANSPORT === "stdio") {
    const server = createServer();
    await server.connect(new StdioServerTransport());
    return;
  }
  await serveHttp();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => process.exit(1));

export { allowedHost, createServer, provenanceFromHeaders };
