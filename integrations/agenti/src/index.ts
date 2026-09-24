import { tool } from "ai";
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

export const AssetFareQuoteSchema = z.object({
  fromChain: ChainSchema,
  fromToken: TokenSchema,
  toChain: ChainSchema,
  toToken: TokenSchema,
  amountUsd: z.number().finite().min(1),
}).strict().superRefine((value, context) => {
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

const CapabilitiesSchema = z.object({
  public_api_enabled: z.literal(true),
  directed_conversion_routes: z.literal(76),
  execution_implemented_routes: z.literal(76),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).passthrough();
const StatusSchema = z.object({
  status: z.literal("capped_public_agent_release"),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).passthrough();
export interface AssetFareToolsConfig {
  apiBaseUrl?: string;
  fetch?: Fetch;
}

function requester(config: AssetFareToolsConfig) {
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
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("AssetFare response exceeded the one-megabyte safety limit");
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_RESPONSE_BYTES) throw new Error("AssetFare response exceeded the one-megabyte safety limit");
    let body: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("response is not an object");
      body = parsed as JsonRecord;
    } catch (error) {
      throw new Error(`AssetFare returned invalid JSON for HTTP ${response.status}`, { cause: error });
    }
    if (!response.ok) throw new Error(`AssetFare request failed: ${String(body.error ?? body.message ?? `HTTP ${response.status}`)}`);
    return body;
  };
}

export function createAssetFareClient(config: AssetFareToolsConfig = {}) {
  const request = requester(config);
  return {
    async capabilities() {
      const [capabilitiesRaw, statusRaw] = await Promise.all([request("/v2/capabilities"), request("/v2/status")]);
      try {
        return { capabilities: CapabilitiesSchema.parse(capabilitiesRaw), status: StatusSchema.parse(statusRaw) };
      } catch (error) {
        throw new Error("AssetFare public safety boundary is not ready", { cause: error });
      }
    },
    async quote(rawInput: z.input<typeof AssetFareQuoteSchema>) {
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
      try {
        return validateQuoteDirectRoute(quoteRaw, input);
      } catch (error) {
        throw new Error("AssetFare quote is outside the public safety boundary", { cause: error });
      }
    },
  };
}

export function assetFareTools(config: AssetFareToolsConfig = {}) {
  const client = createAssetFareClient(config);
  return {
    assetfareGetCapabilities: tool({
      description: "Read AssetFare's public route scope and verify that the server still cannot sign or submit. Read-only and independent of the Agenti wallet.",
      inputSchema: z.object({}).strict(),
      execute: async () => ({ success: true, ...(await client.capabilities()) }),
    }),
    assetfareQuoteRoute: tool({
      description: "Request one fresh AssetFare bridge or cross-chain swap quote across six chains and 76 routes and stop. Fail closed unless direct_route_summary exactly proves the requested ordered provider path, normalized chain:asset endpoints, continuous base-unit amounts, and exact AssetFare 1bp fee step. direct_protocol_only excludes Across; external_intent identifies Across Robinhood ingress and possible provider-internal sourcing. route_aggregator_used=false applies only to AssetFare's engine. Compare total token-path cost, expected/minimum receive, source gas exclusions, ETA and live availability; never authenticate, prepare, sign, submit, swap, or bridge from this tool.",
      inputSchema: AssetFareQuoteSchema,
      execute: async (input) => {
        const quote = await client.quote(input);
        const summary = quote.direct_route_summary as JsonRecord;
        return {
          success: true,
          quote,
          guidance: {
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
          walletAccessed: false,
          sessionCreated: false,
          actionPrepared: false,
          transactionSigned: false,
          transactionSubmitted: false,
          },
        };
      },
    }),
  };
}
