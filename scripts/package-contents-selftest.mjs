#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const output=execFileSync("npm",["pack","--dry-run","--json"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
const packReports=(value)=>Array.isArray(value)?value:Object.values(value);
const parsed=JSON.parse(output),reports=packReports(parsed);
assert.equal(reports.length,1,"npm pack must return exactly one package report");
const [report]=reports;
assert.ok(report&&Array.isArray(report.files),"npm pack report must include files");
assert.equal(packReports([report])[0],report,"npm 11 array-form pack JSON unsupported");
assert.equal(packReports({[report.name]:report})[0],report,"npm 12 object-form pack JSON unsupported");
const files=new Set(report.files.map((entry)=>entry.path));
const required=[
  "test/continuation-fixture.mjs",
  "test/quote-fixture.mjs",
  "test/action-bundle-fixture.mjs",
  "test/portable-quote-payload-fixture.json",
  "test/core-241-unsafe-integer-quote.json",
  "test/robinhood-usdg-solana-usdc-paxos-bundle.json",
  "test/robinhood-usdg-solana-usdc-orca-bundle.json",
  "test/solana-usdg-usdc-orca-one-bps-bundle.json",
  "test/robinhood-usdg-eth-swap-bundle.json",
  "src/continuation-v3-selftest.js",
  "src/caller-runner.js",
  "src/caller-runner-selftest.js",
  "src/caller-runner-exact-route-selftest.js",
  "src/standard-wallet-adapter.js",
  "src/standard-wallet-adapter-selftest.js",
  "src/trust-root.js",
  "scripts/test-runner.mjs",
  "scripts/select-selftest.mjs",
  "scripts/plan-selftest.mjs",
  "scripts/session-selftest.mjs",
  "scripts/caller-runner.mjs",
  "scripts/wallet-adapter-conformance.mjs",
  "schemas/caller-owned-execution-policy-v1.json",
  "schemas/caller-owned-execution-policy-v2.json",
  "examples/caller-wallet-adapter.mjs",
  "examples/my-agent-wallets.example.mjs",
  "scripts/remote-session-selftest.mjs",
  "scripts/a2a-session-selftest.mjs",
  "scripts/one-shot-selftest.mjs",
  "scripts/route-eval-selftest.mjs",
];
for(const path of required)assert.ok(files.has(path),`packed artifact missing ${path}`);
assert.ok(files.has("package.json"));
assert.equal(report.name,"assetfare-mcp");
assert.equal(report.version,"1.8.3");
console.log(JSON.stringify({status:"pass",npm_pack_dry_run:true,entry_count:report.entryCount,required_test_support:required.length,missing:[],live_requests:false}));
