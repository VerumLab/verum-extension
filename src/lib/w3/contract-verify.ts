import type { IVerifiedRpc } from '../rpc/light-client.js'
import { fetchContractContent } from './erc5219.js'
import type { ContractContent } from './erc5219.js'

// Fast path for verifying a contract-served page without waiting for Helios's head.
//
// The page was painted from the plain RPC at the current head. If Helios, reading the SAME contract at the
// finalized block (which it can do straight after a cold start, unlike 'latest'), returns the same bytes, then the
// bytes on screen are exactly what Helios proved. Anything else — a contract deployed in the last ~13 minutes, or
// one whose output changed since — is not decided here and falls back to the 'latest' comparison.
export type FinalizedCheck =
  | { status: 'match'; content: ContractContent }
  | { status: 'different' }       // not there yet / different bytes at the finalized block: settled by 'latest'
  | { status: 'unavailable' }     // Helios could not answer at all (shut down, out of sync, …): try again

const isInfra = (e: unknown) => /out of sync|shut down|wasm call timeout|not available|all rpcs failed/i.test((e as Error)?.message ?? '')

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export async function checkAtFinalized(
  rpc: IVerifiedRpc, address: string, path: string, painted: Uint8Array,
): Promise<FinalizedCheck> {
  try {
    const content = await fetchContractContent(rpc, address, path, 'finalized')
    return same(content.body, painted) ? { status: 'match', content } : { status: 'different' }
  } catch (e) {
    return isInfra(e) ? { status: 'unavailable' } : { status: 'different' }
  }
}
