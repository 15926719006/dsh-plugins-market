/**
 * A minimal ZIP reader.
 *
 * EPUB and DOCX are ZIP containers, and the plugin ships with no runtime
 * dependencies, so this reads the central directory directly and inflates with
 * Node's own zlib. It supports the two methods real books use (stored and
 * deflate) and ignores anything else instead of pretending it worked.
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50

/**
 * Read every file in a ZIP archive.
 * @param {Uint8Array} bytes - the archive.
 * @returns {Map<string, Uint8Array>} entries keyed by their archive path.
 * @throws {Error} named `ZipError` when the archive is truncated or unreadable.
 */
export function readZip(bytes) {
  const buf = Buffer.from(bytes)
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd < 0) throw zipError('not a zip archive: no end-of-central-directory record')
  const count = buf.readUInt16LE(eocd + 10)
  const centralOffset = buf.readUInt32LE(eocd + 16)
  if (centralOffset <= 0 || centralOffset >= buf.length) throw zipError('not a zip archive: bad central directory offset')

  const entries = new Map()
  let cursor = centralOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw zipError('corrupt zip: bad central directory entry')
    }
    const method = buf.readUInt16LE(cursor + 10)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const uncompressedSize = buf.readUInt32LE(cursor + 24)
    const nameLength = buf.readUInt16LE(cursor + 28)
    const extraLength = buf.readUInt16LE(cursor + 30)
    const commentLength = buf.readUInt16LE(cursor + 32)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const flags = buf.readUInt16LE(cursor + 8)
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
      throw zipError('this archive is encrypted', 'encrypted')
    }
    const rawName = buf.subarray(cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength

    const names = decodeNames(rawName, flags)
    if (names.some((name) => name.endsWith('/'))) continue
    const data = readEntry(buf, localOffset, method, compressedSize, uncompressedSize)
    if (data === undefined) continue
    for (const name of names) entries.set(name.replace(/^\.\//, ''), data)
  }
  return entries
}

/**
 * Names one entry may be looked up by.
 *
 * Production tools often write UTF-8 names without setting the language flag,
 * so a strict UTF-8 read is tried first and the latin1 reading is kept as an
 * alias. Whichever spelling a document's href uses, the entry is found.
 *
 * @param {Buffer} bytes - the raw name bytes.
 * @param {number} flags - the general-purpose bit flags.
 * @returns {string[]} candidate names, best first.
 */
function decodeNames(bytes, flags) {
  const utf8 = tryDecode(bytes, 'utf8')
  const latin = bytes.toString('latin1')
  if ((flags & 0x800) !== 0) return utf8 === undefined ? [latin] : [utf8]
  if (utf8 === undefined) return [latin]
  return utf8 === latin ? [utf8] : [utf8, latin]
}

/**
 * Decode bytes as UTF-8, or report that they are not valid UTF-8.
 * @param {Buffer} bytes - the bytes.
 * @param {string} encoding - the encoding to try.
 * @returns {string | undefined} the text.
 */
function tryDecode(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
}

/**
 * Locate the end-of-central-directory record, scanning back over any comment.
 * @param {Buffer} buf - the archive.
 * @returns {number} its offset, or -1.
 */
function findEndOfCentralDirectory(buf) {
  const earliest = Math.max(0, buf.length - 65557)
  for (let offset = buf.length - 22; offset >= earliest; offset -= 1) {
    if (buf.readUInt32LE(offset) === EOCD_SIGNATURE) return offset
  }
  return -1
}

/**
 * Read and decompress one entry.
 * @param {Buffer} buf - the archive.
 * @param {number} localOffset - offset of the local file header.
 * @param {number} method - the compression method.
 * @param {number} compressedSize - size of the data in the archive.
 * @param {number} uncompressedSize - size after decompression.
 * @returns {Uint8Array | undefined} the entry, or undefined for unsupported methods.
 */
function readEntry(buf, localOffset, method, compressedSize, uncompressedSize) {
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
    throw zipError('corrupt zip: bad local file header')
  }
  const nameLength = buf.readUInt16LE(localOffset + 26)
  const extraLength = buf.readUInt16LE(localOffset + 28)
  const start = localOffset + 30 + nameLength + extraLength
  const end = start + compressedSize
  if (end > buf.length) throw zipError('corrupt zip: entry runs past the archive end')
  const raw = buf.subarray(start, end)
  if (method === 0) return new Uint8Array(raw)
  if (method === 8) {
    try {
      const inflated = inflateRawSync(raw)
      return new Uint8Array(inflated)
    } catch {
      throw zipError('corrupt zip: deflate stream failed')
    }
  }
  if (uncompressedSize === 0) return undefined
  return undefined
}

/**
 * Build one consistently shaped archive error.
 * @param {string} message - what went wrong.
 * @returns {Error} the error, named for callers that branch on it.
 */
function zipError(message, code) {
  const error = new Error(message)
  error.name = 'ZipError'
  if (code !== undefined) error.code = code
  return error
}
