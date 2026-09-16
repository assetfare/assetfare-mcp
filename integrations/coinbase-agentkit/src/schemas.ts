import { z } from "zod";

export const AssetFareChainSchema = z.enum(["solana", "base", "arbitrum", "robinhood"]);
export const AssetFareTokenSchema = z.enum(["SOL", "ETH", "USDC", "USDG"]);

export const AssetFareQuoteSchema = z
  .object({
    fromChain: AssetFareChainSchema.describe("Source blockchain"),
    fromToken: AssetFareTokenSchema.describe("Source asset symbol"),
    toChain: AssetFareChainSchema.describe("Destination blockchain"),
    toToken: AssetFareTokenSchema.describe("Destination asset symbol"),
    amountUsd: z.number().min(250).max(1000).describe("USD notional from 250 through 1000"),
  })
  .strict()
  .refine(value => value.fromChain !== value.toChain || value.fromToken !== value.toToken, {
    message: "Identity routes do not require a quote",
  });

export type AssetFareQuoteInput = z.infer<typeof AssetFareQuoteSchema>;
