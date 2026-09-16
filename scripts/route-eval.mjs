#!/usr/bin/env node
import { createPublicKey, verify } from "node:crypto";

const DEFAULTS = {
  amount: 300,
  fromChain: "solana",
  fromToken: "SOL",
  toChain: "base",
  toToken: "ETH",
};

function usage() {
  return `AssetFare read-only route evaluator

Usage:
  npm run route-eval -- [options]
  node scripts/route-eval.mjs [options]

Options:
  --amount <USD>          Whole or decimal USD amount from 1 through 1000
  --from-chain <chain>    solana | base | arbitrum | robinhood
  --from-token <token>    SOL | ETH | USDC | USDG
  --to-chain <chain>      solana | base | arbitrum | robinhood
  --to-token <token>      SOL | ETH | USDC | USDG
  --assetfare-only        Skip Relay and Mayan comparison
  --compact               Emit compact JSON
  --help                  Show this message

Defaults: $300 solana:SOL -> base:ETH. The evaluator never authenticates a
wallet, creates a session, prepares an action, signs, or submits a transaction.`;
}

function option(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  if (index + 1 >= argv.length || argv[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return argv[index + 1];
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function jsonRequest(url, options = {}, label = "request") {
  const response = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      "user-agent": "AssetFareAgentRouteEval/1",
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${label} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    const message = body.error || body.message || body.msg || JSON.stringify(body);
    throw new Error(`${label} failed: HTTP ${response.status} ${message}`);
  }
  return body;
}

async function verifyManifest(apiBase, publicKeyUrlOverride) {
  const manifest = await jsonRequest(`${apiBase}/.well-known/assetfare-manifest.json`, {}, "manifest");
  const signature = manifest.signature;
  if (signature?.algorithm !== "Ed25519" || !signature.value) {
    throw new Error("manifest has no supported Ed25519 signature");
  }
  const publicKeyUrl = publicKeyUrlOverride || signature.public_key_url;
  if (!publicKeyUrl) throw new Error("manifest has no public key URL");
  const response = await fetch(publicKeyUrl, {
    headers: { "user-agent": "AssetFareAgentRouteEval/1" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`manifest public key failed: HTTP ${response.status}`);
  const pem = await response.text();
  const unsigned = structuredClone(manifest);
  delete unsigned.signature;
  const valid = verify(null, Buffer.from(canonical(unsigned)), createPublicKey(pem), Buffer.from(signature.value, "base64"));
  if (!valid) throw new Error("manifest signature verification failed");
  const validUntil = Date.parse(manifest.valid_until);
  if (!Number.isFinite(validUntil) || validUntil <= Date.now()) throw new Error("manifest is expired");
  return {
    valid: true,
    key_id: signature.key_id,
    release_commit: manifest.release_commit,
    valid_until: manifest.valid_until,
    multichain_release: manifest.execution?.multichain_v2?.release_status,
  };
}

function decimalUnits(rawValue, decimals) {
  const raw = BigInt(rawValue);
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function relayQuote(inputLamports, relayUrl) {
  const quote = await jsonRequest(relayUrl, {
    method: "POST",
    body: JSON.stringify({
      user: "11111111111111111111111111111111",
      originChainId: 792703809,
      destinationChainId: 8453,
      originCurrency: "11111111111111111111111111111111",
      destinationCurrency: "0x0000000000000000000000000000000000000000",
      amount: String(inputLamports),
      tradeType: "EXACT_INPUT",
      recipient: "0x0000000000000000000000000000000000000001",
    }),
  }, "Relay quote");
  const output = quote.details?.currencyOut;
  if (!output) throw new Error("Relay response has no output amount");
  return {
    provider: "relay",
    expected_receive_amount: Number(output.amountFormatted),
    minimum_receive_amount: Number(decimalUnits(output.minimumAmount, output.currency.decimals)),
    output_symbol: output.currency.symbol || "ETH",
    estimated_time_seconds: Number(quote.details?.timeEstimate) || null,
    notes: "Placeholder public addresses; comparison snapshot only",
  };
}

async function mayanQuote(inputLamports, mayanUrl) {
  const inputSol = decimalUnits(inputLamports, 9);
  const query = new URLSearchParams({
    amountIn: inputSol,
    fromToken: "So11111111111111111111111111111111111111112",
    fromChain: "solana",
    toToken: "0x0000000000000000000000000000000000000000",
    toChain: "base",
    slippageBps: "200",
    gasDrop: "0",
    swift: "true",
    mctp: "true",
    fastMctp: "true",
    wormhole: "true",
    fullList: "true",
    sdkVersion: "15_2_2",
  });
  const payload = await jsonRequest(`${mayanUrl}?${query}`, {}, "Mayan quote");
  const quotes = Array.isArray(payload.quotes) ? payload.quotes : [];
  const quote = quotes.sort((left, right) => Number(right.expectedAmountOut) - Number(left.expectedAmountOut))[0];
  if (!quote) throw new Error("Mayan returned no route");
  return {
    provider: "mayan",
    expected_receive_amount: Number(quote.expectedAmountOut),
    minimum_receive_amount: Number(quote.minAmountOut),
    output_symbol: "ETH",
    estimated_time_seconds: Number(quote.etaSeconds) || null,
    notes: `${quote.type || "route"}; placeholder public addresses; comparison snapshot only`,
  };
}

function settled(result) {
  if (result.status === "fulfilled") return { status: "available", ...result.value };
  return { status: "unavailable", error: result.reason instanceof Error ? result.reason.message : "request failed" };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help")) {
    console.log(usage());
    return;
  }
  const amountUsd = Number(option(argv, "--amount", DEFAULTS.amount));
  const fromChain = String(option(argv, "--from-chain", DEFAULTS.fromChain)).toLowerCase();
  const fromToken = String(option(argv, "--from-token", DEFAULTS.fromToken)).toUpperCase();
  const toChain = String(option(argv, "--to-chain", DEFAULTS.toChain)).toLowerCase();
  const toToken = String(option(argv, "--to-token", DEFAULTS.toToken)).toUpperCase();
  if (!Number.isFinite(amountUsd) || amountUsd < 1 || amountUsd > 1000) {
    throw new Error("amount must be a USD number from 1 through 1000");
  }
  if (fromChain === toChain && fromToken === toToken) throw new Error("identity route does not require a quote");

  const apiBase = process.env.ASSETFARE_API_BASE || "https://api.assetfare.dev";
  const publicKeyUrl = process.env.ASSETFARE_MANIFEST_PUBLIC_KEY_URL;
  const [manifest, capabilities, status] = await Promise.all([
    verifyManifest(apiBase, publicKeyUrl),
    jsonRequest(`${apiBase}/v2/capabilities`, {}, "capabilities"),
    jsonRequest(`${apiBase}/v2/status`, {}, "status"),
  ]);
  if (capabilities.public_api_enabled !== true || capabilities.server_signing !== false || capabilities.server_submission !== false) {
    throw new Error("public capability safety boundary is unavailable");
  }
  if (status.status !== "capped_public_agent_release" || status.server_signing !== false || status.server_submission !== false) {
    throw new Error("public provider status is not ready");
  }
  const endpointSet = new Set((capabilities.asset_endpoints || []).map((item) => `${item.chain}:${item.token}`));
  if (!endpointSet.has(`${fromChain}:${fromToken}`) || !endpointSet.has(`${toChain}:${toToken}`)) {
    throw new Error("requested chain/token endpoint is unsupported");
  }

  const quote = await jsonRequest(`${apiBase}/v2/quote`, {
    method: "POST",
    body: JSON.stringify({
      from_chain: fromChain,
      from_token: fromToken,
      to_chain: toChain,
      to_token: toToken,
      amount_usd: amountUsd,
    }),
  }, "AssetFare quote");
  if (quote.status !== "capped_public_agent_release" || quote.execution?.supported !== true) {
    throw new Error("AssetFare quote is not executable under the capped public release");
  }
  const expiresAt = new Date(Date.parse(quote.as_of) + Number(quote.ttl_seconds) * 1000).toISOString();
  const output = {
    status: "pass",
    evaluation_kind: "read_only_external_route_quote",
    requested_intent: { from_chain: fromChain, from_token: fromToken, to_chain: toChain, to_token: toToken, amount_usd: amountUsd },
    manifest,
    assetfare: {
      quote_id: quote.quote_id,
      as_of: quote.as_of,
      expires_at: expiresAt,
      expected_receive_amount: quote.offer?.expected_receive_amount,
      minimum_receive_amount: quote.offer?.estimated_min_receive_amount,
      output_symbol: quote.offer?.output_symbol,
      expected_receive_usd: quote.offer?.expected_receive_usd,
      minimum_receive_usd: quote.offer?.estimated_min_receive_usd,
      estimated_time_seconds: quote.offer?.estimated_time_seconds,
      assetfare_fee_bps: quote.offer?.assetfare_fee_bps,
      step_count: quote.route?.steps?.length,
      non_atomic: quote.risk?.non_atomic,
      server_signing: quote.risk?.server_signing,
      server_submission: quote.risk?.server_submission,
    },
    alternatives: {
      status: "not_requested",
      reason: "same-input Relay/Mayan comparison is currently implemented only for solana:SOL -> base:ETH",
    },
    safety: {
      wallet_authentication_performed: false,
      session_created: false,
      action_prepared: false,
      transaction_signed: false,
      transaction_submitted: false,
      requote_before_execution: true,
    },
  };

  const comparable = fromChain === "solana" && fromToken === "SOL" && toChain === "base" && toToken === "ETH";
  if (comparable && !argv.includes("--assetfare-only")) {
    const inputLamports = quote.intent?.estimated_input_base;
    if (!Number.isInteger(inputLamports) || inputLamports <= 0) throw new Error("AssetFare quote has no valid SOL input amount");
    const [relay, mayan] = await Promise.allSettled([
      relayQuote(inputLamports, process.env.ASSETFARE_RELAY_QUOTE_URL || "https://api.relay.link/quote"),
      mayanQuote(inputLamports, process.env.ASSETFARE_MAYAN_QUOTE_URL || "https://price-api.mayan.finance/v3/quote"),
    ]);
    const alternatives = [settled(relay), settled(mayan)];
    const candidates = [
      { provider: "assetfare", expected_receive_amount: Number(quote.offer.expected_receive_amount), output_symbol: quote.offer.output_symbol },
      ...alternatives.filter((item) => item.status === "available"),
    ].filter((item) => Number.isFinite(item.expected_receive_amount));
    candidates.sort((left, right) => right.expected_receive_amount - left.expected_receive_amount);
    output.alternatives = {
      status: "same_input_snapshot",
      input_lamports: inputLamports,
      providers: alternatives,
      highest_expected_receive_snapshot: candidates[0]?.provider || null,
      warning: "Comparison uses placeholder public addresses and is not an executable order. Requote every provider with the caller's real addresses before selection or signing.",
    };
  }

  console.log(JSON.stringify(output, null, argv.includes("--compact") ? 0 : 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "error", error: error instanceof Error ? error.message : "unknown error" }));
  process.exitCode = 1;
});
