# AssetFare project governance

AssetFare is maintained by a distributed project team. During the current
pilot, the public GitHub, npm, registry, and release namespace is administered
through the `@odaiin` account. The number of public accounts is not the number
of people contributing to engineering, review, integrations, or operations.

This document describes project roles and release controls. It is not a claim
that AssetFare is incorporated, licensed as a regulated intermediary, or
independently audited. Project-authored security reviews are identified as
such. AssetFare remains non-custodial software: it never receives customer
private keys and never signs or submits customer transactions.

## Project roles

- **Protocol engineering** maintains route construction, on-chain executor
  bindings, fee calculations, and receipt verification.
- **Security review** challenges trust boundaries, authorization gates,
  transaction provenance, failure recovery, and public claims.
- **Agent integrations** maintains MCP, A2A, OpenAPI, and supported framework
  adapters without adding server-side signing or submission.
- **Release operations** owns immutable release construction, signed-manifest
  rotation, deployment verification, monitoring, and rollback.
- **Documentation and ecosystem** maintains public capability descriptions,
  registry metadata, examples, and integration guidance.

One contributor may cover more than one role. A role name does not imply an
employment relationship or a separate legal entity.

## Change and release controls

1. Changes are reviewed against the non-custodial boundary and tested in the
   repository before release.
2. On-chain deployments require explicit, time-bounded authorization with
   transaction-count and gas-cost limits.
3. Public capability claims must match the signed manifest and live API.
4. The server must continue to return unsigned actions only; the caller
   independently verifies, signs, and submits.
5. Releases use immutable source revisions and are rolled back when live
   verification diverges from the reviewed contract.

## Reporting and participation

- Security reports: `security@assetfare.dev` or GitHub private vulnerability
  reporting, as described in [SECURITY.md](SECURITY.md).
- Bugs, integrations, documentation, and governance proposals: GitHub issues
  and pull requests in this repository.
- Material security decisions and on-chain evidence should be reproducible
  from public source, signed machine metadata, or transaction receipts.

