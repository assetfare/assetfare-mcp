import {
  composePromptFromState,
  ModelType,
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type Plugin,
  type State,
} from "@elizaos/core";
import { z } from "zod";

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
export const AssetFareQuoteIntentSchema = z.object({
  fromChain: ChainSchema,
  fromToken: TokenSchema,
  toChain: ChainSchema,
  toToken: TokenSchema,
  amountUsd: z.number().finite().min(1),
}).strict().superRefine((value, context) => {
  if (!(TOKENS_BY_CHAIN[value.fromChain] as readonly string[]).includes(value.fromToken)) {
    context.addIssue({ code: "custom", path: ["fromToken"], message: "token is not supported on source chain" });
  }
  if (!(TOKENS_BY_CHAIN[value.toChain] as readonly string[]).includes(value.toToken)) {
    context.addIssue({ code: "custom", path: ["toToken"], message: "token is not supported on destination chain" });
  }
  if (value.fromChain === value.toChain && value.fromToken === value.toToken) {
    context.addIssue({ code: "custom", path: ["toToken"], message: "identity route does not require a quote" });
  }
  if (value.toChain === "polygon" || value.toChain === "optimism") context.addIssue({ code: "custom", path: ["toChain"], message: "Polygon and Optimism are source-only" });
  if ((value.fromChain === "polygon" || value.fromChain === "optimism") && !(value.fromToken === "USDC" && (value.toChain === "base" || value.toChain === "arbitrum") && value.toToken === "USDC")) context.addIssue({ code: "custom", path: ["toChain"], message: "source-only route must be native USDC to Base or Arbitrum USDC" });
});

const CapabilitiesSchema = z.object({
  public_api_enabled: z.literal(true),
  directed_conversion_routes: z.literal(76),
  execution_implemented_routes: z.literal(76),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).loose();
const StatusSchema = z.object({
  status: z.literal("capped_public_agent_release"),
  server_signing: z.literal(false),
  server_submission: z.literal(false),
}).loose();
const QuoteSchema = z.object({
  status: z.literal("capped_public_agent_release"),
  execution: z.object({ supported: z.literal(true) }).loose(),
  risk: z.object({ server_signing: z.literal(false), server_submission: z.literal(false) }).loose(),
  offer: z.record(z.string(), z.unknown()),
}).loose();

const intentJsonSchema = {
  type: "object",
  properties: {
    fromChain: { type: "string" },
    fromToken: { type: "string" },
    toChain: { type: "string" },
    toToken: { type: "string" },
    amountUsd: { type: "number" },
  },
  required: ["fromChain", "fromToken", "toChain", "toToken", "amountUsd"],
  additionalProperties: false,
};

const intentTemplate = `Extract one AssetFare route intent from the recent messages.
Supported endpoints: solana SOL/USDC/USDG; base ETH/USDC; arbitrum ETH/USDC; robinhood ETH/USDG; polygon USDC and optimism USDC as source-only to Base/Arbitrum USDC.
The USD amount must be finite and at least 1; there is no adapter-enforced maximum. Return only the object fields fromChain, fromToken, toChain, toToken, amountUsd.

Recent messages:
{{recentMessages}}`;

export interface AssetFareElizaConfig {
  apiBaseUrl?: string;
  fetch?: Fetch;
}

function requester(config: AssetFareElizaConfig) {
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

async function respond(callback: HandlerCallback | undefined, text: string, data: Record<string, unknown>): Promise<void> {
  if (callback) await callback({ text, actions: ["ASSETFARE_QUOTE_ROUTE"], data });
}

export function createAssetFareElizaPlugin(config: AssetFareElizaConfig = {}): Plugin {
  const request = requester(config);

  const capabilitiesAction: Action = {
    name: "ASSETFARE_GET_CAPABILITIES",
    similes: ["CHECK_ASSETFARE", "ASSETFARE_STATUS", "LIST_ASSETFARE_ROUTES"],
    description: "Read AssetFare's live route scope and verify that the server cannot sign or submit. This action never accesses an elizaOS wallet.",
    validate: async () => true,
    handler: async (_runtime, _message, _state, _options, callback): Promise<ActionResult> => {
      try {
        const [capabilitiesRaw, statusRaw] = await Promise.all([request("/v2/capabilities"), request("/v2/status")]);
        const capabilities = CapabilitiesSchema.parse(capabilitiesRaw);
        const status = StatusSchema.parse(statusRaw);
        if (callback) await callback({ text: "AssetFare public route capabilities verified.", actions: ["ASSETFARE_GET_CAPABILITIES"], data: { capabilities, status } });
        return { success: true, text: "AssetFare public route capabilities verified.", data: { capabilities, status } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error : new Error(String(error)) };
      }
    },
    examples: [[
      { name: "{{userName}}", content: { text: "Check AssetFare route availability", actions: [] } },
      { name: "{{agentName}}", content: { text: "I will verify the read-only route scope.", actions: ["ASSETFARE_GET_CAPABILITIES"] } },
    ]],
  };

  const quoteAction: Action = {
    name: "ASSETFARE_QUOTE_ROUTE",
    similes: ["QUOTE_ASSETFARE_ROUTE", "COMPARE_CROSS_CHAIN_ROUTE", "QUOTE_SOLANA_EVM_BRIDGE"],
    description: "Request one fresh AssetFare bridge or cross-chain swap quote across six chains and 76 routes, compare total token-path cost, expected/minimum receive, source gas exclusions, ETA and live availability, and stop before authentication, preparation, signing, submission, swap, or bridge execution.",
    validate: async () => true,
    handler: async (runtime: IAgentRuntime, message: Memory, state?: State, _options?: Record<string, unknown>, callback?: HandlerCallback): Promise<ActionResult> => {
      try {
        const currentState = state ?? await runtime.composeState(message);
        const prompt = composePromptFromState({ state: currentState, template: intentTemplate });
        const generated = await runtime.useModel(ModelType.OBJECT_SMALL, { prompt, schema: intentJsonSchema, output: "object", temperature: 0 });
        const input = AssetFareQuoteIntentSchema.parse(generated);
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
        const quote = QuoteSchema.parse(quoteRaw);
        const data = {
          quote,
          guidance: {
            compareWithOtherRoutes: true,
            requoteBeforeSelection: true,
            walletAccessed: false,
            sessionCreated: false,
            actionPrepared: false,
            transactionSigned: false,
            transactionSubmitted: false,
          },
        };
        const text = "Fresh AssetFare quote received. Compare it with other executable routes; no wallet action was taken.";
        await respond(callback, text, data);
        return { success: true, text, data };
      } catch (error) {
        const wrapped = error instanceof Error ? error : new Error(String(error));
        if (callback) await callback({ text: `AssetFare quote failed safely: ${wrapped.message}`, actions: ["ASSETFARE_QUOTE_ROUTE"], data: { error: wrapped.message } });
        return { success: false, error: wrapped };
      }
    },
    examples: [[
      { name: "{{userName}}", content: { text: "Compare a $1 route from Solana SOL to Base USDC", actions: [] } },
      { name: "{{agentName}}", content: { text: "I will request one read-only quote and stop before execution.", actions: ["ASSETFARE_QUOTE_ROUTE"] } },
    ]],
  };

  return {
    name: "assetfare-route",
    description: "Read-only AssetFare multichain route discovery and quote comparison for elizaOS. No wallet, signing, or submission authority.",
    actions: [capabilitiesAction, quoteAction],
  };
}

export const assetFareElizaPlugin = createAssetFareElizaPlugin();
export default assetFareElizaPlugin;
