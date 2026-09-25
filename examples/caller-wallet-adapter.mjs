/**
 * Ready-made caller-owned adapter wiring.
 *
 * Export the standard wallet clients your agent already owns from
 * `my-agent-wallets.mjs`. AssetFare receives none of their keys and never
 * signs or submits. This process calls those clients directly in the caller's
 * environment after the local policy and verified handoff pass.
 */
import { createMode0600JsonOperationStore, createStandardCallerWalletAdapter } from "../src/standard-wallet-adapter.js";
import { evmProvider, solanaAccount, solanaRpcUrl, solanaWallet } from "./my-agent-wallets.example.mjs";

export async function createCallerWalletAdapter(){
  return createStandardCallerWalletAdapter({
    evmProvider,             // EIP-1193 provider or async (chainId)=>provider resolver
    solanaWallet,            // Solana Wallet Standard wallet; optional for EVM-only routes
    solanaAccount,           // Wallet Standard account used as fee payer
    solanaRpcUrl,            // caller-selected RPC endpoint
    operationStore:createMode0600JsonOperationStore("./assetfare-wallet-operations.private.json")
  });
}
