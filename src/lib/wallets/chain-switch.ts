// Runtime network switching for a page running inside Verum (EIP-3326 wallet_switchEthereumChain,
// and EIP-3085 wallet_addEthereumChain treated as a switch).
//
// A page is loaded and verified from the chain in its w3:// URL (the "content chain"), but a multi-chain
// website needs to talk to other networks at runtime.
//
// Limits (deliberate):
//  - only chains Verum has configured; 
//  - when a wallet is connected, the wallet switches too, with its own approval;
//  - the content chain, and with it the verification badge, never changes;

export const CHAIN_SWITCH_METHODS = new Set(['wallet_switchEthereumChain', 'wallet_addEthereumChain'])

export interface ChainSwitchDeps {
  active: number                                          // the chain the provider is on now
  configured: ReadonlySet<number>                         // chains Verum is configured for
  walletConnected: boolean
  switchWallet: (want: number) => Promise<string | null>  // switch the connected wallet; null = ok, else an error message
}

export type ChainSwitchResult =
  | { ok: true; chainId: number; changed: boolean }
  | { ok: false; error: string; code: number }

// EIP-1193 / EIP-3326 error codes.
const USER_REJECTED = 4001
const UNRECOGNIZED_CHAIN = 4902
const INVALID_PARAMS = -32602
const INTERNAL = -32603

export const chainHex = (n: number) => '0x' + n.toString(16)

/** Reads params[0].chainId. EIP-695 requires a 0x-prefixed hex string, so nothing else is accepted. */
export function parseChainIdParam(params: unknown): number | null {
  const first = Array.isArray(params) ? params[0] : params
  const raw = (first as { chainId?: unknown } | null | undefined)?.chainId
  if (typeof raw !== 'string' || !/^0x[0-9a-fA-F]+$/.test(raw)) return null
  const n = BigInt(raw)
  if (n <= 0n || n > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(n)
}

export async function requestChainSwitch(params: unknown, deps: ChainSwitchDeps): Promise<ChainSwitchResult> {
  const want = parseChainIdParam(params)
  if (want === null) {
    return { ok: false, code: INVALID_PARAMS, error: "Expected a 0x-prefixed hexadecimal 'chainId'." }
  }
  if (want === deps.active) return { ok: true, chainId: want, changed: false }
  if (!deps.configured.has(want)) {
    return {
      ok: false, code: UNRECOGNIZED_CHAIN,
      error: `Unrecognized chain ID "${chainHex(want)}". Verum only supports the chains configured in its settings.`,
    }
  }
  if (deps.walletConnected) {
    const err = await deps.switchWallet(want)
    if (err) return { ok: false, code: /reject|denied|cancel/i.test(err) ? USER_REJECTED : INTERNAL, error: err }
  }
  return { ok: true, chainId: want, changed: true }
}