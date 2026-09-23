#!/usr/bin/env node
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server.js";

const COMPLETE_ANNOTATIONS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
const FORBIDDEN_INPUT_NAMES = /(?:private[_-]?key|seed[_-]?phrase|signed[_-]?transaction)/iu;

function properties(tool) {
  return Object.entries(tool.inputSchema?.properties || {});
}

function auditDefinitions(tools) {
  assert.equal(tools.length, 21, "TDQS audit requires the complete remote public tool set");
  assert.equal(new Set(tools.map((tool) => tool.name)).size, tools.length, "tool names must be unique");

  const parameterized = tools.filter((tool) => properties(tool).length > 0);
  assert.equal(parameterized.length, 18, "unexpected parameterized tool count");

  for (const tool of tools) {
    assert.ok(tool.description?.trim(), `${tool.name}: missing description`);
    assert.ok(tool.description.length <= 700, `${tool.name}: description is too long for a concise tool catalog`);
    for (const annotation of COMPLETE_ANNOTATIONS) {
      assert.equal(typeof tool.annotations?.[annotation], "boolean", `${tool.name}: missing ${annotation}`);
    }

    for (const [name, schema] of properties(tool)) {
      assert.doesNotMatch(name, FORBIDDEN_INPUT_NAMES, `${tool.name}: secret material must not be accepted`);
      assert.ok(schema.description?.trim(), `${tool.name}.${name}: missing parameter description`);
    }
  }

  for (const tool of parameterized) {
    assert.match(tool.description, /\buse\b/iu, `${tool.name}: description must say when to use it`);
    assert.match(tool.description, /assetfare_[a-z0-9_]+/u, `${tool.name}: description must name a sibling boundary or alternative`);
    assert.match(tool.description, /(?:read-only|network request|server-side|session state|preparation state|challenge state|advances?|prepares? an action)/iu, `${tool.name}: behavior or side effects are not disclosed`);
    assert.match(tool.description, /(?:never|cannot|do not|only|instead|without)/iu, `${tool.name}: description must state a negative boundary`);
  }

  assert.equal(tools.some((tool) => tool.name === "assetfare_v2_new_session_capability"), false, "remote adapter must not generate a caller session secret");

  return { parameterized: parameterized.length };
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("TDQS self-test must not make network requests"); };

const server = createServer();
const client = new Client({ name: "assetfare-tdqs-selftest", version: "0.1.0" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

try {
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const summary = auditDefinitions(listed.tools);

  const missingParameterDescription = structuredClone(listed.tools);
  delete missingParameterDescription.find((tool) => tool.name === "assetfare_v2_quote").inputSchema.properties.amount_usd.description;
  assert.throws(() => auditDefinitions(missingParameterDescription), /missing parameter description/u);

  const vagueUsage = structuredClone(listed.tools);
  vagueUsage.find((tool) => tool.name === "assetfare_quote").description = "Get a quote.";
  assert.throws(() => auditDefinitions(vagueUsage), /when to use/u);

  const secretInput = structuredClone(listed.tools);
  secretInput.find((tool) => tool.name === "assetfare_v2_prepare").inputSchema.properties.private_key = { type: "string", description: "hostile regression" };
  assert.throws(() => auditDefinitions(secretInput), /secret material/u);

  console.log(JSON.stringify({
    status: "pass",
    tool_count: listed.tools.length,
    parameterized_tools: summary.parameterized,
    input_description_coverage_percent: 100,
    hostile_regressions_rejected: 3,
    documented_output_schemas: 0,
    remote_session_secret_generation: false,
    network_hits: 0,
  }));
} finally {
  globalThis.fetch = originalFetch;
  await client.close();
  await server.close();
}
