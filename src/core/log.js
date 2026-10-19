// Session-log geometry, pure and host-free: generation names, zstd frame
// scanning, and first-frame header rewriting.
//
// The host appends one zstd frame per durable batch and keeps the header in the
// FIRST frame, which is exactly one line of JSON. Rewriting the header therefore
// means: decompress frame 1, patch it, recompress it, and keep every following
// byte untouched. Never re-encode the rest: those frames are history.

import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { promisify } from 'node:util'

const compress = promisify(zstdCompress)
const decompress = promisify(zstdDecompress)

const ZSTD_MAGIC = 0xfd2fb528
/** The host's own writer sets the frame checksum; keep it so our frames look like its frames. */
const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
/**
 * Canonical generation stem, applied AFTER stripping the compression suffix.
 * '.' + 'v0', zero-padded numbers, and an upper-case 'V' are NOT canonical:
 * the host ignores such files, so we must too.
 */
const CANONICAL_STEM = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/
const PLAIN_SUFFIX = '.jsonl'
const ZSTD_SUFFIX = '.zstd'

/** Physical suffix for one artifact encoding. */
export function generationSuffix(compression) {
  return compression === 'zstd' ? ZSTD_SUFFIX : ''
}

/** Format version of one canonical generation filename, or undefined. */
export function parseGenerationName(name, compression = 'zstd') {
  const suffix = generationSuffix(compression)
  if (!name.endsWith(suffix)) return undefined
  const stem = name.slice(0, name.length - suffix.length)
  const match = CANONICAL_STEM.exec(stem)
  if (match === null) return undefined
  return match[1] === undefined ? 0 : Number(match[1])
}

/** Generation names among dir entries, newest first. */
export function pickGenerations(names, compression = 'zstd') {
  const out = []
  for (const name of names) {
    if (!name.endsWith(PLAIN_SUFFIX + generationSuffix(compression))) continue
    const version = parseGenerationName(name, compression)
    if (version === undefined) continue
    out.push({ name, version })
  }
  return out.sort((a, b) => b.version - a.version)
}

/**
 * Structurally scan complete zstd frames (concatenated-frame container).
 * Throws on a corrupt header or reserved block type; a torn tail is simply not
 * reported as a frame, which lets callers keep those bytes verbatim.
 */
export function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error('corrupt zstd session log: invalid frame magic at byte ' + offset)
    }
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error('corrupt zstd session log: reserved frame-header bit at byte ' + (offset - 1))
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) throw new Error('corrupt zstd session log: reserved block type')
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames, tornStart: -1 }
}

/**
 * Decode the first frame into the session header.
 * The host requires that frame to be exactly one line ending in '\n'.
 */
export async function readHeaderFrame(frameBytes) {
  const text = (await decompress(frameBytes)).toString('utf8')
  if (text.length === 0 || text.charCodeAt(text.length - 1) !== 0x0a) {
    throw new Error('corrupt zstd session log: first frame is not exactly one header line')
  }
  if (text.indexOf('\n') !== text.length - 1) {
    throw new Error('corrupt zstd session log: first frame holds more than one line')
  }
  const header = JSON.parse(text)
  if (header === null || typeof header !== 'object' || Array.isArray(header)) {
    throw new Error('corrupt zstd session log: header is not an object')
  }
  return header
}

/**
 * Rewrite the header's cwd, returning a NEW buffer: a recompressed first frame
 * plus every trailing byte untouched (including a torn tail, if any).
 * The caller owns durability (atomic write + fsync) — this function is pure.
 */
export async function patchHeaderCwd(buffer, newCwd) {
  const { frames } = scanZstdFrames(buffer)
  if (frames.length === 0) throw new Error('session log holds no complete zstd frame')
  const first = buffer.subarray(frames[0].start, frames[0].end)
  const header = await readHeaderFrame(first)
  const patched = Object.assign({}, header, { cwd: newCwd })
  const line = JSON.stringify(patched) + '\n'
  const newFirst = await compress(line, CHECKSUM)
  return {
    header: patched,
    previous: header,
    buffer: Buffer.concat([newFirst, buffer.subarray(frames[0].end)]),
  }
}
