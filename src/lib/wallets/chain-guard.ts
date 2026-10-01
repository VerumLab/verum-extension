// Make sure the wallet will send on the chain the page is showing.

export type WalletCall = (method: string, params: unknown[]) => Promise<{ result?: unknown; error?: string }>

// Methods that spend funds on whatever network the wallet is on.
export const CHAIN_BOUND_METHODS = new Set(['eth_sendTransaction', 'wallet_sendCalls'])

// Wallets report the chain id as hex (any case), sometimes as a number or decimal string.
function sameChain(reported: unknown, want: number): boolean {
  try { return BigInt(reported as string | number) === BigInt(want) } catch { return false }
}

/** Resolves null when the wallet is on `want` (switching it first if needed), else a readable error. */
export async function ensureWalletChain(call: WalletCall, want: number, chainName?: string): Promise<string | null> {
  const label = chainName ? `${chainName} (chain ${want})` : `chain ${want}`
  const cur = await call('eth_chainId', [])
  if (cur.error) return `Could not read the wallet's network: ${cur.error}`
  if (sameChain(cur.result, want)) return null

  const sw = await call('wallet_switchEthereumChain', [{ chainId: '0x' + want.toString(16) }])
  if (sw.error) {
    return `Your wallet is on a different network than this page (${label}), and switching failed: ${sw.error}. ` +
      `Switch the wallet to ${label} and try again.`
  }
  // Some wallets report a successful switch without switching: verify.
  const after = await call('eth_chainId', [])
  if (!after.error && !sameChain(after.result, want)) {
    return `Your wallet did not switch to ${label}. Switch it manually and try again.`
  }
  return null
}
