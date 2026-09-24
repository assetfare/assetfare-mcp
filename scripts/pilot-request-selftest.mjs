#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

const templateUrl = new URL(
  "../.github/ISSUE_TEMPLATE/assetfare-pilot.yml",
  import.meta.url,
);
if (!existsSync(templateUrl)) {
  console.log(JSON.stringify({
    status: "pass",
    source_only_pilot_template_check: "not_applicable_to_npm_tarball",
  }));
  process.exit(0);
}
const template = readFileSync(templateUrl, "utf8");

for (const value of [
  "name: Request a read-only AssetFare pilot",
  "id: agent_runtime",
  "id: source_chain",
  "id: source_asset",
  "id: destination_chain",
  "id: destination_asset",
  "id: amount_usd",
  "id: use_case",
  "id: success",
  "id: boundaries",
  "Underfunded agent or x402 payment wallet",
  "Cross-chain treasury rebalance",
  "this is not a directory, audit, or listing test",
]) {
  assert.ok(template.includes(value), `pilot request missing ${value}`);
}

for (const value of [
  "wallet address",
  "balance screenshot",
  "API token",
  "session token",
  "seed phrase",
  "private key",
  "signature",
  "signed transaction",
  "payment header",
]) {
  assert.match(template, new RegExp(`do not include[^\\n]*${value}`, "i"));
}

assert.equal((template.match(/required: true/g) || []).length, 11);
assert.match(template, /quote is an unranked candidate/i);
assert.match(template, /never signs or submits/i);
assert.match(template, /cannot prepare, sign, submit, or transfer funds/i);

console.log(JSON.stringify({
  status: "pass",
  structured_fields: 9,
  required_confirmations: 3,
  wallet_or_secret_fields: 0,
  quote_only_first: true,
}));
