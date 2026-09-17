export interface Web3URL {
  raw: string
  chainId: number
  target: EnsTarget | TxTarget | ContractTarget
  path: string
}

export interface EnsTarget {
  type: 'ens'
  name: string
}

// A raw contract address as the ERC-4804 authority (web3://0x…). No name resolution —
// the contract is served directly via ERC-5219 request() / ERC-8244 html().
export interface ContractTarget {
  type: 'contract'
  address: string
}

export interface TxTarget {
  type: 'tx'
  refs: Array<{ blockNumber: number; txIndex: number }>
}

// W3FS calldata encoding
export const W3FS_MAGIC = 0x57334653 // "W3FS"

export type Compression = 'none' | 'gzip' | 'deflate' | 'brotli'

export interface ContentChunk {
  version: number
  contentType: string
  compression: Compression
  chunkIndex: number
  totalChunks: number
  data: Uint8Array
}

export interface VerificationResult {
  verified: boolean
  blockNumber: number
  blockHash: string
  blockTimestamp: number
  txHash: string
  txIndex: number
  trieVerified: boolean
  headerVerified: boolean
  calldata: Uint8Array
}

export interface ChainConfig {
  chainId: number
  consensusRpcs: string[]  // beacon API endpoints tried in order
  rpcs: string[]           // execution RPC endpoints tried in order
  name: string
  localMode?: boolean                  // use only rpcs[0] at batch 1000, skip era/parquet
  portalRpc?: string       // optional local Portal Network node (e.g. http://localhost:8545)
  checkpointUrls?: string[]           // checkpoint sync providers (prepended before built-in defaults)
  eraFileUrls?: string[]              // era file base URLs (prepended before built-in defaults)
  parquetUrls?: string[]              // xatu parquet base URLs (prepended before built-in defaults)
  rpcBatchSizes?: Record<string, number>  // max JSON-RPC batch size per execution RPC URL
  // The inactive RPC set, preserved across the local-mode toggle: when local mode is on
  // these hold the public RPCs (and vice-versa), so editing the active set never touches
  // the other. `rpcs`/`consensusRpcs` are always the ACTIVE set (what verification uses).
  savedRpcs?: string[]
  savedConsensusRpcs?: string[]
}

export const DEFAULT_CHAINS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    name: 'Mainnet',
    consensusRpcs: [
      'https://ethereum-beacon-api.publicnode.com',
      'https://lodestar-mainnet.chainsafe.io',
    ],
    // Every entry is verified to serve what Helios needs: eth_call and
    // eth_getProof at recent (finalized) blocks, plus JSON-RPC batching. Many
    // public RPCs answer eth_call fine but reject eth_getProof outside the last
    // ~128 blocks (-32602), which breaks Helios silently — so they are excluded.
    // cloudflare-eth.com was removed entirely: the public gateway is retired and
    // now answers every call with -32046 "Cannot fulfill request".
    rpcs: [
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://rpc.mevblocker.io',
      'https://eth-mainnet.public.blastapi.io',
      'https://gateway.tenderly.co/public/mainnet',
    ],
    rpcBatchSizes: {
      'https://ethereum-rpc.publicnode.com': 200,
      'https://eth.drpc.org': 200,
      'https://rpc.mevblocker.io': 200,
      'https://eth-mainnet.public.blastapi.io': 200,
      'https://gateway.tenderly.co/public/mainnet': 200,
    },
    checkpointUrls: [
      'https://beaconstate-mainnet.chainsafe.io',
      'https://beaconstate.ethstaker.cc',
      'https://mainnet.checkpoint.sigp.io',
    ],
    eraFileUrls: [
      'https://mainnet.era.nimbus.team',
    ],
    parquetUrls: [
      'https://data.ethpandaops.io/xatu/mainnet/databases/default/canonical_beacon_block',
    ],
  },
  11155111: {
    chainId: 11155111,
    name: 'Sepolia',
    consensusRpcs: [
      'https://lodestar-sepolia.chainsafe.io',
      'https://ethereum-sepolia-beacon-api.publicnode.com',
    ],
    rpcs: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.drpc.org',
      'https://gateway.tenderly.co/public/sepolia',
      'https://rpc.sepolia.ethpandaops.io',
    ],
    rpcBatchSizes: {
      'https://ethereum-sepolia-rpc.publicnode.com': 200,
      'https://sepolia.drpc.org': 200,
      'https://gateway.tenderly.co/public/sepolia': 200,
      'https://rpc.sepolia.ethpandaops.io': 200,
    },
    checkpointUrls: [
      'https://checkpoint-sync.sepolia.ethpandaops.io',
      'https://beaconstate-sepolia.chainsafe.io',
    ],
    eraFileUrls: [
      'https://sepolia.era.nimbus.team',
    ],
    parquetUrls: [
      'https://data.ethpandaops.io/xatu/sepolia/databases/default/canonical_beacon_block',
    ],
  },
}

// ---------------------------------------------------------------------------
// Developer mode — force a single source instead of the automatic strategy.
// Normal operation ('auto') races/falls back across sources; forcing one makes
// a strategy fail loudly instead of silently falling through to the next, which
// is what you want when testing that strategy specifically.
// Stored in chrome.storage.sync alongside `chains` / `defaultChain`.
// ---------------------------------------------------------------------------

// Where an era's 8192 block_roots come from (Mode 2, historical blocks).
export type EraSource = 'auto' | 'era-file' | 'parquet' | 'exec-headers'

// Where the finalized BeaconState is downloaded from (Mode 2).
export type StateSource = 'auto' | 'consensus-rpc' | 'checkpoint'

// How historical_summaries is obtained (Mode 2). 'era-tail' = era-file tail + LC-branch
// reconstruction (~23 MB, seconds); 'full-state' = the full BeaconState download (~136 MB).
// 'auto' tries era-tail first and falls back to full-state; the pins force one path only.
export type HistSource = 'auto' | 'era-tail' | 'full-state'

// Which verification mode runs. 'auto' picks by block age: blocks inside Helios's
// EIP-2935 window (~27h) go to Mode 1, older ones to Mode 2. Forcing 'beacon' is
// what makes the era / BeaconState sources above reachable for a recent block —
// otherwise Mode 1 handles it and neither source is ever touched.
export type ForceMode = 'auto' | 'helios' | 'beacon'

export interface DevSettings {
  devMode: boolean
  forceMode: ForceMode
  eraSource: EraSource
  stateSource: StateSource
  histSource: HistSource
}

export const DEFAULT_DEV_SETTINGS: DevSettings = {
  devMode: false,
  forceMode: 'auto',
  eraSource: 'auto',
  stateSource: 'auto',
  histSource: 'auto',
}

export interface WalletInfo {
  tabId: number
  title: string
  walletName: string
  url: string
}

// Messages between background and renderer
export type BgMessage =
  | { type: 'resolve'; url: string }

export type BgResponse =
  | { type: 'content'; assembled: number[]; contentType: string }
  | { type: 'error'; message: string; ipfs?: boolean }   // ipfs: name is an IPFS site — open its gateway
  | VerificationUpdate

export interface VerificationUpdate {
  type: 'verification-update'
  heliosBacked: boolean
  trieVerified: boolean
  localMode?: boolean        // local execution RPC, no beacon proof
  portalVerified?: boolean   // verified via local Portal Network node
  beaconVerified?: boolean
  beaconHeliosAnchored?: boolean    // parentBeaconBlockRoot anchor resolved
  beaconEraVerified?: boolean       // historical_summaries era cross-check passed
  beaconStateHashVerified?: boolean // full hash_tree_root(BeaconState) computed locally
  ensVerified?: boolean | null      // true = confirmed; false = mismatch (possible forgery); null/undefined = unverified
  proof: {
    url: string
    blockNumber: number
    blockHash: string
    // tx-calldata targets only — a contract-served (ERC-5219/8244) page has no tx.
    txHash?: string
    txIndex?: number
    contentType: string
    payloadSize: string
    // One entry per chunk (multi-chunk dapps) — the singular fields above describe
    // the last chunk; all chunks listed here were verified.
    chunks?: Array<{ blockNumber: number; txIndex: number; txHash: string }>
    // Contract-served (ERC-5219/8244) targets only.
    contractAddress?: string
    cacheControl?: string   // ERC-5219 Cache-Control header: "immutable" ⇒ pinned artifact
  }
}

// Bump when the Terms of Use change materially — users must re-accept on the
// onboarding page before Verum will load content again.
export const AGREEMENT_VERSION = 1
