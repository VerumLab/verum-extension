#!/usr/bin/env node
// Publishes W3FS calldata to the chain and prints block:txIndex coordinates.
// Reads one or more 0x-prefixed hex lines from stdin (one line = one tx/chunk).
//
// Usage:
//   node scripts/encode-w3fs.js hello.html | node scripts/publish.js
//   node scripts/encode-w3fs.js --dir ./dist | node scripts/publish.js
//
// After all txs confirm, prints the ENS-ready coordinates:
//   [[blockNumber, txIndex], ...]
//
// Required env:
//   PRIVATE_KEY   — 0x-prefixed private key with ETH
//   RPC_URL       — JSON-RPC endpoint (default: https://rpc.sepolia.org)

import { Wallet, JsonRpcProvider } from 'ethers'

const RPC_URL     = process.env.RPC_URL    ?? 'https://rpc.sepolia.org'
const PRIVATE_KEY = process.env.PRIVATE_KEY

if (!PRIVATE_KEY) {
  console.error('Error: set PRIVATE_KEY environment variable')
  process.exit(1)
}

// Read all hex lines from stdin or arguments
let lines = []
if (process.argv[2]) {
  lines = [process.argv[2].trim()]
} else {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  lines = Buffer.concat(chunks).toString().trim().split('\n').map(l => l.trim()).filter(Boolean)
}

for (const line of lines) {
  if (!line.startsWith('0x')) { console.error(`Invalid calldata (missing 0x): ${line.slice(0, 20)}…`); process.exit(1) }
}

console.error(`Connecting to ${RPC_URL}...`)
const provider = new JsonRpcProvider(RPC_URL)
const wallet   = new Wallet(PRIVATE_KEY, provider)

const { chainId } = await provider.getNetwork()
console.error(`Chain ID: ${chainId}`)

const balance = await provider.getBalance(wallet.address)
console.error(`Sender:  ${wallet.address}`)
console.error(`Balance: ${Number(balance) / 1e18} ETH`)

if (balance === 0n) {
  console.error('Error: no ETH')
  process.exit(1)
}

console.error(`\nSending ${lines.length} transaction(s)...`)

const coords = []

for (let i = 0; i < lines.length; i++) {
  const calldata = lines[i]
  const bytes = calldata.length / 2 - 1
  console.error(`\n[${i + 1}/${lines.length}] Sending ${bytes.toLocaleString()} bytes...`)

  // Calculate gas manually to skip eth_estimateGas (public RPCs reject large request bodies).
  // EIP-7623 (Pectra): floor data gas = (zero_bytes×1 + nonzero_bytes×4) × 10
  // For gzip output (~99% non-zero) this is ~40 gas/byte vs the old 16 gas/byte.
  const raw = Buffer.from(calldata.slice(2), 'hex')
  let zeros = 0n, nonzeros = 0n
  for (const b of raw) { if (b === 0) zeros++; else nonzeros++ }
  const tokens = zeros * 1n + nonzeros * 4n
  const standardDataGas = zeros * 4n + nonzeros * 16n
  const floorDataGas = tokens * 10n
  const dataGas = standardDataGas > floorDataGas ? standardDataGas : floorDataGas
  const gasLimit = 21000n + dataGas + 50000n

  // Send to the W3FS data deposit address — a recognizable fixed address for calldata storage.
  // Nobody holds the private key to 0x...57334653 (W3FS magic bytes padded to 20 bytes).
  const W3FS_DEPOSIT = '0x0000000000000000000000000000000057334653'
  const tx = await wallet.sendTransaction({ to: W3FS_DEPOSIT, data: calldata, gasLimit })
  console.error(`  tx: ${tx.hash}`)
  console.error(`  Waiting for confirmation...`)

  const receipt = await tx.wait(1)
  console.error(`  ✓ block ${receipt.blockNumber}, txIndex ${receipt.index}`)
  coords.push([receipt.blockNumber, receipt.index])
}

const ensValue = JSON.stringify(coords)
const chainPrefix = chainId.toString() === '1' ? '' : `${chainId}:`

console.error('\n─────────────────────────────────────────')
console.error('Name record value (copy to set-name.js):')
console.error(ensValue)
console.error('')
console.error('─────────────────────────────────────────')

// Print coords to stdout so it can be piped
process.stdout.write(ensValue + '\n')
