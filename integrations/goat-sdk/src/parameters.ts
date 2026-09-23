import { createToolParameters } from "@goat-sdk/core";
import { z } from "zod";

export class AssetFareNoParams extends createToolParameters(z.object({}).strict()) {}

export class AssetFareQuoteParameters extends createToolParameters(
  z
    .object({
      fromChain: z.enum(["solana", "base", "arbitrum", "robinhood", "polygon", "optimism"]).describe("Source blockchain"),
      fromToken: z.enum(["SOL", "ETH", "USDC", "USDG"]).describe("Source asset symbol"),
      toChain: z.enum(["solana", "base", "arbitrum", "robinhood", "polygon", "optimism"]).describe("Destination blockchain"),
      toToken: z.enum(["SOL", "ETH", "USDC", "USDG"]).describe("Destination asset symbol"),
      amountUsd: z.number().finite().min(1).describe("Finite USD notional of at least 1; no adapter-enforced maximum"),
    })
    .strict()
    .superRefine((value, context) => {
      const tokens: Record<string, readonly string[]> = { solana:["SOL","USDC","USDG"],base:["ETH","USDC"],arbitrum:["ETH","USDC"],robinhood:["ETH","USDG"],polygon:["USDC"],optimism:["USDC"] };
      if (!tokens[value.fromChain].includes(value.fromToken)) context.addIssue({ code:"custom",path:["fromToken"],message:"token is not supported on source chain" });
      if (!tokens[value.toChain].includes(value.toToken)) context.addIssue({ code:"custom",path:["toToken"],message:"token is not supported on destination chain" });
      if (value.fromChain === value.toChain && value.fromToken === value.toToken) context.addIssue({ code:"custom",path:["toToken"],message:"identity routes do not require a quote" });
      if (["polygon","optimism"].includes(value.toChain)) context.addIssue({ code:"custom",path:["toChain"],message:"Polygon and Optimism are source-only" });
      if (["polygon","optimism"].includes(value.fromChain) && !(value.fromToken === "USDC" && ["base","arbitrum"].includes(value.toChain) && value.toToken === "USDC")) context.addIssue({ code:"custom",path:["toChain"],message:"source-only route must be native USDC to Base or Arbitrum USDC" });
    }),
) {}
