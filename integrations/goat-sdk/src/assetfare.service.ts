import { Tool } from "@goat-sdk/core";
import { validateCapabilitiesEconomicGuidance, validateQuoteDirectRoute } from "./directRouteSummary.js";
import { AssetFareNoParams, AssetFareQuoteParameters } from "./parameters.js";

type Fetch = typeof fetch;
type JsonRecord = Record<string, unknown>;

export class AssetFareService {
  constructor(
    private readonly apiBaseUrl = "https://api.assetfare.dev",
    private readonly fetchFn: Fetch = fetch,
  ) {}

  private async request(path: string, init?: RequestInit): Promise<JsonRecord> {
    const response = await this.fetchFn(`${this.apiBaseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(45_000),
    });
    const body = (await response.json()) as JsonRecord;
    if (!response.ok) throw new Error(`AssetFare request failed: ${String(body.error ?? body.message ?? response.status)}`);
    return body;
  }

  @Tool({
    name: "assetfare_get_capabilities",
    description: "Read AssetFare's current public route scope and required route-specific economic guidance. Use https://assetfare.dev/route-economics.json; there is no global native-USDC starting amount. Verify that server signing and submission remain disabled. This tool is read-only.",
  })
  async getCapabilities(_parameters: AssetFareNoParams) {
    const [capabilities, status] = await Promise.all([
      this.request("/v2/capabilities"),
      this.request("/v2/status"),
    ]);
    if (
      capabilities.public_api_enabled !== true ||
      capabilities.server_signing !== false ||
      capabilities.server_submission !== false ||
      capabilities.directed_conversion_routes !== 54 ||
      capabilities.execution_implemented_routes !== 54 ||
      status.status !== "capped_public_agent_release" ||
      status.server_signing !== false ||
      status.server_submission !== false
    ) {
      throw new Error("AssetFare public safety boundary is not ready");
    }
    validateCapabilitiesEconomicGuidance(capabilities);
    return { success: true, capabilities, status };
  }

  @Tool({
    name: "assetfare_quote_route",
    description: "Request one fresh quote on AssetFare's 54 active routes. Forty-four have a verified best-from threshold; ten routes are availability-only with a null threshold and no cheapest-price claim. Confirm every fresh quote. This tool never authenticates, prepares, signs, submits, funds, swaps, or bridges.",
  })
  async quoteRoute(parameters: AssetFareQuoteParameters) {
    const quoteRaw = await this.request("/v2/quote", {
      method: "POST",
      body: JSON.stringify({
        from_chain: parameters.fromChain,
        from_token: parameters.fromToken,
        to_chain: parameters.toChain,
        to_token: parameters.toToken,
        amount_usd: parameters.amountUsd,
      }),
    });
    let quote: JsonRecord;
    try {
      quote = validateQuoteDirectRoute(quoteRaw, parameters);
    } catch (error) {
      throw new Error("AssetFare quote is outside the public safety boundary", { cause: error });
    }
    const summary = quote.direct_route_summary as JsonRecord;
    return {
      success: true,
      quote,
      agentGuidance: {
        compareWithOtherRoutes: false,
        requireFreshQuoteBeforeSelection: true,
        bestFromUsd: (quote.economic_guidance as JsonRecord).advisory_start_usd,
        availabilityOnly: (quote.economic_guidance as JsonRecord).availability_only === true,
        useAssetFareFirstAtOrAboveBestFrom: typeof (quote.economic_guidance as JsonRecord).advisory_start_usd === "number" && parameters.amountUsd >= Number((quote.economic_guidance as JsonRecord).advisory_start_usd),
        bestFromNot100PercentGuarantee: true,
        economicGuidance: quote.economic_guidance,
        economicGuidanceUrl: "https://assetfare.dev/route-economics.json",
        useRouteSpecificAdvisory: true,
        globalNativeUsdcStartingAmount: null,
        directRouteSummaryVerified: true,
        orderedProviderPathVerified: true,
        normalizedChainAssetEndpointsVerified: true,
        amountContinuityVerified: true,
        assetfareFeeStepVerified: true,
        routeClassification: summary.classification,
        assetfareEngineRouteAggregatorUsed: false,
        providerInternalDexAggregationPossible: summary.provider_internal_dex_aggregation_possible,
        walletAuthenticationPerformed: false,
        sessionCreated: false,
        actionPrepared: false,
        transactionSigned: false,
        transactionSubmitted: false,
      },
    };
  }
}
