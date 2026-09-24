#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const output=execFileSync("npm",["pack","--dry-run","--json"],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
const report=JSON.parse(output)[0],files=new Set(report.files.map((entry)=>entry.path));
const required=[
  "test/continuation-fixture.mjs",
  "test/quote-fixture.mjs",
  "test/portable-quote-payload-fixture.json",
  "test/core-241-unsafe-integer-quote.json",
  "src/continuation-v3-selftest.js",
  "scripts/test-runner.mjs",
  "scripts/select-selftest.mjs",
  "scripts/plan-selftest.mjs",
  "scripts/route-eval-selftest.mjs",
];
for(const path of required)assert.ok(files.has(path),`packed artifact missing ${path}`);
assert.ok(files.has("package.json"));
assert.equal(report.name,"assetfare-mcp");
assert.equal(report.version,"1.2.0");
console.log(JSON.stringify({status:"pass",npm_pack_dry_run:true,entry_count:report.entryCount,required_test_support:required.length,missing:[],live_requests:false}));
