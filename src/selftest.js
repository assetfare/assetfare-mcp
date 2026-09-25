import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { request as httpRequest } from "node:http";
import { a2aVersionGuard, allowedHost, createHttpApp, createServer, normalizeA2AVersion, provenanceFromHeaders, serverCard } from "./server.js";

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

function getJson(port, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { host: "127.0.0.1:8790", accept: "application/json" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function headStatus(port, path) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, path, method: "HEAD", headers: { host: "127.0.0.1:8790" } }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode, allow: response.headers.allow }));
    });
    request.on("error", reject);
    request.end();
  });
}
function methodStatus(port,path,method){return new Promise((resolve,reject)=>{const request=httpRequest({host:"127.0.0.1",port,path,method,headers:{host:"127.0.0.1:8790",origin:"https://claude.ai"}},(response)=>{response.resume();response.on("end",()=>resolve({status:response.statusCode,allow:response.headers.allow,methods:response.headers["access-control-allow-methods"]}));});request.on("error",reject);request.end();});}

const server = createServer();
const client = new Client({ name: "assetfare-mcp-selftest", version: "0.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const result = await client.listTools();
const names = result.tools.map((tool) => tool.name).sort();
const required = ["assetfare_manifest", "assetfare_v2_capabilities", "assetfare_v2_quote", "assetfare_v2_prepare", "assetfare_v2_session_create", "assetfare_v2_session_get", "assetfare_v2_session_observe_source", "assetfare_v2_session_observe_output", "assetfare_v2_session_refresh_action"];
if (!required.every((name) => names.includes(name))) throw new Error("required MCP tools missing");
if (names.length !== 9 || new Set(names).size !== 9) throw new Error("remote MCP tool count mismatch");
if (names.includes("assetfare_v2_new_session_capability")) throw new Error("remote MCP must not generate caller session secrets");
if (names.some((name) => !name.startsWith("assetfare_v2_") && name !== "assetfare_manifest")) throw new Error("legacy tool leaked into primary MCP");
const v2CapabilitiesTool = result.tools.find((tool) => tool.name === "assetfare_v2_capabilities");
const v2QuoteTool = result.tools.find((tool) => tool.name === "assetfare_v2_quote");
if (Object.keys(v2CapabilitiesTool?.inputSchema?.properties || {}).length !== 0) throw new Error("v2 capabilities must take no arguments");
if (JSON.stringify(v2QuoteTool?.inputSchema?.required) !== JSON.stringify(["from_chain", "from_token", "to_chain", "to_token", "amount_usd"])) throw new Error("v2 quote required fields mismatch");
if (JSON.stringify(v2QuoteTool?.inputSchema?.properties?.from_chain?.enum) !== JSON.stringify(["solana", "base", "arbitrum", "robinhood", "polygon", "optimism"])) throw new Error("v2 quote source chain schema mismatch");
if (JSON.stringify(v2QuoteTool?.inputSchema?.properties?.to_chain?.enum) !== JSON.stringify(["solana", "base", "arbitrum", "robinhood"])) throw new Error("v2 quote destination chain schema mismatch");
if (JSON.stringify(v2QuoteTool?.inputSchema?.properties?.from_token?.enum) !== JSON.stringify(["SOL", "ETH", "USDC", "USDG"])) throw new Error("v2 quote token schema mismatch");
if (v2QuoteTool?.inputSchema?.properties?.amount_usd?.type !== "number" || v2QuoteTool?.inputSchema?.properties?.amount_usd?.minimum !== 1 || "maximum" in v2QuoteTool.inputSchema.properties.amount_usd) throw new Error("v2 quote amount schema mismatch");
if (v2QuoteTool?.annotations?.readOnlyHint !== true || v2QuoteTool?.annotations?.destructiveHint !== false || v2QuoteTool?.annotations?.idempotentHint !== false) throw new Error("v2 quote annotations mismatch");
if (!/unranked fresh candidate.*direct_route_summary.*continuation_v3.*full-quote hash.*never auto-selects/i.test(v2QuoteTool?.description || "")) throw new Error("v2 quote continuation description mismatch");
if (!v2QuoteTool?.outputSchema?.required?.includes("direct_route_summary") || v2QuoteTool.outputSchema.properties?.direct_route_summary?.properties?.version?.const !== "assetfare-direct-route-summary-v1") throw new Error("v2 quote direct-route output schema mismatch");
if (!v2QuoteTool?.outputSchema?.required?.includes("continuation_v3") || v2QuoteTool.outputSchema.properties?.continuation_v3?.properties?.selection_status?.const !== "unranked_candidate" || v2QuoteTool.outputSchema.properties?.continuation_v3?.properties?.automatic_selection_forbidden?.const !== true) throw new Error("v2 quote continuation output schema mismatch");
if (names.some((name) => /sign|submit|send/i.test(name))) throw new Error("MCP must not expose transaction submission");
// New v2 execution tools: caller_approved is a required literal-true gate on prepare/session_create.
const v2PrepareTool = result.tools.find((tool) => tool.name === "assetfare_v2_prepare");
if (!v2PrepareTool?.inputSchema?.required?.includes("caller_approved") || !v2PrepareTool?.inputSchema?.required?.includes("wallets") || !v2PrepareTool?.inputSchema?.required?.includes("approval_v3") || !v2PrepareTool?.inputSchema?.required?.includes("verification_context")) throw new Error("v2 prepare must require caller approval, strict approval and verification context");
if (v2PrepareTool?.inputSchema?.properties?.approval_v3?.properties?.selected_mode?.const !== "one_shot" || v2PrepareTool?.outputSchema?.properties?.semantic_verification?.const !== true || !v2PrepareTool?.outputSchema?.required?.includes("caller_wallet_handoff")) throw new Error("v2 prepare verified output schema mismatch");
if (v2PrepareTool.inputSchema.properties.amount_usd?.minimum !== 1 || "maximum" in v2PrepareTool.inputSchema.properties.amount_usd) throw new Error("v2 prepare amount schema mismatch");
const v2SessionCreateTool = result.tools.find((tool) => tool.name === "assetfare_v2_session_create");
if (!v2SessionCreateTool?.inputSchema?.required?.includes("caller_approved") || !v2SessionCreateTool?.inputSchema?.required?.includes("session_token")) throw new Error("v2 session_create must require caller_approved and session_token");
if (!v2SessionCreateTool?.inputSchema?.required?.includes("approval_v3") || !v2SessionCreateTool?.inputSchema?.required?.includes("verification_context") || v2SessionCreateTool?.inputSchema?.properties?.approval_v3?.properties?.selected_mode?.const !== "session") throw new Error("v2 session strict context schema mismatch");
for (const name of ["assetfare_v2_session_get","assetfare_v2_session_observe_source","assetfare_v2_session_observe_output","assetfare_v2_session_refresh_action"]) if (!result.tools.find((tool)=>tool.name===name)?.inputSchema?.required?.includes("verification_context")) throw new Error(`${name} must require verification_context`);
if (v2SessionCreateTool.inputSchema.properties.amount_usd?.minimum !== 1 || "maximum" in v2SessionCreateTool.inputSchema.properties.amount_usd) throw new Error("v2 session_create amount schema mismatch");
const priorTransport = process.env.ASSETFARE_MCP_TRANSPORT;
process.env.ASSETFARE_MCP_TRANSPORT = "stdio";
const stdioCard = await serverCard("all");
if (!stdioCard.tools.some((tool) => tool.name === "assetfare_v2_new_session_capability") || stdioCard.tools.length !== 22) throw new Error("stdio local capability helper missing");
const legacyCard = await serverCard("legacy");
if (legacyCard.tools.length !== 13 || legacyCard.tools.some((tool) => tool.name.startsWith("assetfare_v2_"))) throw new Error("legacy MCP profile mismatch");
if (priorTransport === undefined) delete process.env.ASSETFARE_MCP_TRANSPORT; else process.env.ASSETFARE_MCP_TRANSPORT = priorTransport;
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
  const health = await getJson(port, "/healthz");
  const card = await getJson(port, "/.well-known/mcp/server-card.json");
  const legacyCardHttp = await getJson(port, "/.well-known/mcp/legacy-server-card.json");
  const canonicalA2ACard = await getJson(port, "/.well-known/agent-card.json");
  const canonicalMcpHead = await headStatus(port, "/mcp");
  const bridgeMcpHead = await headStatus(port, "/mcp/bridge");
  const legacyMcpHead = await headStatus(port, "/mcp/legacy");
  const optionRows=await Promise.all(["/mcp","/mcp/bridge","/mcp/legacy"].map((path)=>methodStatus(port,path,"OPTIONS")));
  const deleteRows=await Promise.all(["/mcp","/mcp/bridge","/mcp/legacy"].map((path)=>methodStatus(port,path,"DELETE")));
  const discoveryCards = await Promise.all([
    ["/discovery/a2aregistry/agent-card.json", "a2aregistry"],
    ["/discovery/apis-io/agent-card.json", "apis-io"],
    ["/discovery/manual/agent-card.json", "manual"],
  ].map(async ([path, channel]) => [channel, await getJson(port, path)]));
  if (health.status !== 200 || health.body?.version !== "1.3.6" || health.body?.server_signing !== false || health.body?.server_submission !== false) throw new Error("health contract mismatch");
  if (card.status !== 200 || card.body?.serverInfo?.version !== "1.3.6" || card.body?.tools?.length !== 9 || card.body?.profile !== "v2") throw new Error("remote server card contract mismatch");
  if (legacyCardHttp.status !== 200 || legacyCardHttp.body?.tools?.length !== 13 || legacyCardHttp.body?.profile !== "legacy") throw new Error("legacy server card contract mismatch");
  if (canonicalA2ACard.status !== 200) throw new Error("canonical A2A card unavailable");
  if (canonicalMcpHead.status !== 200 || bridgeMcpHead.status !== 200 || legacyMcpHead.status !== 200 || canonicalMcpHead.allow !== bridgeMcpHead.allow || canonicalMcpHead.allow !== legacyMcpHead.allow) throw new Error("MCP endpoint discovery mismatch");
  if(optionRows.some((row)=>row.status!==204||row.allow!==canonicalMcpHead.allow||row.methods!==canonicalMcpHead.allow))throw new Error("MCP OPTIONS contract mismatch");
  if(deleteRows.some((row)=>row.status!==200))throw new Error("MCP DELETE contract mismatch");
  for (const [channel, response] of discoveryCards) {
    if (response.status !== 200 || response.headers["x-assetfare-discovery-channel"] !== channel || JSON.stringify(response.body) !== JSON.stringify(canonicalA2ACard.body)) throw new Error(`A2A discovery channel mismatch:${channel}`);
  }
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

console.log(JSON.stringify({ status: "pass", tool_count: names.length, health_version: "1.3.6", remote_server_card_tools: 9, legacy_remote_tools:13, stdio_tools: 22, remote_session_secret_generation: false, discovery_channel_cards: 3, has_submission_tool: false, provenance_validation: true, a2a_version_http_status: 400, a2a_patch_version_accepted: true, a2a_http_integration: true }));
await client.close();
await server.close();
