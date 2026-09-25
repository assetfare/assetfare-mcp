import type { Action, Plugin, SolanaAgentKit } from "solana-agent-kit";
import { z } from "zod";
import { validateQuoteDirectRoute } from "./directRouteSummary.js";

export { validateQuoteDirectRoute } from "./directRouteSummary.js";

type Fetch = typeof fetch;
type JsonRecord = Record<string, unknown>;
const MAX_RESPONSE_BYTES = 1_048_576;

const TOKENS_BY_CHAIN = {
  solana: ["SOL", "USDC", "USDG"],
  base: ["ETH", "USDC"],
  arbitrum: ["ETH", "USDC"],
  robinhood: ["ETH", "USDG"],
  polygon: ["USDC"],
  optimism: ["USDC"],
} as const;

const ChainSchema = z.enum(["solana", "base", "arbitrum", "robinhood", "polygon", "optimism"]);
const TokenSchema = z.enum(["SOL", "ETH", "USDC", "USDG"]);
const CapabilitiesResponseSchema = z.object({
  public_api_enabled: z.literal(true),
  directed_conversion_routes: z.literal(76),
  execution_implemented_routes: z.literal(76),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).passthrough();
const StatusResponseSchema = z.object({
  status: z.literal("capped_public_agent_release"),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).passthrough();
export const AssetFareQuoteSchema = z
  .object({
    fromChain: ChainSchema,
    fromToken: TokenSchema,
    toChain: ChainSchema,
    toToken: TokenSchema,
    amountUsd: z.number().finite().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (!(TOKENS_BY_CHAIN[value.fromChain] as readonly string[]).includes(value.fromToken)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["fromToken"], message: "token is not supported on source chain" });
    }
    if (!(TOKENS_BY_CHAIN[value.toChain] as readonly string[]).includes(value.toToken)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["toToken"], message: "token is not supported on destination chain" });
    }
    if (value.fromChain === value.toChain && value.fromToken === value.toToken) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["toToken"], message: "identity route does not require a quote" });
    }
    if (value.toChain === "polygon" || value.toChain === "optimism") context.addIssue({ code: z.ZodIssueCode.custom, path: ["toChain"], message: "Polygon and Optimism are source-only" });
    if ((value.fromChain === "polygon" || value.fromChain === "optimism") && !(value.fromToken === "USDC" && (value.toChain === "base" || value.toChain === "arbitrum") && value.toToken === "USDC")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toChain"], message: "source-only route must be native USDC to Base or Arbitrum USDC" });
  });

export interface AssetFarePluginConfig {
  apiBaseUrl?: string;
  fetch?: Fetch;
}

function createRequester(config: AssetFarePluginConfig) {
  const apiBaseUrl = (config.apiBaseUrl ?? "https://api.assetfare.dev").replace(/\/$/, "");
  const fetchFn = config.fetch ?? fetch;
  return async (path: string, init?: RequestInit): Promise<JsonRecord> => {
    let response: Response;
    try {
      response = await fetchFn(`${apiBaseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error) {
      throw new Error(`AssetFare request failed before response: ${error instanceof Error ? error.message : "network error"}`, { cause: error });
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
      throw new Error("AssetFare response exceeded the one-megabyte safety limit");
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) {
      throw new Error("AssetFare response exceeded the one-megabyte safety limit");
    }
    let body: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("response is not an object");
      body = parsed as JsonRecord;
    } catch (error) {
      throw new Error(`AssetFare returned invalid JSON for HTTP ${response.status}`, { cause: error });
    }
    if (!response.ok) {
      throw new Error(`AssetFare request failed: ${String(body.error ?? body.message ?? `HTTP ${response.status}`)}`);
    }
    return body;
  };
}

export function createAssetFareActions(config: AssetFarePluginConfig = {}): Action[] {
  const request = createRequester(config);

  const capabilitiesAction: Action = {
    name: "ASSETFARE_GET_CAPABILITIES",
    description:
      "Read AssetFare's live six-chain, 76-route capabilities, including Polygon and Optimism native-USDC source-only routes. It never authenticates a wallet, prepares an action, signs, or submits.",
    similes: ["check assetfare routes", "get assetfare capabilities", "check assetfare status"],
    examples: [[{
      input: {},
      output: { status: "success", serverSigning: false, serverSubmission: false },
      explanation: "Confirm the public route matrix and non-custodial boundary before quoting.",
    }]],
    schema: z.object({}).strict(),
    handler: async (_agent: SolanaAgentKit) => {
      const [capabilitiesRaw, statusRaw] = await Promise.all([
        request("/v2/capabilities"),
        request("/v2/status"),
      ]);
      let capabilities: z.infer<typeof CapabilitiesResponseSchema>;
      let status: z.infer<typeof StatusResponseSchema>;
      try {
        capabilities = CapabilitiesResponseSchema.parse(capabilitiesRaw);
        status = StatusResponseSchema.parse(statusRaw);
      } catch (error) {
        throw new Error("AssetFare public safety boundary is not ready", { cause: error });
      }
      return { status: "success", capabilities, providerStatus: status };
    },
  };

  const quoteAction: Action = {
    name: "ASSETFARE_QUOTE_ROUTE",
    description:
      "Request one fresh AssetFare bridge or cross-chain swap quote across six chains and 76 routes. Fail closed unless direct_route_summary exactly proves the requested ordered provider path, normalized chain:asset endpoints, continuous base-unit amounts, and exact AssetFare 1bp fee step. direct_protocol_only excludes Across; external_intent identifies Across Robinhood ingress and possible provider-internal sourcing. route_aggregator_used=false applies only to AssetFare's engine. USD 1 is reachability/schema smoke only. USD 50 was an observed competitive bucket only for dated 2026-09-23 Solana USDC to Base USDC evidence; it is not a threshold for other corridors or a cheapest guarantee. USD 1,000 is the primary representative amount; SOL input includes a swap. Always compare total token-path cost, expected/minimum receive, source gas exclusions, ETA and live availability with other executable routes at the actual intended amount. This action never creates an order, authenticates a wallet, prepares, signs, submits, swaps, or bridges.",
    similes: ["quote assetfare route", "compare assetfare bridge", "get assetfare swap quote"],
    examples: [[{
      input: { fromChain: "solana", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 1000 },
      output: { status: "success", transactionSubmitted: false },
      explanation: "Obtain a representative native-USDC read-only route quote, compare at the intended amount, and stop before execution.",
    }]],
    schema: AssetFareQuoteSchema,
    handler: async (_agent: SolanaAgentKit, rawInput: Record<string, unknown>) => {
      const input = AssetFareQuoteSchema.parse(rawInput);
      const quoteRaw = await request("/v2/quote", {
        method: "POST",
        body: JSON.stringify({
          from_chain: input.fromChain,
          from_token: input.fromToken,
          to_chain: input.toChain,
          to_token: input.toToken,
          amount_usd: input.amountUsd,
        }),
      });
      let quote: JsonRecord;
      try {
        quote = validateQuoteDirectRoute(quoteRaw, input);
      } catch (error) {
        throw new Error("AssetFare quote is outside the public safety boundary", { cause: error });
      }
      const summary = quote.direct_route_summary as JsonRecord;
      return {
        status: "success",
        quote,
        agentGuidance: {
          compareWithOtherRoutes: true,
          requoteBeforeSelection: true,
          directRouteSummaryVerified: true,
          orderedProviderPathVerified: true,
          normalizedChainAssetEndpointsVerified: true,
          amountContinuityVerified: true,
          assetfareFeeStepVerified: true,
          routeClassification: summary.classification,
          assetfareEngineRouteAggregatorUsed: false,
          providerInternalDexAggregationPossible: summary.provider_internal_dex_aggregation_possible,
          compareAtIntendedAmount: true,
          oneDollarPurpose: "reachability_and_schema_smoke_only",
          nativeUsdcComparisonStartUsd: 50,
          evidenceAsOf: "2026-09-23",
          cheapestGuaranteed: false,
          representativeComparisonAmountUsd: 1000,
          solInputIncludesSwap: input.fromToken === "SOL",
          walletAuthenticationPerformed: false,
          sessionCreated: false,
          actionPrepared: false,
          transactionSigned: false,
          transactionSubmitted: false,
        },
      };
    },
  };

  return [capabilitiesAction, quoteAction];
}

export function createAssetFarePlugin(config: AssetFarePluginConfig = {}): Plugin {
  return {
    name: "assetfare",
    methods: {},
    actions: createAssetFareActions(config),
    initialize: (_agent: SolanaAgentKit): void => {},
  };
}

export default createAssetFarePlugin();
