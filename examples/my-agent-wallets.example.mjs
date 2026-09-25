/**
 * Copy this file to `my-agent-wallets.mjs` and bind the wallet clients already
 * owned by your agent runtime. Do not put a private key, seed phrase, or raw
 * signer secret in this file. AssetFare consumes only these standard provider
 * interfaces inside your process.
 */
export const evmProvider=globalThis.ethereum ?? null; // EIP-1193 object, or async (chainId)=>provider
export const solanaWallet=null;                       // Solana Wallet Standard wallet
export const solanaAccount=null;                      // account from solanaWallet.accounts
export const solanaRpcUrl=process.env.CALLER_SOLANA_RPC_URL ?? null;
