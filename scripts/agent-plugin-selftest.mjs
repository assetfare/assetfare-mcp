#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const packageMetadata = readJson("package.json");
const plugin = readJson("plugin.json");
const mcp = readJson("mcp.json");
const compatibilityPlugin = readJson(".plugin/plugin.json");
const compatibilityMcp = readJson(".mcp.json");
const skill = readFileSync(
  join(root, "skills/assetfare-route/SKILL.md"),
  "utf8",
);
const readme = readFileSync(join(root, "README.md"), "utf8");

const publicEndpoint = "https://api.assetfare.dev/mcp";
const allowedPluginKeys = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

assert.deepEqual(
  Object.keys(plugin).filter((key) => !allowedPluginKeys.has(key)),
  [],
  "portable plugin manifest has unknown core fields",
);
assert.equal(
  plugin.$schema,
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
);
assert.equal(plugin.name, "assetfare");
assert.equal(plugin.version, packageMetadata.version);
assert.equal(plugin.license, "MIT");
assert.equal(plugin.author?.email, "support@assetfare.dev");
assert.match(plugin.description, /never signs or submits transactions/i);
assert.doesNotMatch(plugin.description, /^read-only/i);

assert.equal(
  mcp.$schema,
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
);
assert.deepEqual(Object.keys(mcp.mcpServers || {}), ["assetfare"]);
assert.deepEqual(mcp.mcpServers.assetfare, {
  type: "streamable-http",
  url: publicEndpoint,
});

assert.equal(compatibilityPlugin.name, plugin.name);
assert.equal(compatibilityPlugin.version, plugin.version);
assert.equal(compatibilityPlugin.description, plugin.description);
assert.deepEqual(compatibilityPlugin.keywords, plugin.keywords);
assert.equal(compatibilityPlugin.skills, "./skills/");
assert.equal(compatibilityPlugin.mcpServers, "./.mcp.json");
assert.deepEqual(compatibilityMcp.mcpServers.assetfare, {
  type: "http",
  url: publicEndpoint,
});

assert.match(skill, /^name:\s*assetfare-route\s*$/m);
assert.match(readme, /npx plugins add assetfare\/assetfare-mcp/);
assert.match(readme, /primary remote endpoint\s+exposes nine current v2 tools/i);
assert.match(
  readme,
  /legacy tools remain available at the separate `\/mcp\/legacy`/i,
);

const serialized = JSON.stringify({
  plugin,
  mcp,
  compatibilityPlugin,
  compatibilityMcp,
});
assert.doesNotMatch(
  serialized,
  /private[_ -]?key|seed phrase|bearer\s+[a-z0-9]/i,
);

console.log(
  JSON.stringify({
    status: "pass",
    version: plugin.version,
    portable_schema: "1.0.0",
    skill: "assetfare-route",
    mcp_server: "assetfare",
    mcp_headers_configured: false,
    mcp_config_credentials_embedded: false,
    description_boundary_checked: true,
  }),
);
