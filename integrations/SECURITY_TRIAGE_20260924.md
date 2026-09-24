# Integration dependency security triage — 2026-09-24

This note records the open GitHub Dependabot and Scorecard/code-scanning findings
against the dependency graph at commit `60b522884cbfca8893d87263fb9cf8cc4779608d`.
The integration packages are development/reference trees; none of their
dependencies are installed by the root `assetfare-mcp` production package.

## Production boundary

- Root `npm audit --omit=dev`: 0 vulnerabilities.
- Every integration `npm audit --omit=dev`: 0 vulnerabilities because the
  framework SDKs are development-only compatibility fixtures.
- No `npm audit fix --force` result is acceptable. npm currently proposes a
  misleading Solana Agent Kit downgrade from `2.0.7` to `2.0.1`; do not apply it.

## Implemented candidate

Dependabot alert 2 (`integrations/agenti`, `ai`) can be removed without an
override. The candidate moves the unpublished adapter from Vercel AI SDK
`4.3.19` to `5.0.207`, changes tool declarations from `parameters` to the SDK 5
`inputSchema` contract, and widens the package's declared peer only to the
tested SDK 5 major.

`5.0.207` is intentional: it is the first SDK 5 release whose dependency set
also contains the fixed `@ai-sdk/provider-utils@3.0.28`. At the triage date,
newer `ai@5.0.223` through `5.0.265` resolve to an `undici` range with open
advisories and fail a full development audit. The candidate passes check,
tests, build, production audit, full audit, and package dry-run without a live
AssetFare request.

## Solana Agent Kit constraints

The installed chain is `solana-agent-kit@2.0.7`. The current upstream
`2.0.10` retains the same relevant dependency ranges, so a patch upgrade does
not resolve these alerts:

| Alerts | Installed path | Fixed version | Why no safe local fix |
| --- | --- | --- | --- |
| 18–21 | `@langchain/core@0.3.80 -> langsmith@0.3.87` | `langsmith@0.6.0` for the remaining high advisory | `@langchain/core@0.3.80` declares `langsmith@^0.3.67`; the fix is outside the supported range. |
| 17 | `solana-agent-kit -> ai@4.3.19` | `ai@5.0.52` (and `5.0.207` for the later provider-utils advisory) | Every released `solana-agent-kit@2.0.x` still declares `ai@^4.1.5`; forcing SDK 5 crosses its API contract. |
| 22 | `@langchain/core -> uuid@10.0.0`; `jayson@4.3.0 -> uuid@8.3.2` | `uuid@11.1.1` | Both fixed versions are outside the parents' declared major ranges. |
| 24 | `@solana/web3.js@1.99.0 -> jayson@4.3.0 -> stream-json@1.9.1` | `stream-json@3.5.0` | The fix crosses two unsupported major versions under `jayson`; current `@solana/web3.js@1.99.0` still uses Jayson 4. |
| 15 | `@solana/spl-token -> @solana/buffer-layout-utils@0.3.0 -> bigint-buffer@1.1.5` | none | `bigint-buffer@1.1.5` is the latest release and the advisory has no patched version. |

Do not add top-level overrides for these packages. They would make the lockfile
look quieter while violating the upstream compatibility constraints, and the
local read-only adapter tests do not exercise the affected framework internals.
Track a Solana Agent Kit release that updates its AI and LangChain contracts,
an `@solana/web3.js` release off Jayson 4, and an SPL buffer-layout replacement.

## Other open integration alerts

- Coinbase AgentKit alerts 5, 6, 9, 11, and 12 are transitive through the
  pinned `@coinbase/agentkit@0.10.4`: `bigint-buffer` and `elliptic` have no
  patched release; the `uuid`, `decode-uri-component`, and `stream-json` fixes
  cross parent-supported major ranges. Treat them as upstream constraints.
- ElizaOS alert 13 is the same no-patch `elliptic` advisory through
  `@elizaos/core@1.7.2 -> crypto-browserify`.

## Scorecard/code-scanning alerts

The open code-scanning entries are Scorecard policy signals, not CodeQL source
findings. `PinnedDependenciesID` points at the already exact
`npm@12.1.0` bootstrap in the trusted-publishing workflow and asks for a hash,
which npm's global-install command does not accept as an integrity parameter.
Changing the release authentication path only to silence that signal is out of
scope for a development dependency patch. `CII-Best-Practices`, `Code-Review`,
`Maintained`, `Vulnerabilities`, and `Fuzzing` likewise require repository
policy/upstream remediation rather than a safe integration lockfile change.
