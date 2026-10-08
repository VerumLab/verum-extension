// Contract-code deployment of a single self-contained HTML file, served by ERC-5219 request() (what web3://
// gateways use) and ERC-8244 html().
//
// The file is split into "data contracts" (runtime code = 0x00 + a slice of the file) and a small
// VerumSite contract (contracts/src/VerumSite.sol) that records their addresses and returns the
// concatenated bytes from request() and html(). Nothing in it can be changed after deployment.

import { AbiCoder } from 'ethers'
import type { GasSchedule } from './encoder.js'

// Creation bytecode of contracts/src/VerumSite.sol (solc 0.8.26, optimizer 200, cancun, no metadata).
// Rebuild with `cd contracts && forge build && forge inspect VerumSite bytecode`.
export const SITE_CREATION_CODE = '0x' +
  '608060405234801561000f575f80fd5b5060405161087138038061087183398101604081905261002e916100ed565b80' +
  '51610040905f906020840190610047565b50506101b7565b828054828255905f5260205f2090810192821561009a5791' +
  '60200282015b8281111561009a57825182546001600160a01b0319166001600160a01b03909116178255602090920191' +
  '600190910190610065565b506100a69291506100aa565b5090565b5b808211156100a6575f81556001016100ab565b63' +
  '4e487b7160e01b5f52604160045260245ffd5b80516001600160a01b03811681146100e8575f80fd5b919050565b5f60' +
  '2082840312156100fd575f80fd5b81516001600160401b03811115610112575f80fd5b8201601f81018413610122575f' +
  '80fd5b80516001600160401b0381111561013b5761013b6100be565b604051600582901b90603f8201601f1916810160' +
  '01600160401b0381118282101715610169576101696100be565b60405291825260208184018101929081018784111561' +
  '0186575f80fd5b6020850194505b838510156101ac5761019e856100d2565b81526020948501940161018d565b509695' +
  '505050505050565b6106ad806101c45f395ff3fe608060405234801561000f575f80fd5b506004361061003f575f3560' +
  'e01c80631374c4601461004357806333c34ac31461006e578063dd473fae14610083575b5f80fd5b6100566100513660' +
  '0461048f565b610098565b60405161006593929190610599565b60405180910390f35b61007661017c565b6040516100' +
  '659190610640565b604051633532313960e01b8152602001610065565b6040805160018082528183019092525f916060' +
  '918291816020015b60408051808201909152606080825260208201528152602001906001900390816100b35790505090' +
  '5060405180604001604052806040518060400160405280600c81526020016b436f6e74656e742d5479706560a01b8152' +
  '5081526020016040518060400160405280601881526020017f746578742f68746d6c3b20636861727365743d7574662d' +
  '380000000000000000815250815250815f8151811061015c5761015c610659565b602002602001018190525060c86101' +
  '7161018b565b925092509250925092565b606061018661018b565b905090565b5f8054606091805b828110156101e257' +
  '60015f82815481106101af576101af610659565b5f918252602090912001546101ce91906001600160a01b03163b6106' +
  '81565b6101d8908361069a565b9150600101610193565b505f8167ffffffffffffffff8111156101fd576101fd610296' +
  '565b6040519080825280601f01601f191660200182016040528015610227576020820181803683370190505b5090505f' +
  '805b8481101561028c575f80828154811061024857610248610659565b5f9182526020822001546001600160a01b0316' +
  '91506102696001833b610681565b9050806001856020880101843c610280818561069a565b9350505060010161022d56' +
  '5b5090949350505050565b634e487b7160e01b5f52604160045260245ffd5b6040805190810167ffffffffffffffff81' +
  '1182821017156102cd576102cd610296565b60405290565b604051601f8201601f1916810167ffffffffffffffff8111' +
  '82821017156102fc576102fc610296565b604052919050565b5f67ffffffffffffffff82111561031d5761031d610296' +
  '565b5060051b60200190565b5f82601f830112610336575f80fd5b813567ffffffffffffffff81111561035057610350' +
  '610296565b610363601f8201601f19166020016102d3565b818152846020838601011115610377575f80fd5b81602085' +
  '0160208301375f918101602001919091529392505050565b5f82601f8301126103a2575f80fd5b81356103b56103b082' +
  '610304565b6102d3565b8082825260208201915060208360051b8601019250858311156103d6575f80fd5b602085015b' +
  '8381101561048557803567ffffffffffffffff8111156103f9575f80fd5b86016040818903601f1901121561040e575f' +
  '80fd5b6104166102aa565b602082013567ffffffffffffffff81111561042f575f80fd5b61043e8a6020838601016103' +
  '27565b825250604082013567ffffffffffffffff81111561045a575f80fd5b6104698a602083860101610327565b6020' +
  '8301525080855250506020830192506020810190506103db565b5095945050505050565b5f80604083850312156104a0' +
  '575f80fd5b823567ffffffffffffffff8111156104b6575f80fd5b8301601f810185136104c6575f80fd5b80356104d4' +
  '6103b082610304565b8082825260208201915060208360051b8501019250878311156104f5575f80fd5b602084015b83' +
  '81101561053657803567ffffffffffffffff811115610518575f80fd5b6105278a602083890101610327565b84525060' +
  '2092830192016104fa565b509450505050602083013567ffffffffffffffff811115610555575f80fd5b610561858286' +
  '01610393565b9150509250929050565b5f81518084528060208401602086015e5f602082860101526020601f19601f83' +
  '011685010191505092915050565b61ffff84168152606060208201525f6105b5606083018561056b565b828103604084' +
  '015280845180835260208301915060208160051b840101602087015f5b8381101561063157601f198684030185528151' +
  '8051604085526105fe604086018261056b565b9050602082015191508481036020860152610619818361056b565b6020' +
  '97880197909550939093019250506001016105d8565b50909998505050505050505050565b602081525f610652602083' +
  '018461056b565b9392505050565b634e487b7160e01b5f52603260045260245ffd5b634e487b7160e01b5f5260116004' +
  '5260245ffd5b818103818111156106945761069461066d565b92915050565b808201808211156106945761069461066d' +
  '56'

/** EIP-170 caps deployed code at 24,576 bytes; one is the 0x00 marker. */
export const MAX_DATA_BYTES = 24_575

/**
 * Glamsterdam's code size limit is 64 KiB (EIP-7954), but wallets still refuse initcode over the
 * EIP-3860 limit of 49,152 bytes, so a slice is held to that: the initcode is the 12-byte prefix,
 * the 0x00 marker and the slice.
 */
export const GLAMSTERDAM_MAX_DATA_BYTES = 49_152 - 13

/** Glamsterdam data contract: base and gas per data byte, measured on Sepolia (see dataContractGas). */
const GLAMSTERDAM_CREATE_BASE = 212_151n
const GLAMSTERDAM_CODE_BYTE = 1_559n

/** At most half a block per slice, so it is included without waiting for an empty block. */
const BLOCK_SHARE = 2n

/**
 * Bytes of the file per data contract. Before Glamsterdam, the EIP-170 limit. After it, code is state
 * gas, outside the 2^24 per-transaction cap (EIP-8037), so a slice is bounded by the code size limit
 * and by a share of the chain's block gas limit. With no block limit known, by the 2^24 execution cap,
 * which every chain accepts.
 */
export function maxDataBytes(schedule: GasSchedule, blockGasLimit: bigint | null): number {
  if (schedule === 'prague') return MAX_DATA_BYTES
  const budget = blockGasLimit === null ? 16_777_216n : blockGasLimit / BLOCK_SHARE
  // The inverse of dataContractGas: base + per byte, plus 10%.
  const bytes = ((budget * 10n) / 11n - GLAMSTERDAM_CREATE_BASE) / GLAMSTERDAM_CODE_BYTE
  const cap = BigInt(GLAMSTERDAM_MAX_DATA_BYTES)
  return Number(bytes < 1n ? 1n : bytes > cap ? cap : bytes)
}

/** Initcode that deploys `0x00 ++ data` as a contract's runtime code. */
export function dataContractInitcode(data: Uint8Array): Uint8Array {
  if (data.length > GLAMSTERDAM_MAX_DATA_BYTES) throw new Error('data slice exceeds the contract size limit')
  const runtimeLen = data.length + 1
  // PUSH2 len · DUP1 · PUSH1 12 · PUSH1 0 · CODECOPY · PUSH1 0 · RETURN   (12 bytes), then the runtime code.
  const prefix = [0x61, runtimeLen >> 8, runtimeLen & 0xff, 0x80, 0x60, 0x0c, 0x60, 0x00, 0x39, 0x60, 0x00, 0xf3]
  const out = new Uint8Array(prefix.length + runtimeLen)
  out.set(prefix, 0)
  out[prefix.length] = 0x00
  out.set(data, prefix.length + 1)
  return out
}

/** Initcode for the serving contract, pointing at the given data contracts in order. */
export function siteInitcode(chunkAddresses: string[]): string {
  const args = AbiCoder.defaultAbiCoder().encode(['address[]'], [chunkAddresses])
  return SITE_CREATION_CODE + args.slice(2)
}

/** Split a file into data-contract slices. */
export function splitIntoDataContracts(
  data: Uint8Array, schedule: GasSchedule, blockGasLimit: bigint | null,
): Uint8Array[] {
  const size = maxDataBytes(schedule, blockGasLimit)
  const slices: Uint8Array[] = []
  for (let i = 0; i < data.length; i += size) slices.push(data.subarray(i, i + size))
  return slices.length ? slices : [new Uint8Array(0)]
}

// Gas for a contract-creation tx before Glamsterdam: base + creation + calldata + code deposit
// (200/byte) + execution slack, with a margin so a slightly different client estimate never leaves the
// tx short. The limit is only a ceiling; unused gas is not charged.
function pragueCreateGas(initcode: Uint8Array, depositBytes: number, extra: bigint): bigint {
  let zeros = 0n, nonzeros = 0n
  for (const b of initcode) { if (b === 0) zeros++; else nonzeros++ }
  const calldataGas = zeros * 4n + nonzeros * 16n
  const floorGas = 21000n + (zeros + nonzeros * 4n) * 10n
  const standard = 21000n + 32000n + calldataGas + BigInt(depositBytes) * 200n
    + 2n * BigInt(Math.ceil(initcode.length / 32)) + extra       // EIP-3860 initcode word cost
  const base = standard > floorGas ? standard : floorGas
  return base + base / 10n + 30000n
}

// Glamsterdam (EIP-8037 state-creation pricing), measured on Sepolia with eth_estimateGas: a data
// contract costs about 212,151 + 1,559 per data byte, the serving contract about 2,993,180 + 111,642
// per chunk (a new storage slot each). A 10% margin covers small differences between clients.
const withMargin = (gas: bigint): bigint => gas + gas / 10n

export function dataContractGas(initcode: Uint8Array, dataLen: number, schedule: GasSchedule): bigint {
  if (schedule === 'glamsterdam') return withMargin(GLAMSTERDAM_CREATE_BASE + GLAMSTERDAM_CODE_BYTE * BigInt(dataLen))
  return pragueCreateGas(initcode, dataLen + 1, 20_000n)
}

/** Gas for the serving contract; `chunkCount` storage slots are written (cold SSTORE each) plus the length. */
export function siteContractGas(initcode: Uint8Array, chunkCount: number, schedule: GasSchedule): bigint {
  if (schedule === 'glamsterdam') return withMargin(2_993_180n + 111_642n * BigInt(chunkCount))
  const runtime = (SITE_CREATION_CODE.length - 2) / 2        // upper bound on the deployed code size
  return pragueCreateGas(initcode, runtime, BigInt(chunkCount + 1) * 22_100n + 20_000n)
}
