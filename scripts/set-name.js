#!/usr/bin/env node
// Set the "w3" text record on a name so w3://<name> resolves to your calldata.
//
// One script for every name service verum resolves:
//   .eth   → ENS  (registry/resolver split, NameWrapper & BaseRegistrar auth)
//   .gwei  → GNS  (https://gwei.domains) — NameNFT is registry+resolver in one
//   .wei   → WNS  (https://wei.domains)  — NameNFT is registry+resolver in one
//
// GNS and WNS share the same NameNFT interface: a plain ERC-721 whose
// setText(uint256 tokenId, …) just checks ownerOf(). Only ENS needs the
// registry.resolver(node) hop and the wrapper/registrar dance.
//
// Usage:
//   node scripts/set-name.js [--resolver <addr>] <name> <rpc-url> <private-key> <ref> [<ref2> ...]
//   node scripts/publish.js < bundle.hex | node scripts/set-name.js <name> <rpc-url> <private-key>
//
// Each <ref> is coordinates "blockNum:idx", used directly — no lookup needed.
// Writes the compact format: [[blockNumber, txIndex], ...]
//
// The --resolver <addr> flag applies to ENS only (override the resolver used for
// setText when the auto-detected one has an incompatible NameWrapper reference).
//
// Prerequisites:
//   - You own the name (.eth via ENS; .gwei via gwei.domains; .wei via wei.domains)
//   - For .eth, the resolver must support setText() (PublicResolver does)

import { ethers } from 'ethers'

// --- Parse args (pull the ENS-only --resolver flag out first) ---
const rawArgs = process.argv.slice(2)
let resolverOverride = null
const resolverFlagIdx = rawArgs.indexOf('--resolver')
if (resolverFlagIdx !== -1) {
  resolverOverride = rawArgs[resolverFlagIdx + 1]
  rawArgs.splice(resolverFlagIdx, 2)
}

const [name, rpcUrl, privateKey, ...rest] = rawArgs

if (!name || !rpcUrl || !privateKey) {
  console.error('Usage:')
  console.error('  node scripts/set-name.js [--resolver <addr>] <name> <rpc> <key> <block>:<idx> [...]')
  console.error('  node scripts/publish.js < bundle.hex | node scripts/set-name.js <name> <rpc> <key>')
  process.exit(1)
}

// --- Read refs from args or from stdin (piped from publish.js) ---
async function readRefs() {
  if (rest.length > 0) {
    for (const ref of rest) {
      if (!/^\d+:\d+$/.test(ref)) {
        console.error(`Invalid ref (expected <block>:<idx>): ${ref}`); process.exit(1)
      }
    }
    return rest
  }
  const stdin = []
  for await (const chunk of process.stdin) stdin.push(chunk)
  const raw = Buffer.concat(stdin).toString().trim()
  if (!raw) { console.error('No refs provided and stdin is empty'); process.exit(1) }
  try {
    return JSON.parse(raw).map(([b, i]) => `${b}:${i}`)
  } catch {
    console.error(`Could not parse stdin as JSON array: ${raw}`); process.exit(1)
  }
}

function browseUrl(chainId, name) {
  const chainPrefix = chainId.toString() === '1' ? '' : `${chainId}:`
  return `w3://${chainPrefix}${name}`
}

// --- Name services whose NameNFT is registry+resolver in one (GNS, WNS) ---
// tokenId = uint256(namehash(name)); setText(tokenId, …) checks ownerOf().
const NAME_NFT_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function isExpired(uint256 tokenId) view returns (bool)',
  'function setText(uint256 tokenId, string key, string value)',
]

const NAME_NFTS = {
  // GNS (.gwei) — same address on mainnet and Sepolia
  gwei: { service: 'GNS', address: '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6', register: 'https://gwei.domains' },
  // WNS (.wei) — Ethereum mainnet
  wei:  { service: 'WNS', address: '0x0000000000696760E15f265e828DB644A0c242EB', register: 'https://wei.domains' },
}

async function setViaNameNft(cfg, wallet, provider, value) {
  const chainId = (await provider.getNetwork()).chainId
  // Token ID = uint256(namehash(name)) — same EIP-137 algorithm ethers.namehash
  // implements, no service-specific hashing needed.
  const tokenId = BigInt(ethers.namehash(name))
  const nft = new ethers.Contract(cfg.address, NAME_NFT_ABI, provider)

  let owner
  try {
    owner = await nft.ownerOf(tokenId)
  } catch {
    console.error(`"${name}" is not registered. Register it first at ${cfg.register}`)
    process.exit(1)
  }
  if (await nft.isExpired(tokenId)) {
    console.error(`"${name}" is expired (past its grace period). Register it first at ${cfg.register}`)
    process.exit(1)
  }
  if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
    console.error(`Not authorized: "${name}" is owned by ${owner}, signer is ${wallet.address}`)
    process.exit(1)
  }

  console.log(`\nSetting ${cfg.service} text record "w3" = ${value}`)
  const tx = await nft.connect(wallet).setText(tokenId, 'w3', value)
  await tx.wait()
  console.log(`✓ Done. Browse at: ${browseUrl(chainId, name)}`)
}

// --- ENS (.eth): registry/resolver split, NameWrapper & BaseRegistrar auth ---
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'

const REGISTRY_ABI = [
  'function resolver(bytes32 node) view returns (address)',
  'function owner(bytes32 node) view returns (address)',
]
const RESOLVER_ABI = [
  'function setText(bytes32 node, string key, string value) external',
  'function nameWrapper() view returns (address)',
]
const NAMEWRAPPER_ABI = [
  'function ownerOf(uint256 id) view returns (address)',
  'function setResolver(bytes32 node, address resolver) external',
]
const BASEREGISTRAR_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function reclaim(uint256 id, address owner) external',
]

async function setViaEns(wallet, provider, value) {
  const chainId = (await provider.getNetwork()).chainId
  const registry = new ethers.Contract(ENS_REGISTRY, REGISTRY_ABI, provider)
  const node = ethers.namehash(name)

  const [registryOwner, resolverAddr] = await Promise.all([
    registry.owner(node),
    registry.resolver(node),
  ])

  if (resolverAddr === ethers.ZeroAddress) {
    console.error(`No resolver set for ${name}. Set one at app.ens.domains first.`)
    process.exit(1)
  }

  console.log(`\nSetting ENS text record "w3" = ${value}`)
  const resolver = new ethers.Contract(resolverAddr, RESOLVER_ABI, wallet)

  // --- Simple case: signer directly owns the name in the registry ---
  if (registryOwner.toLowerCase() === wallet.address.toLowerCase()) {
    const tx = await resolver.setText(node, 'w3', value)
    await tx.wait()
    console.log(`✓ Done. Browse at: ${browseUrl(chainId, name)}`)
    return
  }

  // --- Registry owner is not the signer (wrapped name or legacy registrar) ---
  // Don't pre-check ownerOf — the NameWrapper may have stale state (e.g. name re-registered
  // after expiry; the ERC-1155 token burns while the registry entry lingers). Instead, simulate
  // setText via staticCall. If the resolver accepts it, proceed. If not, diagnose from the error.
  console.log(`Registry owner is ${registryOwner} — attempting setText simulation...`)
  const simOk = await resolver.setText.staticCall(node, 'w3', value).then(() => true).catch(() => false)

  if (!simOk) {
    // Gather diagnostics.
    let resolverNW = '(no nameWrapper() getter)'
    try { resolverNW = await resolver.nameWrapper() } catch { /* older resolver */ }

    let nwTokenOwner = '(ownerOf failed)'
    try {
      const nw = new ethers.Contract(registryOwner, ['function ownerOf(uint256) view returns (address)'], provider)
      nwTokenOwner = await nw.ownerOf(BigInt(node))
    } catch { /* not a NameWrapper */ }

    // If caller supplied --resolver, try switching to it via NameWrapper then retry.
    if (resolverOverride) {
      console.log(`Simulation failed — switching resolver to ${resolverOverride} via NameWrapper...`)
      const nwWrite = new ethers.Contract(registryOwner, NAMEWRAPPER_ABI, wallet)
      const setResolverTx = await nwWrite.setResolver(node, resolverOverride)
      await setResolverTx.wait()
      console.log(`Resolver updated. Retrying...`)
      const newResolver = new ethers.Contract(resolverOverride, RESOLVER_ABI, wallet)
      const tx2 = await newResolver.setText(node, 'w3', value)
      await tx2.wait()
      console.log(`✓ Done. Browse at: ${browseUrl(chainId, name)}`)
      return
    }

    // BaseRegistrar reclaim path: if the NameWrapper ERC-1155 token is zero/stale (e.g. name
    // re-registered after expiry), the user may still hold the BaseRegistrar ERC-721.
    // reclaim() updates the registry owner to the wallet address so the old resolver accepts setText.
    const ethNode = ethers.namehash('eth')
    const baseRegistrarAddr = await registry.owner(ethNode)
    const label = name.split('.')[0]
    const labelhash = BigInt(ethers.keccak256(ethers.toUtf8Bytes(label)))
    const baseRegistrar = new ethers.Contract(baseRegistrarAddr, BASEREGISTRAR_ABI, provider)

    let erc721Owner
    try { erc721Owner = await baseRegistrar.ownerOf(labelhash) } catch { /* not found */ }

    if (erc721Owner?.toLowerCase() === wallet.address.toLowerCase()) {
      console.log(`BaseRegistrar ERC-721 owned by signer — reclaiming registry entry...`)
      const brWrite = new ethers.Contract(baseRegistrarAddr, BASEREGISTRAR_ABI, wallet)
      const reclaimTx = await brWrite.reclaim(labelhash, wallet.address)
      await reclaimTx.wait()
      console.log(`Registry owner updated to ${wallet.address}. Retrying setText...`)
      // Now registry.owner(node) == wallet.address so the old resolver accepts the call.
      const tx2 = await resolver.setText(node, 'w3', value)
      await tx2.wait()
      console.log(`✓ Done. Browse at: ${browseUrl(chainId, name)}`)
      return
    }

    throw new Error(
      `setText simulation failed — not authorized.\n\n` +
      `  signer:                 ${wallet.address}\n` +
      `  registry owner:         ${registryOwner}\n` +
      `  resolver:               ${resolverAddr}\n` +
      `  resolver.nameWrapper(): ${resolverNW}\n` +
      `  nameWrapper.ownerOf():  ${nwTokenOwner}\n` +
      `  baseRegistrar:          ${baseRegistrarAddr}\n` +
      `  baseRegistrar.ownerOf(): ${erc721Owner ?? '(failed)'}\n\n` +
      `Fallback: app.ens.domains → ${name} → Edit Records.`
    )
  }

  const tx = await resolver.setText(node, 'w3', value)
  await tx.wait()
  console.log(`✓ Done. Browse at: ${browseUrl(chainId, name)}`)
}

async function main() {
  const refs = await readRefs()
  const chunks = refs.map((ref) => ref.split(':').map(Number))
  const value = JSON.stringify(chunks)

  const provider = new ethers.JsonRpcProvider(rpcUrl)
  const wallet = new ethers.Wallet(privateKey, provider)

  const lower = name.toLowerCase()
  const nftKey = Object.keys(NAME_NFTS).find((tld) => lower.endsWith(`.${tld}`))
  if (resolverOverride && nftKey) {
    console.error(`--resolver applies to ENS (.eth) names only; ignoring it for .${nftKey}`)
  }

  if (nftKey) {
    await setViaNameNft(NAME_NFTS[nftKey], wallet, provider, value)
  } else {
    await setViaEns(wallet, provider, value)
  }
}

main().catch((err) => { console.error(err.message); process.exit(1) })
