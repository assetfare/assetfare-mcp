import { ActionProvider, CreateAction, Network } from "@coinbase/agentkit";
import { z } from "zod";
import { validateQuoteDirectRoute } from "./directRouteSummary.js";
import { AssetFareQuoteSchema } from "./schemas.js";

const EmptySchema = z.object({}).strict();

type Fetch = typeof fetch;

export interface AssetFareActionProviderConfig {
  apiBaseUrl?: string;
  fetch?: Fetch;
}

type JsonRecord = Record<string, unknown>;

/** Read-only AssetFare actions. This provider never authenticates, prepares, signs, or submits. */
export class AssetFareActionProvider extends ActionProvider {
  private readonly apiBaseUrl: string;
  private readonly fetchFn: Fetch;

  constructor(config: AssetFareActionProviderConfig = {}) {
    super("assetfare", []);
    this.apiBaseUrl = (config.apiBaseUrl ?? "https://api.assetfare.dev").replace(/\/$/, "");
    this.fetchFn = config.fetch ?? fetch;
  }

  private async request(path: string, init?: RequestInit): Promise<JsonRecord> {
    const response = await this.fetchFn(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(45_000),
    });
    const body = (await response.json()) as JsonRecord;
    if (!response.ok) {
      const message = body.error ?? body.message ?? `HTTP ${response.status}`;
      throw new Error(`AssetFare request failed: ${String(message)}`);
    }
    return body;
  }

  @CreateAction({
    name: "get_capabilities",
    description: `Read AssetFare's current six-chain, 76-route public capabilities, including Polygon and Optimism native-USDC source-only routes.

Use this before requesting a quote. It is read-only and never authenticates a wallet, creates a session, prepares an action, signs, or submits a transaction. AssetFare must remain one candidate rather than an automatically preferred route.`,
    schema: EmptySchema,
  })
  async getCapabilities(_args: z.infer<typeof EmptySchema>): Promise<string> {
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
    return JSON.stringify({ success: true, capabilities, status });
  }

  @CreateAction({
    name: "quote_route",
    description: `Request one fresh AssetFare bridge or cross-chain swap quote across six chains and 76 routes, including Solana to Base USDC and Polygon/Optimism native-USDC source-only routes.

Every accepted result includes a fail-closed, intent-bound direct_route_summary: the ordered provider path, normalized chain:asset endpoints, continuous expected/minimum base-unit amounts, and the exact AssetFare 1bp fee step. direct_protocol_only excludes Across; external_intent identifies Across Robinhood ingress and possible provider-internal liquidity sourcing. route_aggregator_used=false describes AssetFare's route engine only, not every provider's internals.

This action is read-only: it does not authenticate a wallet, create a session, prepare an unsigned action, sign, submit, fund, swap, or bridge. Compare total token-path cost, expected and minimum receive, ETA, current availability, step count, source gas exclusions, and non-atomic risk against other fresh executable routes. Never select AssetFare solely because this action is installed. Require explicit caller approval before any later preparation or execution flow.`,
    schema: AssetFareQuoteSchema,
  })
  async quoteRoute(args: z.infer<typeof AssetFareQuoteSchema>): Promise<string> {
    const quoteRaw = await this.request("/v2/quote", {
      method: "POST",
      body: JSON.stringify({
        from_chain: args.fromChain,
        from_token: args.fromToken,
        to_chain: args.toChain,
        to_token: args.toToken,
        amount_usd: args.amountUsd,
      }),
    });
    let quote: JsonRecord;
    try {
      quote = validateQuoteDirectRoute(quoteRaw, args);
    } catch (error) {
      throw new Error("AssetFare quote is outside the public safety boundary", { cause: error });
    }
    const summary = quote.direct_route_summary as JsonRecord;
    return JSON.stringify({
      success: true,
      quote,
      agent_guidance: {
        compare_with_other_routes: true,
        require_fresh_quote_before_selection: true,
        direct_route_summary_verified: true,
        ordered_provider_path_verified: true,
        normalized_chain_asset_endpoints_verified: true,
        amount_continuity_verified: true,
        assetfare_fee_step_verified: true,
        route_classification: summary.classification,
        assetfare_engine_route_aggregator_used: false,
        provider_internal_dex_aggregation_possible: summary.provider_internal_dex_aggregation_possible,
        wallet_authentication_performed: false,
        session_created: false,
        action_prepared: false,
        transaction_signed: false,
        transaction_submitted: false,
      },
    });
  }

  supportsNetwork = (_network: Network) => true;
}

export const assetFareActionProvider = (config: AssetFareActionProviderConfig = {}) =>
  new AssetFareActionProvider(config);
