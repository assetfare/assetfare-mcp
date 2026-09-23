#!/usr/bin/env node
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const observed = [];
let origin;

const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin);
  const rawBody = await readBody(request);
  observed.push({ method: request.method, path: url.pathname, body: rawBody, query: Object.fromEntries(url.searchParams) });
  const send = (status, value, contentType = "application/json") => {
    response.writeHead(status, { "content-type": contentType });
    response.end(contentType === "application/json" ? JSON.stringify(value) : value);
  };
  if (url.pathname === "/manifest.pub") return send(200, publicPem, "text/plain");
  if (url.pathname === "/.well-known/assetfare-manifest.json") {
    const manifest = {
      service: "AssetFare",
      release_commit: "selftest",
      valid_until: new Date(Date.now() + 60_000).toISOString(),
      execution: { multichain_v2: { release_status: "capped_public_agent_release" } },
    };
    const signature = sign(null, Buffer.from(canonical(manifest)), privateKey).toString("base64");
    return send(200, { ...manifest, signature: { algorithm: "Ed25519", key_id: "selftest", public_key_url: `${origin}/manifest.pub`, value: signature } });
  }
  if (url.pathname === "/v2/capabilities") return send(200, {
    public_api_enabled: true,
    server_signing: false,
    server_submission: false,
    asset_endpoints: [{ chain: "solana", token: "SOL" }, { chain: "base", token: "USDC" }],
  });
  if (url.pathname === "/v2/status") return send(200, { status: "capped_public_agent_release", server_signing: false, server_submission: false });
  if (url.pathname === "/v2/quote") {
    const intent = JSON.parse(rawBody);
    return send(200, {
      quote_id: "quote-selftest",
      status: "capped_public_agent_release",
      as_of: new Date().toISOString(),
      ttl_seconds: 20,
      intent: { from: "solana:SOL", to: "base:USDC", amount_usd: intent.amount_usd, estimated_input_base: 10000000 },
      offer: { expected_receive_amount: intent.amount_usd - 0.0001, estimated_min_receive_amount: intent.amount_usd - 0.0051, output_symbol: "USDC", expected_receive_usd: intent.amount_usd - 0.0001, estimated_min_receive_usd: intent.amount_usd - 0.0051, estimated_time_seconds: 21, assetfare_fee_bps: 1 },
      route: { steps: [{ provider: "selftest" }] },
      risk: { non_atomic: true, server_signing: false, server_submission: false },
      execution: { supported: true },
    });
  }
  if (url.pathname === "/relay") return send(200, { details: { currencyOut: { amountFormatted: "0.000335", minimumAmount: "325000000000000", currency: { decimals: 18, symbol: "ETH" } }, timeEstimate: 2 } });
  if (url.pathname === "/mayan") return send(200, { quotes: [{ expectedAmountOut: "0.000332", minAmountOut: "0.00032", etaSeconds: 3, type: "MCTP" }] });
  return send(404, { error: "not_found" });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;

const child = spawn(process.execPath, [new URL("./route-eval.mjs", import.meta.url).pathname, "--compact", "--amount", "2500.25"], {
  env: {
    ...process.env,
    ASSETFARE_API_BASE: origin,
    ASSETFARE_MANIFEST_PUBLIC_KEY_URL: `${origin}/manifest.pub`,
    ASSETFARE_RELAY_QUOTE_URL: `${origin}/relay`,
    ASSETFARE_MAYAN_QUOTE_URL: `${origin}/mayan`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const exitCode = await new Promise((resolve) => child.on("close", resolve));
server.close();

if (exitCode !== 0) throw new Error(`route evaluator exited ${exitCode}: ${stderr}`);
const result = JSON.parse(stdout);
const quoteRequest = observed.find((item) => item.path === "/v2/quote");
const relayRequest = observed.find((item) => item.path === "/relay");
const mayanRequest = observed.find((item) => item.path === "/mayan");
const checks = {
  status_pass: result.status === "pass",
  manifest_verified: result.manifest?.valid === true,
  quote_read_only: result.safety?.wallet_authentication_performed === false && result.safety?.session_created === false && result.safety?.action_prepared === false && result.safety?.transaction_signed === false && result.safety?.transaction_submitted === false,
  assetfare_quote_posted: quoteRequest?.method === "POST" && JSON.parse(quoteRequest.body).to_token === "USDC" && JSON.parse(quoteRequest.body).amount_usd === 2500.25,
  usdc_default_is_assetfare_only: result.requested_intent?.to_token === "USDC" && result.alternatives?.status === "not_requested",
  no_false_eth_comparison: relayRequest === undefined && mayanRequest === undefined,
};
if (!Object.values(checks).every(Boolean)) throw new Error(JSON.stringify({ checks, observed, result }, null, 2));
console.log(JSON.stringify({ status: "pass", checks }));
