/**
 * Contract-only template for a caller-owned wallet adapter.
 *
 * Replace each method with calls to the agent's existing wallet/HSM/browser
 * provider. Keep keys inside that provider. Never return a key, seed, keystore,
 * serialized signed transaction, or raw signed transaction to AssetFare.
 */
export async function createCallerWalletAdapter(){
  const unavailable=async()=>{throw new Error("configure_caller_owned_wallet_adapter");};
  return {
    info:{
      version:"assetfare-caller-wallet-adapter-v1",
      custody:"caller_owned",
      key_location:"caller_environment_only",
      assetfare_server_key_access:false,
      assetfare_server_signing:false,
      assetfare_server_submission:false,
      signs_locally:true,
      submits_via_caller_rpc:true,
      idempotent_submission_by_operation_id:true
    },
    prepareEvmRequest:unavailable,
    submitEvmRequest:unavailable,
    confirmEvmTransaction:unavailable,
    revokeEvmApproval:unavailable,
    prepareSolanaAction:unavailable,
    submitSolanaAction:unavailable,
    confirmSolanaTransaction:unavailable
  };
}
