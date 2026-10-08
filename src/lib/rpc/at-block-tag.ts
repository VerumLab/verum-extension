import type { IVerifiedRpc } from './light-client.js'

// Wraps a verified RPC so its `eth_call`s that ask for 'latest' ask for `tag` instead.
//
// Helios refuses calls at the 'latest' tag while its head is more than 60s old, and right after a cold start the
// head can stay that old for minutes (see light-client.ts: its head only moves when the beacon provider publishes a
// new finality update). Calls at 'finalized' are not age-checked, so a cold Helios can serve them immediately.
export function atBlockTag(rpc: IVerifiedRpc, tag: string): IVerifiedRpc {
  return {
    isHeliosBacked: () => rpc.isHeliosBacked(),
    request<T>(method: string, params: unknown[], quickFail?: boolean): Promise<T> {
      if (method === 'eth_call' && Array.isArray(params) && params[1] === 'latest') {
        return rpc.request<T>(method, [params[0], tag, ...params.slice(2)], quickFail)
      }
      return rpc.request<T>(method, params, quickFail)
    },
  }
}
