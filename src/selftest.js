import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { request as httpRequest } from "node:http";
import { a2aVersionGuard, allowedHost, createHttpApp, createServer, normalizeA2AVersion, provenanceFromHeaders } from "./server.js";

function postJson(port, version, id = "test") {
  const body = JSON.stringify({ jsonrpc: "2.0", id, method: "UnknownMethod", params: {} });
  const headers = { host: "127.0.0.1:8790", "content-type": "application/json", "content-length": Buffer.byteLength(body) };
  if (version !== undefined) headers["A2A-Version"] = version;
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path: "/a2a", method: "POST", headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text), bytes: Buffer.byteLength(text) }); }
        catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

const server = createServer();
const client = new Client({ name: "assetfare-mcp-selftest", version: "0.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const result = await client.listTools();
const names = result.tools.map((tool) => tool.name).sort();
const required = ["assetfare_manifest", "assetfare_quote", "assetfare_start_wallet_auth", "assetfare_create_session", "assetfare_observe_destination"];
if (!required.every((name) => names.includes(name))) throw new Error("required MCP tools missing");
const quoteTool = result.tools.find((tool) => tool.name === "assetfare_quote");
if (JSON.stringify(quoteTool?.inputSchema?.properties?.destination_chain?.enum) !== JSON.stringify(["base", "arbitrum"])) throw new Error("quote destination schema mismatch");
if (quoteTool?.inputSchema?.properties?.amount_usd?.minimum !== 1 || quoteTool?.inputSchema?.properties?.amount_usd?.maximum !== 1000) throw new Error("quote amount schema mismatch");
if (names.some((name) => /sign|submit|send/i.test(name))) throw new Error("MCP must not expose transaction submission");
const validProvenance = provenanceFromHeaders({ "x-forwarded-for": "203.0.113.10", "user-agent": "agent-test/1" });
const spoofedProvenance = provenanceFromHeaders({ "x-forwarded-for": "203.0.113.10, 198.51.100.2", "user-agent": "agent-test/1" });
if (validProvenance.requestIdentity !== "203.0.113.10" || spoofedProvenance.requestIdentity) throw new Error("MCP provenance validation failed");
if (!allowedHost("api.assetfare.dev") || !allowedHost("127.0.0.1:8790") || allowedHost("evil.example")) throw new Error("MCP host allowlist failed");
const guard = a2aVersionGuard("1.0");
let nextCalled = false;
const accepted = { get: () => "1.0", headers: {}, body: { id: "ok" } };
guard(accepted, {}, () => { nextCalled = true; });
if (!nextCalled) throw new Error("A2A current version must pass");
let rejectedStatus; let rejectedBody;
const rejectedResponse = { status(value) { rejectedStatus = value; return this; }, set() { return this; }, vary() { return this; }, json(value) { rejectedBody = value; return this; } };
guard({ get: () => "0.3", body: { id: "legacy" } }, rejectedResponse, () => { throw new Error("legacy A2A version passed"); });
if (rejectedStatus !== 400 || rejectedBody?.id !== "legacy" || rejectedBody?.error?.code !== -32009 || rejectedBody?.error?.data?.[0]?.reason !== "VERSION_NOT_SUPPORTED") throw new Error("A2A version error mapping failed");
if (normalizeA2AVersion("1.0.0") !== "1.0" || normalizeA2AVersion("v1") !== null) throw new Error("A2A version normalization failed");

const application = createHttpApp();
const listener = await new Promise((resolve, reject) => {
  const value = application.listen(0, "127.0.0.1", () => resolve(value));
  value.once("error", reject);
});
const originalFetch = globalThis.fetch;
let upstreamCalls = 0;
globalThis.fetch = async () => { upstreamCalls += 1; throw new Error("unexpected upstream call"); };
try {
  const port = listener.address().port;
  const legacy = await postJson(port, "0.3", "legacy");
  const missing = await postJson(port, undefined, "missing");
  const current = await postJson(port, "1.0", "current");
  const patch = await postJson(port, "1.0.0", "patch");
  const malformed = await postJson(port, "v1", "malformed");
  const duplicate = await postJson(port, ["1.0", "0.3"], "duplicate");
  const oversized = await postJson(port, "9".repeat(80), { unsafe: true });
  const truncationBypass = await postJson(port, `1.0.${"1".repeat(28)}x`, "truncation-bypass");
  if (legacy.status !== 400 || legacy.body?.id !== "legacy" || legacy.body?.error?.code !== -32009) throw new Error("legacy A2A HTTP mapping failed");
  if (missing.status !== 400 || missing.body?.id !== "missing" || missing.body?.error?.code !== -32009) throw new Error("missing A2A version mapping failed");
  if (current.status !== 200 || current.body?.error?.code !== -32601) throw new Error("current A2A version did not reach handler");
  if (patch.status !== 200 || patch.body?.error?.code !== -32601) throw new Error("A2A patch version did not reach handler");
  if (malformed.status !== 400 || duplicate.status !== 400 || oversized.status !== 400 || truncationBypass.status !== 400 || truncationBypass.body?.error?.code !== -32009) throw new Error("malformed A2A version accepted");
  if (oversized.body?.id !== null || oversized.bytes > 512 || oversized.headers["cache-control"] !== "no-store" || !String(oversized.headers.vary || "").toLowerCase().includes("a2a-version")) throw new Error("A2A version rejection is not bounded or private");
  if (upstreamCalls !== 0) throw new Error("A2A version tests reached upstream");
} finally {
  globalThis.fetch = originalFetch;
  await new Promise((resolve) => listener.close(resolve));
}

console.log(JSON.stringify({ status: "pass", tool_count: names.length, has_submission_tool: false, provenance_validation: true, a2a_version_http_status: 400, a2a_patch_version_accepted: true, a2a_http_integration: true }));
await client.close();
await server.close();
