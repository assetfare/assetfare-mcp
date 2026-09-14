#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const endpoint = process.env.ASSETFARE_MCP_ENDPOINT || "https://api.assetfare.dev/mcp";
const client = new Client({ name: "assetfare-first-call-eval", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));

function parse(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("MCP tool returned no text content");
  return JSON.parse(text);
}

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const required = ["assetfare_manifest", "assetfare_status", "assetfare_quote", "assetfare_start_wallet_auth", "assetfare_create_session"];
  const names = tools.tools.map((tool) => tool.name);
  const manifest = parse(await client.callTool({ name: "assetfare_manifest", arguments: {} }));
  const status = parse(await client.callTool({ name: "assetfare_status", arguments: {} }));
  const quote = parse(await client.callTool({ name: "assetfare_quote", arguments: { amount_usd: 300 } }));
  const checks = {
    required_tools: required.every((name) => names.includes(name)),
    no_submission_tool: !names.some((name) => /sign|submit|send/i.test(name)),
    self_service: status.self_service_wallet_authentication_enabled === true,
    server_non_custodial: status.server_submission === false && manifest.execution.server_submission === false,
    signed_manifest: manifest.signature?.algorithm === "Ed25519" && Boolean(manifest.signature?.public_key_url),
    capped_quote: quote.status === "available" && quote.intent?.amount_usd === 300 && quote.execution?.supported === true,
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(JSON.stringify(checks));
  console.log(JSON.stringify({ status: "pass", endpoint, tool_count: names.length, checks }));
} finally {
  await client.close();
}
