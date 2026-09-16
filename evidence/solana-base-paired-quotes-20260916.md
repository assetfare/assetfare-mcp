# Solana SOL → Base ETH paired quote evidence

Observed from 2026-09-16 13:40:02 through 14:26:33 UTC.

## Method

- 30 read-only pairs: 10 each at USD 250, 500, and 1,000.
- AssetFare and Relay received the same SOL lamport input.
- Public mainnet-canary addresses were used; the normalized data contains no
  wallet address, credential, signature, session, or transaction.
- No action was prepared, signed, or submitted.
- These operator measurements are evidence, not external customer demand.

## Results

| Amount | Samples | Mean expected-receive advantage | Mean minimum-receive advantage | AssetFare median latency | Relay median latency |
|---:|---:|---:|---:|---:|---:|
| $250 | 10 | +52.40 bp | +155.26 bp | 8.72s | 0.55s |
| $500 | 10 | +49.27 bp | +152.01 bp | 13.64s | 0.51s |
| $1,000 | 10 | +54.45 bp | +157.19 bp | 13.65s | 0.52s |
| Overall | 30 | **+52.04 bp** | **+154.82 bp** | **10.62s** | **0.52s** |

- AssetFare expected-receive advantage was positive in 30/30 observations,
  ranging from +30.42 to +65.26 bp.
- Minimum-receive advantage was positive in 30/30 observations, ranging from
  +133.22 to +173.46 bp.
- AssetFare latency ranged from 4.85 to 21.07 seconds; 4/30 observations took
  more than 20 seconds.
- One additional AssetFare attempt returned a fail-closed RPC-quorum 502 and is
  disclosed rather than included as a successful pair.

## Interpretation

This is a historical observation, not a price guarantee. It supports a
fee-inclusive AssetFare advantage over Relay for this corridor and time window,
but also shows a substantial latency disadvantage. Every caller must request
fresh executable quotes using its actual addresses and compare expected receive,
minimum receive, time, costs, step count, and non-atomic risk before choosing a
route.

The read-only agent evaluator and framework adapters now allow 45 seconds for a
quote because four valid observations exceeded the earlier 20-second client
timeout. AssetFare still never signs or submits.

Normalized source data: [paired-sol-base-quotes-20260916.jsonl](./data/paired-sol-base-quotes-20260916.jsonl)
