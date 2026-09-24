#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const packaged=[
  "src/continuation-v3-selftest.js",
  "src/selftest.js",
  "src/tdqs-selftest.js",
  "src/v2-selftest.js",
  "src/v2-session-selftest.js",
  "src/a2a-selftest.js",
  "scripts/bin-entrypoint-selftest.mjs",
  "scripts/select-selftest.mjs",
  "scripts/plan-selftest.mjs",
  "scripts/route-eval-selftest.mjs",
  "scripts/package-contents-selftest.mjs",
  "scripts/assetfare-verify-selftest.mjs",
];
const sourceOnly=[
  "scripts/agent-plugin-selftest.mjs",
  "scripts/pilot-request-selftest.mjs",
  "scripts/publish-workflow-selftest.mjs",
  "scripts/integration-publish-workflow-selftest.mjs",
];
const sourceCheckout=existsSync(resolve(root,".git"));
for(const path of [...packaged,...(sourceCheckout?sourceOnly:[])]){
  const result=spawnSync(process.execPath,[path],{cwd:root,stdio:"inherit",env:process.env});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
if(!sourceCheckout)console.log(JSON.stringify({status:"pass",packaged_runtime_suite:true,source_only_release_checks:"not_applicable_to_npm_tarball"}));
