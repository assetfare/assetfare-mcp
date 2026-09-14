import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

const server = createServer();
const client = new Client({ name: "assetfare-mcp-selftest", version: "0.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
const result = await client.listTools();
const names = result.tools.map((tool) => tool.name).sort();
const required = ["assetfare_manifest", "assetfare_quote", "assetfare_start_wallet_auth", "assetfare_create_session", "assetfare_observe_destination"];
if (!required.every((name) => names.includes(name))) throw new Error("required MCP tools missing");
if (names.some((name) => /sign|submit|send/i.test(name))) throw new Error("MCP must not expose transaction submission");
console.log(JSON.stringify({ status: "pass", tool_count: names.length, has_submission_tool: false }));
await client.close();
await server.close();
