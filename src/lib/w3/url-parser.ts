import { ensNormalize } from 'ethers'
import type { Web3URL } from '../../types.js'

// Supported formats:
//   w3://myapp.eth                       ENS name (resolved at fetch time)
//   w3://myapp.gwei                      GNS name
//   w3://myapp.wei                       WNS name (contract-served)
//   w3://myapp.eth:<chainId>             Name on a specific chain (ERC-4804 trailing form)
//   w3://<blockNumber>:<txIndex>         Direct tx reference (uses default chain)
//   w3://<chainId>:<blockNumber>:<txIndex>  Tx reference on specific chain (verum leading form)
//   ...with optional /path suffix
//
// Chain id placement differs by target: a NAME (an ERC-4804 host) carries an optional
// trailing ":<chainId>" suffix, matching ERC-4804/ERC-6860; a tx reference (verum-
// specific, not an ERC-4804 host) carries an optional leading "<chainId>:" prefix.

export function parseWeb3URL(raw: string, defaultChainId = 1): Web3URL {
  const stripped = raw.replace(/^w3:\/\//i, '')

  let rest = stripped
  let chainId = defaultChainId
  let path = '/'

  // Strip the URL fragment (#…) before parsing. Fragments are client-side website state (e.g.
  // a share link's #token=ETH&out=wstETH), never part of the ERC-4804 resource, so they
  // must not reach name/path parsing. The renderer extracts the fragment from the raw URL
  // separately and injects it into the sandbox so the website can restore its state.
  const hashIdx = rest.indexOf('#')
  if (hashIdx !== -1) rest = rest.slice(0, hashIdx)

  // Extract trailing path and/or query (everything from the first '/' or '?').
  // Splitting on '?' too lets a name normalize cleanly when the URL is query-only
  // (e.g. myapp.wei?x=1), and carries ERC-5219 params through in `path`.
  const sepIdx = rest.search(/[/?]/)
  if (sepIdx !== -1) {
    path = rest.slice(sepIdx)
    rest = rest.slice(0, sepIdx)
  }

  // Raw contract address (ERC-4804 authority): web3://0x<40 hex>[:<chainId>][/path].
  // No name resolution — the contract is served directly (ERC-5219 / ERC-8244).
  {
    const addrMatch = rest.match(/^(0x[0-9a-fA-F]{40})(?::(\d+))?$/)
    if (addrMatch) {
      if (addrMatch[2]) chainId = parseInt(addrMatch[2], 10)
      return { raw, chainId, target: { type: 'contract', address: addrMatch[1] }, path }
    }
  }

  // ENS/GNS/WNS name — anything with a dot (resolveName picks the registry by TLD).
  // Chain id, if present, is a trailing ":<chainId>" suffix on the host, e.g.
  // myapp.eth:10 (ERC-4804 / ERC-6860 form). The colon must be the last one and be
  // followed by digits; the label before it must still contain the name's dot.
  if (rest.includes('.')) {
    let namePart = rest
    const m = rest.match(/^(.+):(\d+)$/)
    if (m && m[1].includes('.')) {
      namePart = m[1]
      chainId = parseInt(m[2], 10)
    }
    let name: string
    try {
      name = ensNormalize(namePart)
    } catch {
      throw new Error(`Invalid ENS/GNS/WNS name: "${namePart}"`)
    }
    return { raw, chainId, target: { type: 'ens', name }, path }
  }

  // Direct tx reference(s): one or more blockNumber:txIndex pairs separated by +,
  // with an optional leading "<chainId>:" prefix.
  const firstColon = rest.indexOf(':')
  if (firstColon !== -1) {
    const maybeChain = rest.slice(0, firstColon)
    const remainder = rest.slice(firstColon + 1)
    if (/^\d+$/.test(maybeChain) && /^(\d+:\d+)(\+\d+:\d+)*$/.test(remainder)) {
      // chainId:block:txIndex (or chainId:block:txIndex+block2:txIndex2)
      chainId = parseInt(maybeChain, 10)
      const refs = remainder.split('+').map(part => {
        const [b, t] = part.split(':')
        return { blockNumber: parseInt(b, 10), txIndex: parseInt(t, 10) }
      })
      return { raw, chainId, target: { type: 'tx', refs }, path }
    }
  }

  if (/^(\d+:\d+)(\+\d+:\d+)*$/.test(rest)) {
    const refs = rest.split('+').map(part => {
      const [b, t] = part.split(':')
      return { blockNumber: parseInt(b, 10), txIndex: parseInt(t, 10) }
    })
    return { raw, chainId, target: { type: 'tx', refs }, path }
  }

  throw new Error(`Invalid w3 URL: expected an ENS/GNS/WNS name (e.g. myapp.eth or myapp.wei) or block:txIndex`)
}

export function formatWeb3URL(parsed: Web3URL): string {
  const path = parsed.path === '/' ? '' : parsed.path
  if (parsed.target.type === 'tx') {
    // verum tx form: leading "<chainId>:" prefix
    const chain = parsed.chainId !== 1 ? `${parsed.chainId}:` : ''
    const refs = parsed.target.refs.map(r => `${r.blockNumber}:${r.txIndex}`).join('+')
    return `w3://${chain}${refs}${path}`
  }
  // ERC-4804 host form: trailing ":<chainId>" suffix
  const chain = parsed.chainId !== 1 ? `:${parsed.chainId}` : ''
  const host = parsed.target.type === 'contract' ? parsed.target.address : parsed.target.name
  return `w3://${host}${chain}${path}`
}
