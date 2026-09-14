# AssetFare security policy

## Supported surface

Security reports may cover the public AssetFare route API, the remote MCP
compatibility adapter, machine-readable discovery artifacts, and the caller-
signed execution workflow currently published at `assetfare.dev`.

The public MCP wrapper is versioned as `0.1.x`; the live API publishes its
current version and immutable release commit through the signed manifest.

## Report a vulnerability privately

Use GitHub's private vulnerability reporting form:

https://github.com/odaiin/assetfare-mcp/security/advisories/new

Do not open a public issue for an unpatched vulnerability. Include affected
URLs or versions, impact, reproduction steps, and a minimal proof of concept.
Do not include private keys, seed phrases, bearer tokens, signed transactions,
or personal data. If a credential may have been exposed, revoke or rotate it
before reporting and provide only a redacted identifier.

## Safe testing boundaries

- Do not sign, approve, fund, or submit a transaction to demonstrate a report.
- Do not access another user's wallet, session, token, or data.
- Do not degrade the public service, bypass rate limits, or run load tests.
- Prefer isolated fixtures, public read-only endpoints, and minimal requests.
- A `security.txt` file does not grant authorization to test systems or funds.

AssetFare does not currently operate a bug-bounty program or promise a response
time during capped demand validation. Good-faith reports will be reviewed as
operational capacity permits.

## Product support

Use public GitHub issues only for non-sensitive product defects and
documentation questions:

https://github.com/odaiin/assetfare-mcp/issues
