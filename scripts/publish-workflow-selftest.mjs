#!/usr/bin/env node
import fs from "node:fs";

const path = new URL("../.github/workflows/publish-npm.yml", import.meta.url);
const text = fs.readFileSync(path, "utf8");

const required = [
  "workflow_dispatch:",
  "id-token: write",
  "contents: read",
  "runs-on: ubuntu-latest",
  "node-version: 24.19.0",
  "npm install --global npm@12.1.0",
  "fetch-depth: 0",
  "git merge-base --is-ancestor HEAD origin/main",
  "gh release view",
  "npm ci",
  "npm test",
  "npm audit --omit=dev --audit-level=high",
  "npm pack --dry-run",
  "Refusing to republish existing",
  "npm publish --access public",
];

for (const value of required) {
  if (!text.includes(value)) throw new Error(`missing trusted-publish guard: ${value}`);
}

const forbidden = [
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "secrets.",
  "npm stage",
  "pull_request_target:",
  "schedule:",
];
for (const value of forbidden) {
  if (text.includes(value)) throw new Error(`forbidden trusted-publish surface: ${value}`);
}

const verifyAt = text.indexOf("Verify immutable tag and package version");
const testAt = text.indexOf("Verify package");
const existingAt = text.indexOf("Refuse an existing registry version");
const publishAt = text.indexOf("Publish with short-lived npm OIDC credentials");
if (!(verifyAt >= 0 && verifyAt < testAt && testAt < existingAt && existingAt < publishAt)) {
  throw new Error("trusted-publish guard order mismatch");
}

console.log(JSON.stringify({
  status: "pass",
  authentication: "github_actions_oidc",
  long_lived_write_token: false,
  direct_publish: true,
  trigger: "workflow_dispatch",
  guards: required.length,
}));

