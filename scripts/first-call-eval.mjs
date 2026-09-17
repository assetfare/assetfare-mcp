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
  const required = ["assetfare_v2_capabilities", "assetfare_v2_quote", "assetfare_manifest", "assetfare_quote", "assetfare_create_session"];
  const names = tools.tools.map((tool) => tool.name);
  const capabilities = parse(await client.callTool({ name: "assetfare_v2_capabilities", arguments: {} }));
  const quote = parse(await client.callTool({ name: "assetfare_v2_quote", arguments: { from_chain: "solana", from_token: "SOL", to_chain: "base", to_token: "USDC", amount_usd: 1 } }));
  const checks = {
    required_tools: required.every((name) => names.includes(name)),
    no_submission_tool: !names.some((name) => /sign|submit|send/i.test(name)),
    full_v2_scope: capabilities.public_api_enabled === true && capabilities.directed_conversion_routes === 72 && capabilities.asset_endpoints?.length === 9,
    server_non_custodial: capabilities.server_signing === false && capabilities.server_submission === false && quote.risk?.server_signing === false && quote.risk?.server_submission === false,
    capped_quote: quote.status === "capped_public_agent_release" && quote.intent?.amount_usd === 1 && quote.intent?.to === "base:USDC" && quote.execution?.supported === true,
    quote_only: quote.guidance?.legacyWorkflowCompatible === false && quote.guidance?.walletAuthenticationPerformed === false && quote.guidance?.sessionCreated === false && quote.guidance?.actionPrepared === false && quote.guidance?.transactionSigned === false && quote.guidance?.transactionSubmitted === false,
  };
  if (!Object.values(checks).every(Boolean)) throw new Error(JSON.stringify(checks));
  console.log(JSON.stringify({ status: "pass", endpoint, tool_count: names.length, checks }));
} finally {
  await client.close();
}
