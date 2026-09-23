const endpoint = "https://api.assetfare.dev/v2/quote";
const amountUsd = Number(process.argv[2] || 1);
const fromChain = String(process.argv[3] || "solana").toLowerCase();
const fromToken = String(process.argv[4] || "SOL").toUpperCase();
const toChain = String(process.argv[5] || "base").toLowerCase();
const toToken = String(process.argv[6] || "USDC").toUpperCase();

if (!Number.isFinite(amountUsd) || amountUsd < 1) {
  throw new Error("amount must be a finite USD number of at least 1");
}

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "user-agent": "AssetFareRestQuoteExample/1",
  },
  body: JSON.stringify({
    from_chain: fromChain,
    from_token: fromToken,
    to_chain: toChain,
    to_token: toToken,
    amount_usd: amountUsd,
  }),
  signal: AbortSignal.timeout(15_000),
});

const body = await response.json();
if (!response.ok) {
  throw new Error(`quote failed: HTTP ${response.status} ${JSON.stringify(body)}`);
}

console.log(JSON.stringify(body, null, 2));
