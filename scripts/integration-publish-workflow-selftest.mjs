#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const rootPath = fileURLToPath(root);
const read = path => fs.readFileSync(new URL(path, root), "utf8");
const readJson = path => JSON.parse(read(path));
const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");
const count = (text, value) => text.split(value).length - 1;

const releasePath = ".github/workflows/release-integration-provenance.yml";
const publishPath = ".github/workflows/publish-integration-npm.yml";
const release = read(releasePath);
const publish = read(publishPath);

const packages = [
  ["assetfare-agentkit-action-provider", "integrations/coinbase-agentkit"],
  ["assetfare-elizaos-route-plugin", "integrations/elizaos"],
  ["assetfare-solana-agent-kit-plugin", "integrations/solana-agent-kit"],
];
const exactChoiceBlock = `        type: choice
        options:
          - assetfare-agentkit-action-provider
          - assetfare-elizaos-route-plugin
          - assetfare-solana-agent-kit-plugin`;

const section = (text, start, end) => {
  const from = text.indexOf(start);
  const to = end ? text.indexOf(end, from + start.length) : text.length;
  if (from < 0 || to < 0) return "";
  return text.slice(from, to);
};

function securityErrors(releaseText, publishText) {
  const errors = [];
  const requireIn = (text, label, values) => {
    for (const value of values) if (!text.includes(value)) errors.push(`${label}: missing ${value}`);
  };
  const releaseBuild = section(releaseText, "  build-candidate:", "  attest-and-release:");
  const releasePrivileged = section(releaseText, "  attest-and-release:");
  const publishBuild = section(publishText, "  build-candidate:", "  publish:");
  const publishPrivileged = section(publishText, "  publish:");

  for (const [label, text] of [[releasePath, releaseText], [publishPath, publishText]]) {
    requireIn(text, label, [
      exactChoiceBlock,
      "workflow_dispatch:",
      "if: startsWith(github.ref, 'refs/tags/')",
      "ref: ${{ github.ref }}",
      "EXPECTED_VERSION: 0.1.1",
      "DIRECT_ROUTE_BASELINE: b886620ee5d675aa51a272105a0148f88558a879",
      "node-version: 24.19.0",
      "npm install --global npm@12.1.0",
      "test \"$GITHUB_REF\" = \"refs/tags/$RELEASE_TAG\"",
      "test \"$GITHUB_SHA\" = \"$tag_commit\"",
      "git merge-base --is-ancestor",
      "verify-commit",
      "verification/assetfare-release-signers",
      "npm ci",
      "npm run check",
      "npm test",
      "npm run build",
      "npm audit --omit=dev --audit-level=high",
      "npm pack --dry-run",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    ]);
    if (count(text, "type: choice") !== 1) errors.push(`${label}: choice input count`);
    for (const [name, directory] of packages) {
      requireIn(text, label, [`${name})`, `${name}-v0.1.1`]);
      if (!text.includes(`directory=\"${directory}\"`)) errors.push(`${label}: directory ${directory}`);
    }
    for (const forbidden of [
      "NODE_AUTH_TOKEN", "NPM_TOKEN", "secrets.", "_authToken", "npm login",
      "pull_request_target:", "pull_request:\n", "schedule:", "push:\n", "\n  release:",
      "runs-on: self-hosted", "--clobber", "refs/heads/main",
    ]) {
      if (text.includes(forbidden)) errors.push(`${label}: forbidden ${forbidden}`);
    }
  }

  for (const [label, build] of [["release build", releaseBuild], ["publish build", publishBuild]]) {
    requireIn(build, label, ["permissions:\n      contents: read", "npm ci", "npm test", "npm run build", "npm audit", "npm pack --json"]);
    for (const forbidden of ["contents: write", "id-token: write", "attestations: write", "GH_TOKEN", "gh release upload", "npm publish", "attest-build-provenance@"]) {
      if (build.includes(forbidden)) errors.push(`${label}: privileged surface ${forbidden}`);
    }
  }
  for (const [label, privileged] of [["release privileged", releasePrivileged], ["publish privileged", publishPrivileged]]) {
    for (const forbidden of ["npm ci", "npm test", "npm run build", "npm audit", "npm pack --dry-run", "npm pack --json"]) {
      if (privileged.includes(forbidden)) errors.push(`${label}: lifecycle ${forbidden}`);
    }
    requireIn(privileged, label, ["GH_TOKEN: ${{ github.token }}", "npm error code //p", "npm_error_code", 'test "$npm_error_code" = "E404"']);
    if (privileged.includes("2>&1") || privileged.includes("|| true")) errors.push(`${label}: ambiguous npm/network handling`);
  }

  requireIn(releasePrivileged, "release privileged", [
    "contents: write", "id-token: write", "attestations: write",
    "actions/attest-build-provenance@96278af6caaf10aea03fd8d33a09a777ca52d62f",
    "reverify_release_identity()", "reverify_release_identity\n              gh release upload",
    'cmp "$candidate/$name" "$existing/$name"',
    'test -z "$found" || test "$found" = "$ARTIFACT" || test "$found" = "$ARTIFACT.sha256"',
    'test "$actual" = "$expected"',
  ]);
  if (count(releasePrivileged, 'test "$npm_error_code" = "E404"') < 2)
    errors.push("release privileged: initial and final E404 classification required");

  requireIn(publishPrivileged, "publish privileged", [
    "id-token: write", "attestations: read", "Refusing conflicting",
    'test "$GITHUB_SHA" = "$EXPECTED_TAG_COMMIT"',
    "npm publish \"$artifact_path\" --access public",
    "dist-tags.latest", "dist.shasum", "dist.attestations.provenance.predicateType",
  ]);

  for (const text of [releasePrivileged, publishPrivileged]) {
    requireIn(text, "attestation pin", [
      "--signer-workflow assetfare/assetfare-mcp/.github/workflows/release-integration-provenance.yml",
      '--source-ref "refs/tags/$RELEASE_TAG"',
      "--source-digest",
      "--deny-self-hosted-runners",
    ]);
  }
  return errors;
}

const errors = securityErrors(release, publish);
if (errors.length) throw new Error(errors.join("\n"));

const hostileCases = [
  ["non-E404 registry error accepted", release.replaceAll('test "$npm_error_code" = "E404"', 'test -n "$npm_error_code"') , publish],
  ["tag/source TOCTOU pin removed", release.replaceAll("$GITHUB_SHA", "$UNPINNED_SHA"), publish.replaceAll("$GITHUB_SHA", "$UNPINNED_SHA")],
  ["partial release asset bytes not compared", release.replaceAll('cmp "$candidate/$name" "$existing/$name"', ": # comparison removed"), publish],
  ["dependency lifecycle receives privileged token", release.replace("permissions:\n      contents: read\n    env:", "permissions:\n      contents: read\n      id-token: write\n    env:\n      GH_TOKEN: ${{ github.token }}"), publish],
];
for (const [name, hostileRelease, hostilePublish] of hostileCases) {
  if (securityErrors(hostileRelease, hostilePublish).length === 0)
    throw new Error(`hostile workflow accepted: ${name}`);
}

for (const [name, directory] of packages) {
  const manifest = readJson(`${directory}/package.json`);
  const lock = readJson(`${directory}/package-lock.json`);
  if (manifest.name !== name || manifest.version !== "0.1.1" || manifest.publishConfig?.access !== "public")
    throw new Error(`${directory}: manifest identity mismatch`);
  if (manifest.repository?.url !== "https://github.com/assetfare/assetfare-mcp.git" || manifest.repository?.directory !== directory)
    throw new Error(`${directory}: repository identity mismatch`);
  if (lock.name !== name || lock.version !== "0.1.1" || lock.packages?.[""]?.name !== name || lock.packages?.[""]?.version !== "0.1.1")
    throw new Error(`${directory}: lockfile identity mismatch`);
}

if (sha256(read(".github/workflows/publish-npm.yml")) !== "65bff146afcda9ae32b1cabb2bd82aa5dc92f0990ee141a9bf86afc7e6f6ce22")
  throw new Error("root v1.x publish workflow changed");
if (sha256(read(".github/workflows/release-provenance.yml")) !== "657f94aaac7f1a204f73d5b737803adb2e7a1447fdc94a21d411226c014efeac")
  throw new Error("root v1.x provenance workflow changed");
if (read("verification/assetfare-release-signers").trim() !== "twotw55@gmail.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG0JPPzCA4Dp35CMBU7TH75t3+/iqgJ5PErHS2uy4GQP")
  throw new Error("release signer allowlist mismatch");

execFileSync("git", ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${fileURLToPath(new URL("verification/assetfare-release-signers", root))}`, "verify-commit", "HEAD"], { cwd: rootPath, stdio: "pipe" });

const readme = read("README.md");
for (const value of ["publish-integration-npm.yml", "release-integration-provenance.yml", "assetfare-agentkit-action-provider-v0.1.1", "assetfare-elizaos-route-plugin-v0.1.1", "assetfare-solana-agent-kit-plugin-v0.1.1", "Do not dispatch either integration release workflow", "--ref"]) {
  if (!readme.includes(value)) throw new Error(`README missing integration prerequisite: ${value}`);
}

console.log(JSON.stringify({
  status: "pass",
  authentication: "github_actions_oidc",
  longLivedWriteToken: false,
  exactTagRefRequired: true,
  privilegeSeparated: true,
  hostileRegressionsRejected: hostileCases.length,
  integrationPackages: packages.length,
  exactVersion: "0.1.1",
  signedHead: true,
  rootV1WorkflowsUnchanged: true,
}));
