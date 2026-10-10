const CURRENT_POLICY_KEYS = [
  "amount_conditioned_routes",
  "automatic_external_fallback_forbidden",
  "economic_guidance",
  "economic_guidance_url",
  "external_coverage_only_route_count",
  "paxos_direct_ingress_routes",
  "primary_direct_route_count",
];

const TARGET_POLICY_KEYS = [
  "active_route_count",
  "amount_conditioned_routes",
  "automatic_external_fallback_forbidden",
  "economic_guidance",
  "economic_guidance_url",
  "external_coverage_only_route_count",
  "inactive_route_count",
  "inactive_routes",
  "paxos_direct_ingress_routes",
  "primary_direct_route_count",
];

const AVAILABLE_POLICY_KEYS = [
  "active_route_count",
  "amount_conditioned_routes",
  "automatic_external_fallback_forbidden",
  "availability_only_route_count",
  "compare_required_route_count",
  "economic_guidance",
  "economic_guidance_blocks_execution",
  "economic_guidance_url",
  "external_coverage_only_route_count",
  "inactive_route_count",
  "inactive_routes",
  "nonrecommended_route_count",
  "paxos_direct_ingress_routes",
  "price_recommended_route_count",
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

const TARGET_PAXOS_DIRECT_INGRESS_ROUTES = [
  "arbitrum:USDC->robinhood:USDG",
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
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("assetfare_economic_policy_invalid");

  const availableCount = policy.primary_direct_route_count;
  const available = availableCount === 98 || availableCount === 100;
  if (available) {
    const compareRequired = availableCount - 54;
    const nonrecommended = availableCount - 44;
    const expectedPackageFloor = availableCount === 100 ? "1.18.0" : "1.16.0";
    if (!exactKeys(policy, AVAILABLE_POLICY_KEYS)
        || policy.external_coverage_only_route_count !== 0
        || policy.active_route_count !== availableCount
        || policy.price_recommended_route_count !== 44
        || policy.availability_only_route_count !== 10
        || policy.compare_required_route_count !== compareRequired
        || policy.nonrecommended_route_count !== nonrecommended
        || policy.inactive_route_count !== 0
        || !Array.isArray(policy.inactive_routes)
        || policy.inactive_routes.length !== 0
        || Object.keys(policy.amount_conditioned_routes || {}).length !== 44
        || canonicalJson(policy.paxos_direct_ingress_routes) !== canonicalJson(PAXOS_DIRECT_INGRESS_ROUTES)
        || policy.economic_guidance_blocks_execution !== false
        || policy.automatic_external_fallback_forbidden !== true
        || packageFloor !== expectedPackageFloor
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
    return { kind: availableCount === 100 ? "available_route_policy_1_17" : "available_route_policy_1_16", guidance: top };
  }

  const target = policy.primary_direct_route_count === 54;
  if (target) {
    if (!exactKeys(policy, TARGET_POLICY_KEYS)
        || policy.external_coverage_only_route_count !== 0
        || policy.active_route_count !== 54
        || policy.inactive_route_count !== 44
        || !Array.isArray(policy.inactive_routes)
        || policy.inactive_routes.length !== 44
        || new Set(policy.inactive_routes).size !== 44
        || Object.keys(policy.amount_conditioned_routes || {}).length !== 44
        || canonicalJson(policy.paxos_direct_ingress_routes) !== canonicalJson(TARGET_PAXOS_DIRECT_INGRESS_ROUTES)
        || policy.automatic_external_fallback_forbidden !== true
        || !["1.13.0", "1.14.0", "1.14.1", "1.14.2", "1.14.3", "1.14.4", "1.14.5", "1.15.0", "1.15.1", "1.15.3"].includes(packageFloor)
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
    return { kind: "active_route_policy_1_15", guidance: top };
  }

  if (!commonPolicyValid(policy)) throw new Error("assetfare_economic_policy_invalid");

  const legacy = exactKeys(policy, LEGACY_POLICY_KEYS)
    && canonicalJson(policy.amount_conditioned_routes) === canonicalJson(PREVIOUS_HARD_FLOORS)
    && packageFloor === "1.11.0"
    && !Object.prototype.hasOwnProperty.call(payload, "economic_guidance");
  if (legacy) return { kind: "legacy_hard_floor_1_11", guidance: null };

  if (!exactKeys(policy, CURRENT_POLICY_KEYS)
      || canonicalJson(policy.amount_conditioned_routes) !== "{}"
      || !["1.12.0", "1.12.1", "1.13.0", "1.13.1", "1.13.2"].includes(packageFloor)
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
