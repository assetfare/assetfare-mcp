# Solana SOL → Base USDC paired quote evidence

Observed from 2026-09-16 14:37:57 through 14:51:22 UTC.

## Method

- 30 read-only pairs: 10 each at USD 250, 500, and 1,000.
- AssetFare and Relay received the same SOL lamport input.
- Public mainnet-canary addresses were used; normalized data contains no wallet
  address, credential, signature, session, or transaction.
- No action was prepared, signed, or submitted.
- These operator measurements are evidence, not external customer demand.

## Results

| Amount | Samples | Mean expected-receive advantage | Mean minimum-receive advantage | AssetFare median latency | Relay median latency |
|---:|---:|---:|---:|---:|---:|
| $250 | 10 | +40.10 bp | +193.75 bp | 2.11s | 0.50s |
| $500 | 10 | +39.86 bp | +193.51 bp | 2.07s | 0.49s |
| $1,000 | 10 | +40.54 bp | +194.22 bp | 2.06s | 0.52s |
| Overall | 30 | **+40.17 bp** | **+193.83 bp** | **2.07s** | **0.50s** |

- Expected-receive advantage was positive in 30/30 observations, ranging from
  +27.38 to +45.15 bp.
- Minimum-receive advantage was positive in 30/30 observations, ranging from
  +180.83 to +198.85 bp.
- AssetFare latency ranged from 1.96 to 2.80 seconds.
- Two additional attempts were rejected rather than included: one HTTP 429
  rate limit and one fail-closed HTTP 502 provider error. Collection resumed
  until all three amount buckets held ten valid pairs.

## Interpretation

This exact `hold SOL, receive USDC on Base` route is the most relevant evidence
for an agent-payment integration. The observation shows a smaller expected-
receive advantage than the ETH-output path but much lower AssetFare latency.
It remains historical evidence rather than a price guarantee. Agents must
request fresh quotes and compare expected receive, minimum receive, time, costs,
step count, and non-atomic risk before route selection.

Normalized source data: [paired-sol-base-usdc-quotes-20260916.jsonl](./data/paired-sol-base-usdc-quotes-20260916.jsonl)
