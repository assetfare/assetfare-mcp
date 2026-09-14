# DefiLlama readiness

AssetFare does not submit a DefiLlama TVL adapter at first open.

The protocol is deliberately non-custodial: the executor has no persistent
user deposit balance, and destination funds are in caller-owned smart wallets
only briefly during a settlement. Counting those balances as protocol TVL would
misrepresent the product. DefiLlama's published methodology also excludes
smart-wallet balances from TVL.

## Revisit threshold

Reconsider a public listing only after both conditions are true:

1. At least 30 independently authenticated, non-owner completed routes are
   recorded in the privacy-minimized operations ledger.
2. There is a truthful on-chain metric to publish, such as a separately
   auditable protocol fee/revenue or bridge-volume adapter, rather than a
   transient customer balance.

At that point, fork `DefiLlama/DefiLlama-Adapters`, implement the relevant
adapter, test it against the deployed contracts, and submit a PR with the
methodology and public contract evidence. Do not claim TVL before a contract
actually holds protocol-owned or user-deposited assets.
