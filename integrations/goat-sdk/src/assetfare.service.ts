import { Tool } from "@goat-sdk/core";
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
    description: "Read AssetFare's current capped public route scope and verify that server signing and submission remain disabled. This tool is read-only.",
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
      capabilities.directed_conversion_routes !== 76 ||
      capabilities.execution_implemented_routes !== 76 ||
      status.status !== "capped_public_agent_release" ||
      status.server_signing !== false ||
      status.server_submission !== false
    ) {
      throw new Error("AssetFare public safety boundary is not ready");
    }
    return { success: true, capabilities, status };
  }

  @Tool({
    name: "assetfare_quote_route",
    description: "Request one fresh AssetFare bridge or cross-chain swap quote across six chains and 76 routes, including Solana to Base USDC and Polygon/Optimism native-USDC source-only routes. Compare total token-path cost, expected/minimum receive, source gas exclusions, ETA and live availability. This tool never authenticates, prepares, signs, submits, funds, swaps, or bridges.",
  })
  async quoteRoute(parameters: AssetFareQuoteParameters) {
    const quote = await this.request("/v2/quote", {
      method: "POST",
      body: JSON.stringify({
        from_chain: parameters.fromChain,
        from_token: parameters.fromToken,
        to_chain: parameters.toChain,
        to_token: parameters.toToken,
        amount_usd: parameters.amountUsd,
      }),
    });
    const execution = quote.execution as JsonRecord | undefined;
    const risk = quote.risk as JsonRecord | undefined;
    if (
      quote.status !== "capped_public_agent_release" ||
      execution?.supported !== true ||
      risk?.server_signing !== false ||
      risk?.server_submission !== false
    ) {
      throw new Error("AssetFare quote is outside the capped public safety boundary");
    }
    return {
      success: true,
      quote,
      agentGuidance: {
        compareWithOtherRoutes: true,
        requireFreshQuoteBeforeSelection: true,
        walletAuthenticationPerformed: false,
        sessionCreated: false,
        actionPrepared: false,
        transactionSigned: false,
        transactionSubmitted: false,
      },
    };
  }
}
