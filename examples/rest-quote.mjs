const endpoint = "https://api.assetfare.dev/v1/quote";
const amountUsd = Number(process.argv[2] || 300);

if (!Number.isInteger(amountUsd) || amountUsd < 250 || amountUsd > 1000) {
  throw new Error("amount must be a whole USD value from 250 through 1000");
}

const response = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "user-agent": "AssetFareRestQuoteExample/1",
  },
  body: JSON.stringify({
    from_chain: "solana",
    from_token: "SOL",
    to_chain: "base",
    to_token: "ETH",
    amount_usd: amountUsd,
  }),
  signal: AbortSignal.timeout(15_000),
});

const body = await response.json();
if (!response.ok) {
  throw new Error(`quote failed: HTTP ${response.status} ${JSON.stringify(body)}`);
}

console.log(JSON.stringify(body, null, 2));
