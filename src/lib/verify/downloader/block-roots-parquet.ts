// Era block_roots via ethpandaops xatu canonical_beacon_block parquet exports.
// Faster than era files for recent-but-not-current eras since rows are queried
// directly rather than range-fetched and decompressed; unavailable for the
// current era (export lag) and only covers mainnet/sepolia/holesky.

import { parquetRead, asyncBufferFromUrl } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import type { AsyncBuffer } from 'hyparquet/src/types.js'
import { getBytes } from 'ethers'
import { slotToTimestamp, computeEraBlockSummaryRoot } from '../beacon-primitives.js'

const XATU_CHAIN: Record<number, string> = {
  1:        'mainnet',
  11155111: 'sepolia',
  17000:    'holesky',
}
const XATU_BASE = 'https://data.ethpandaops.io/xatu'

function dateKey(unixTs: number): string {
  const d = new Date(unixTs * 1000)
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

function eraDates(eraStartSlot: number, chainId: number): string[] {
  const keys = new Set<string>()
  for (const slot of [eraStartSlot, eraStartSlot + 4096, eraStartSlot + 8191]) {
    keys.add(dateKey(slotToTimestamp(slot, chainId)))
  }
  return [...keys]
}

interface ParquetRow { slot: bigint; block_root: Uint8Array }

async function fetchParquetDayRoots(
  url: string,
  eraStartSlot: number,
  eraEndSlot: number,
): Promise<ParquetRow[]> {
  let asyncBuffer: AsyncBuffer
  try {
    asyncBuffer = await asyncBufferFromUrl({ url })
  } catch {
    return []
  }
  const rows: ParquetRow[] = []
  await parquetRead({
    file: asyncBuffer,
    compressors,
    columns: ['slot', 'block_root'],
    rowFormat: 'object',
    onComplete(data: Record<string, unknown>[]) {
      for (const row of data) {
        const s = Number(row['slot'] as bigint)
        if (s >= eraStartSlot && s <= eraEndSlot) rows.push(row as unknown as ParquetRow)
      }
    },
  })
  return rows
}

export async function fetchEraBlockRootsFromParquet(
  era: number,
  chainId: number,
  expectedBlockSummaryRoot: string,
  customParquetUrls?: string[],
): Promise<Uint8Array[] | null> {
  const network = XATU_CHAIN[chainId]
  // undefined → use built-in default; [] → skip parquet entirely
  if (customParquetUrls !== undefined && customParquetUrls.length === 0) return null
  if (!network && !customParquetUrls?.length) return null

  const eraStartSlot = era * 8192
  const eraEndSlot   = eraStartSlot + 8191
  const defaultBase  = network ? `${XATU_BASE}/${network}/databases/default/canonical_beacon_block` : null
  const bases        = customParquetUrls !== undefined
    ? [...customParquetUrls, ...(defaultBase ? [defaultBase] : [])]
    : (defaultBase ? [defaultBase] : [])

  const slotSet = new Set<number>()
  const allRows: ParquetRow[] = []
  for (const base of bases) {
    for (const d of eraDates(eraStartSlot, chainId)) {
      try {
        const rows = await fetchParquetDayRoots(`${base}/${d}.parquet`, eraStartSlot, eraEndSlot)
        console.log(`[w3] Parquet ${d}: ${rows.length} rows in era range`)
        for (const row of rows) {
          if (!slotSet.has(Number(row.slot))) { slotSet.add(Number(row.slot)); allRows.push(row) }
        }
      } catch (e) {
        console.log(`[w3] Parquet ${d}: ${(e as Error).message}`)
      }
    }
    if (allRows.length > 0) break  // first base that returned data wins
  }

  if (allRows.length === 0) {
    console.log(`[w3] Parquet: no data for era ${era}`)
    return null
  }

  // Build block_roots[8192] — FixedString(66) arrives as Uint8Array of ASCII "0xabcd..."
  const roots: (Uint8Array | null)[] = new Array(8192).fill(null)
  const decoder = new TextDecoder()
  for (const row of allRows) {
    const j = Number(row.slot) - eraStartSlot
    if (j >= 0 && j < 8192) roots[j] = getBytes(decoder.decode(row.block_root))
  }
  // Forward-fill: missed slot inherits the most recent non-null root to its left
  for (let j = 1; j < 8192; j++) {
    if (roots[j] === null) roots[j] = roots[j - 1]
  }
  const ZERO = new Uint8Array(32)
  for (let j = 0; j < 8192; j++) {
    if (roots[j] === null) roots[j] = ZERO
  }
  const finalRoots = roots as Uint8Array[]

  const computed = computeEraBlockSummaryRoot(finalRoots)
  if (computed.toLowerCase() !== expectedBlockSummaryRoot.toLowerCase()) {
    console.warn(`[w3] Parquet: block_summary_root mismatch (era may be incomplete)`)
    return null
  }
  console.log(`[w3] Parquet: era ${era} block_roots verified ✓`)
  return finalRoots
}
