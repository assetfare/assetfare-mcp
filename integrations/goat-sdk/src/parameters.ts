import { createToolParameters } from "@goat-sdk/core";
import { z } from "zod";

export class AssetFareNoParams extends createToolParameters(z.object({}).strict()) {}

export class AssetFareQuoteParameters extends createToolParameters(
  z
    .object({
      fromChain: z.enum(["solana", "base", "arbitrum", "robinhood"]).describe("Source blockchain"),
      fromToken: z.enum(["SOL", "ETH", "USDC", "USDG"]).describe("Source asset symbol"),
      toChain: z.enum(["solana", "base", "arbitrum", "robinhood"]).describe("Destination blockchain"),
      toToken: z.enum(["SOL", "ETH", "USDC", "USDG"]).describe("Destination asset symbol"),
      amountUsd: z.number().min(250).max(1000).describe("USD notional from 250 through 1000"),
    })
    .strict()
    .refine(value => value.fromChain !== value.toChain || value.fromToken !== value.toToken, {
      message: "Identity routes do not require a quote",
    }),
) {}
