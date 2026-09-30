import { z } from "zod";

export const AssetFareChainSchema = z.enum(["solana", "base", "arbitrum", "robinhood", "polygon", "optimism", "ethereum", "hyperevm", "xlayer", "sei", "sonic", "monad", "avalanche", "cronos", "injective", "linea", "aptos"]);
export const AssetFareTokenSchema = z.enum(["SOL", "ETH", "USDC", "USDG"]);

const TOKENS_BY_CHAIN: Record<z.infer<typeof AssetFareChainSchema>, readonly string[]> = {
  solana: ["SOL", "USDC", "USDG"], base: ["ETH", "USDC"], arbitrum: ["ETH", "USDC"],
  robinhood: ["ETH", "USDG"], polygon: ["USDC"], optimism: ["USDC"], ethereum: ["USDC"], hyperevm: ["USDC"], xlayer:["USDC"], sei:["USDC"], sonic:["USDC"], monad:["USDC"], avalanche:["USDC"], cronos:["USDC"], injective:["USDC"], linea:["USDC"], aptos:["USDC"],
};

export const AssetFareQuoteSchema = z
  .object({
    fromChain: AssetFareChainSchema.describe("Source blockchain"),
    fromToken: AssetFareTokenSchema.describe("Source asset symbol"),
    toChain: AssetFareChainSchema.describe("Destination blockchain"),
    toToken: AssetFareTokenSchema.describe("Destination asset symbol"),
    amountUsd: z.number().finite().min(1).describe("Finite USD notional of at least 1; no adapter-enforced maximum"),
  })
  .strict()
  .superRefine((value, context) => {
    if (!TOKENS_BY_CHAIN[value.fromChain].includes(value.fromToken)) context.addIssue({ code: "custom", path: ["fromToken"], message: "token is not supported on source chain" });
    if (!TOKENS_BY_CHAIN[value.toChain].includes(value.toToken)) context.addIssue({ code: "custom", path: ["toToken"], message: "token is not supported on destination chain" });
    if (value.fromChain === value.toChain && value.fromToken === value.toToken) context.addIssue({ code: "custom", path: ["toToken"], message: "identity routes do not require a quote" });
    if (["polygon", "optimism", "ethereum", "hyperevm", "xlayer", "sei", "sonic", "monad", "avalanche", "cronos", "injective", "linea", "aptos"].includes(value.toChain)) context.addIssue({ code: "custom", path: ["toChain"], message: "selected chain is source-only" });
    if (["polygon", "optimism"].includes(value.fromChain) && !(value.fromToken === "USDC" && ["base", "arbitrum"].includes(value.toChain) && value.toToken === "USDC")) context.addIssue({ code: "custom", path: ["toChain"], message: "source-only route must be native USDC to Base or Arbitrum USDC" });
    if (["ethereum", "hyperevm"].includes(value.fromChain) && !(value.fromToken === "USDC" && ["base", "solana"].includes(value.toChain) && value.toToken === "USDC")) context.addIssue({ code: "custom", path: ["toChain"], message: "expansion source route must be native USDC to Base or Solana USDC" });
    if (["xlayer","sei","sonic","monad","avalanche","cronos","injective","linea","aptos"].includes(value.fromChain) && !(value.fromToken === "USDC" && ["base","solana"].includes(value.toChain) && value.toToken === "USDC")) context.addIssue({code:"custom",path:["toChain"],message:"candidate source route must be native USDC to Base or Solana USDC"});
  });

export type AssetFareQuoteInput = z.infer<typeof AssetFareQuoteSchema>;
