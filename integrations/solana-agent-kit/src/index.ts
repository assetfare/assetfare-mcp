import type { Action, Plugin, SolanaAgentKit } from "solana-agent-kit";
import { z } from "zod";
import { validateCapabilitiesEconomicGuidance, validateQuoteDirectRoute } from "./directRouteSummary.js";

export { validateCapabilitiesEconomicGuidance, validateQuoteDirectRoute } from "./directRouteSummary.js";

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
  ethereum: ["USDC"],
  hyperevm: ["USDC"],
  xlayer: ["USDC"], sei: ["USDC"], sonic: ["USDC"], monad: ["USDC"], avalanche: ["USDC"], cronos: ["USDC"], injective: ["USDC"], linea: ["USDC"], aptos: ["USDC"], unichain: ["USDC"], ink: ["USDC"],
} as const;

const ChainSchema = z.enum(["solana", "base", "arbitrum", "robinhood", "polygon", "optimism", "ethereum", "hyperevm", "xlayer", "sei", "sonic", "monad", "avalanche", "cronos", "injective", "linea", "aptos", "unichain", "ink"]);
const TokenSchema = z.enum(["SOL", "ETH", "USDC", "USDG"]);
const CapabilitiesResponseSchema = z.object({
  public_api_enabled: z.literal(true),
  directed_conversion_routes: z.literal(100),
  execution_implemented_routes: z.literal(100),
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
    if (["polygon", "optimism", "ethereum", "hyperevm", "xlayer", "sei", "sonic", "monad", "avalanche", "cronos", "injective", "linea", "aptos", "unichain", "ink"].includes(value.toChain)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toChain"], message: "selected chain is source-only" });
    if ((value.fromChain === "polygon" || value.fromChain === "optimism") && !(value.fromToken === "USDC" && (value.toChain === "base" || value.toChain === "arbitrum") && value.toToken === "USDC")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toChain"], message: "source-only route must be native USDC to Base or Arbitrum USDC" });
    if ((value.fromChain === "ethereum" || value.fromChain === "hyperevm") && !(value.fromToken === "USDC" && (value.toChain === "base" || value.toChain === "solana") && value.toToken === "USDC")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["toChain"], message: "expansion source route must be native USDC to Base or Solana USDC" });
    if (["xlayer","sei","sonic","monad","avalanche","cronos","injective","linea","aptos"].includes(value.fromChain) && !(value.fromToken === "USDC" && ["base","solana"].includes(value.toChain) && value.toToken === "USDC")) context.addIssue({code:z.ZodIssueCode.custom,path:["toChain"],message:"candidate source route must be native USDC to Base or Solana USDC"});
    if (["unichain","ink"].includes(value.fromChain) && !(value.fromToken === "USDC" && value.toChain === "solana" && value.toToken === "USDC")) context.addIssue({code:z.ZodIssueCode.custom,path:["toChain"],message:"source route must be native USDC to Solana USDC"});
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
      "Read AssetFare's live 100 available routes across nineteen chains. Forty-four have a verified best-from threshold; 56 have no current price recommendation. It never authenticates a wallet, prepares an action, signs, or submits.",
    similes: ["check assetfare routes", "get assetfare capabilities", "check assetfare status"],
    examples: [[{
      input: {},
      output: { status: "success", serverSigning: false, serverSubmission: false },
      explanation: "Confirm the public route matrix, route-specific economic guidance, and non-custodial boundary before quoting.",
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
        validateCapabilitiesEconomicGuidance(capabilities);
      } catch (error) {
        throw new Error("AssetFare public safety boundary is not ready", { cause: error });
      }
      return { status: "success", capabilities, providerStatus: status };
    },
  };

  const quoteAction: Action = {
    name: "ASSETFARE_QUOTE_ROUTE",
    description:
      "Request one fresh quote on AssetFare's 100 available routes. Forty-four have a verified best-from threshold; 56 have no current price recommendation. Confirm every fresh quote. This action never authenticates, prepares, signs, submits, swaps, or bridges.",
    similes: ["quote assetfare route", "compare assetfare bridge", "get assetfare swap quote"],
    examples: [[{
      input: { fromChain: "solana", fromToken: "USDC", toChain: "base", toToken: "USDC", amountUsd: 1000 },
      output: { status: "success", transactionSubmitted: false },
      explanation: "Obtain a representative native-USDC quote, apply its best-from amount, confirm the fresh output, and stop before execution.",
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
          compareWithOtherRoutes: false,
          requoteBeforeSelection: true,
          bestFromUsd: (quote.economic_guidance as JsonRecord).advisory_start_usd,
          availabilityOnly: (quote.economic_guidance as JsonRecord).availability_only === true,
          useAssetFareFirstAtOrAboveBestFrom: typeof (quote.economic_guidance as JsonRecord).advisory_start_usd === "number" && input.amountUsd >= Number((quote.economic_guidance as JsonRecord).advisory_start_usd),
          bestFromNot100PercentGuarantee: true,
          directRouteSummaryVerified: true,
          orderedProviderPathVerified: true,
          normalizedChainAssetEndpointsVerified: true,
          amountContinuityVerified: true,
          assetfareFeeStepVerified: true,
          routeClassification: summary.classification,
          assetfareEngineRouteAggregatorUsed: false,
          providerInternalDexAggregationPossible: summary.provider_internal_dex_aggregation_possible,
          compareAtIntendedAmount: false,
          oneDollarPurpose: "reachability_and_schema_smoke_only",
          economicGuidance: quote.economic_guidance,
          economicGuidanceUrl: "https://assetfare.dev/route-economics.json",
          useRouteSpecificAdvisory: true,
          globalNativeUsdcStartingAmount: null,
          cheapestGuaranteed: false,
          documentationExampleAmountUsd: 1000,
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
