# AssetFare execution-core evidence snapshot

This directory is the public, minimal source/build snapshot for the five unique
Solidity executors referenced by AssetFare's signed safety bundle. It is not the
private API/backend repository and it is not a third-party audit.

The safety bundle at
`https://api.assetfare.dev/.well-known/assetfare-safety.json` pins the exact
commit of this public repository plus the SHA-256 of every source, artifact,
build script and lockfile. The separate `assetfare-verify --live` command binds
that hash-committed evidence to the Ed25519-signed release manifest and compares
the embedded expected runtime bytes with two independent RPC observations on
each deployed EVM chain.

To reproduce the local compiler and executable invariant evidence:

```bash
cd verification/core
npm ci --ignore-scripts
node compile_source_only_cctp_executor_v2.mjs
node compile_exact_one_bps_executors.mjs
node compile_destination_executor_v3.mjs
node agent_safety_invariants_preflight.mjs
```

The compile scripts overwrite local artifact files. Run them in a clean clone
and use `git diff --exit-code` to require byte-for-byte reproducibility. The
invariant script labels its output as executable project-authored evidence, not
as a formal proof, independent review, or guarantee that no unknown defect
exists.

No private key, RPC credential, deployment authorization, server session, or
customer data belongs in this directory.
