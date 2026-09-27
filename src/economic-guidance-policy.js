const CURRENT_POLICY_KEYS = [
  "amount_conditioned_routes",
  "automatic_external_fallback_forbidden",
  "economic_guidance",
  "economic_guidance_url",
  "external_coverage_only_route_count",
  "paxos_direct_ingress_routes",
  "primary_direct_route_count",
];

const LEGACY_POLICY_KEYS = [
  "amount_conditioned_routes",
  "automatic_external_fallback_forbidden",
  "external_coverage_only_route_count",
  "paxos_direct_ingress_routes",
  "primary_direct_route_count",
];

const PREVIOUS_HARD_FLOORS = {
  "ethereum:USDC->base:USDC": 500,
  "ethereum:USDC->solana:USDC": 500,
  "hyperevm:USDC->base:USDC": 250,
  "hyperevm:USDC->solana:USDC": 500,
};

const PAXOS_DIRECT_INGRESS_ROUTES = [
  "arbitrum:ETH->robinhood:ETH",
  "arbitrum:ETH->robinhood:USDG",
  "arbitrum:USDC->robinhood:ETH",
  "arbitrum:USDC->robinhood:USDG",
  "base:ETH->robinhood:ETH",
  "base:ETH->robinhood:USDG",
  "base:USDC->robinhood:ETH",
  "base:USDC->robinhood:USDG",
  "solana:SOL->robinhood:ETH",
  "solana:SOL->robinhood:USDG",
  "solana:USDC->robinhood:ETH",
  "solana:USDC->robinhood:USDG",
  "solana:USDG->robinhood:ETH",
  "solana:USDG->robinhood:USDG",
];

export const ECONOMIC_GUIDANCE_URL = "https://assetfare.dev/route-economics.json";

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function commonPolicyValid(policy) {
  return policy.primary_direct_route_count === 80
    && policy.external_coverage_only_route_count === 0
    && policy.automatic_external_fallback_forbidden === true
    && canonicalJson(policy.paxos_direct_ingress_routes) === canonicalJson(PAXOS_DIRECT_INGRESS_ROUTES);
}

export function validateExpandedEconomicPolicy(payload, parseGuidance) {
  const policy = payload?.route_product_policy;
  const packageFloor = payload?.caller_owned_agent_execution?.minimum_package_version;
  if (!policy || typeof policy !== "object" || Array.isArray(policy) || !commonPolicyValid(policy)) throw new Error("assetfare_economic_policy_invalid");

  const legacy = exactKeys(policy, LEGACY_POLICY_KEYS)
    && canonicalJson(policy.amount_conditioned_routes) === canonicalJson(PREVIOUS_HARD_FLOORS)
    && packageFloor === "1.11.0"
    && !Object.prototype.hasOwnProperty.call(payload, "economic_guidance");
  if (legacy) return { kind: "legacy_hard_floor_1_11", guidance: null };

  if (!exactKeys(policy, CURRENT_POLICY_KEYS)
      || canonicalJson(policy.amount_conditioned_routes) !== "{}"
      || !["1.12.0", "1.12.1", "1.13.0", "1.13.1"].includes(packageFloor)
      || policy.economic_guidance_url !== ECONOMIC_GUIDANCE_URL
      || !Object.prototype.hasOwnProperty.call(payload, "economic_guidance")) throw new Error("assetfare_economic_policy_invalid");
  let top;
  let nested;
  try {
    top = parseGuidance(payload.economic_guidance);
    nested = parseGuidance(policy.economic_guidance);
  } catch {
    throw new Error("assetfare_economic_policy_invalid");
  }
  if (canonicalJson(top) !== canonicalJson(nested)) throw new Error("assetfare_economic_policy_invalid");
  return { kind: "advisory_guidance_1_12", guidance: top };
}

export function validatePreExpansionEconomicPolicy(payload) {
  const policy = payload?.route_product_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("assetfare_economic_policy_invalid");
  const amountPolicy = policy.amount_conditioned_routes;
  if (amountPolicy !== undefined && canonicalJson(amountPolicy) !== "{}") throw new Error("assetfare_economic_policy_invalid");
}
