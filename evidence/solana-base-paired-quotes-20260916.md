# Solana SOL → Base ETH paired quote evidence

Two independent observation windows were collected on 2026-09-16. The second
window followed the reviewed quote-latency P1 release; the original window is
retained below rather than overwritten.

## Method

- 30 read-only pairs: 10 each at USD 250, 500, and 1,000.
- AssetFare and Relay received the same SOL lamport input.
- Public mainnet-canary addresses were used; the normalized data contains no
  wallet address, credential, signature, session, or transaction.
- No action was prepared, signed, or submitted.
- These operator measurements are evidence, not external customer demand.

## Post-P1 results

Observed from 2026-09-16 15:56:37 through 16:08:31 UTC.

| Amount | Samples | Mean expected-receive advantage | Mean minimum-receive advantage | AssetFare median latency | Relay median latency |
|---:|---:|---:|---:|---:|---:|
| $250 | 10 | +52.93 bp | +155.78 bp | 3.69s | 0.51s |
| $500 | 10 | +52.61 bp | +155.60 bp | 3.70s | 0.51s |
| $1,000 | 10 | +54.39 bp | +157.76 bp | 3.68s | 0.54s |
| Overall | 30 | **+53.31 bp** | **+156.38 bp** | **3.69s** | **0.51s** |

- AssetFare expected-receive advantage was positive in 30/30 observations,
  ranging from +38.90 to +62.06 bp.
- Minimum-receive advantage was positive in 30/30 observations, ranging from
  +141.54 to +164.97 bp.
- AssetFare latency ranged from 3.18 to 5.08 seconds; 0/30 observations exceeded
  10 seconds. All 30 requested pairs completed without a discarded error.

Normalized post-P1 data:
[paired-sol-base-quotes-p1-20260916.jsonl](./data/paired-sol-base-quotes-p1-20260916.jsonl)

## Pre-P1 baseline retained for comparison

Observed from 2026-09-16 13:40:02 through 14:26:33 UTC.

- Expected-receive advantage: 30/30 positive, mean +52.04 bp.
- Minimum-receive advantage: 30/30 positive, mean +154.82 bp.
- AssetFare median latency: 10.62 seconds versus Relay 0.52 seconds.
- AssetFare latency range: 4.85–21.07 seconds; 4/30 exceeded 20 seconds.
- One additional AssetFare attempt returned a fail-closed RPC-quorum 502 and
  was disclosed rather than included as a successful pair.

Normalized pre-P1 data:
[paired-sol-base-quotes-20260916.jsonl](./data/paired-sol-base-quotes-20260916.jsonl)

## Interpretation

These are historical observations, not price or latency guarantees. The second
window shows that the fee-inclusive advantage persisted after the latency
change while median AssetFare latency fell by about 65%. Every caller must still
request fresh executable quotes using its actual addresses and compare expected
receive, minimum receive, time, costs, step count, and non-atomic risk before
choosing a route. AssetFare never signs or submits.
