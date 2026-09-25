#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), "assetfare-bin-entrypoints-"));
const binDirectory = join(fixture, "node_modules", ".bin");
const packageDirectory = join(fixture, "node_modules", "assetfare-mcp");

function execute(entrypoint) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, "--help"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

try {
  await mkdir(binDirectory, { recursive: true });
  await symlink(root, packageDirectory, "dir");
  const bins = [
    ["assetfare-mcp", "src/server.js", /AssetFare MCP server/],
    ["assetfare-plan", "scripts/plan.mjs", /Usage:\s+assetfare-plan[\s\S]*--select-exact-quote-bounds/],
    ["assetfare-session", "scripts/session.mjs", /Usage:\s+assetfare-session[\s\S]*observe-source/],
    ["assetfare-select", "scripts/select.mjs", /Usage:\s+assetfare-select[\s\S]*--maximum-input-base/],
    ["assetfare-route-eval", "scripts/route-eval.mjs", /AssetFare read-only route evaluator/],
    ["assetfare-verify", "scripts/assetfare-verify.mjs", /Usage:\s+assetfare-verify/],
  ];
  for (const [name, target, expected] of bins) {
    const entrypoint = join(binDirectory, name);
    await symlink(join("..", "assetfare-mcp", target), entrypoint);
    const result = await execute(entrypoint);
    assert.equal(result.status, 0, `${name} exit status; stderr=${result.stderr}`);
    assert.equal(result.signal, null, `${name} signal`);
    assert.equal(result.stderr, "", `${name} stderr`);
    assert.match(result.stdout, expected, `${name} help output`);
  }
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log(JSON.stringify({ status: "pass", npm_symlink_bin_entrypoints: 6, live_requests: false }));
