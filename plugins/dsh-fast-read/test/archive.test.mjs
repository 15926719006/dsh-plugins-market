import assert from 'node:assert/strict'
import test from 'node:test'

import { readZip } from '../src/host/lib/zip.js'

/**
 * Build a stored-only zip with control over the flags and the raw name bytes.
 * @param {{ name: string, content: string, flags: number }} entry - one entry.
 * @returns {Uint8Array} the archive.
 */
function zipWith({ name, content, flags }) {
  const encoder = new TextEncoder()
  const nameBytes = flags & 0x800 ? Buffer.from(name, 'utf8') : Buffer.from(name, 'utf8')
  const data = Buffer.from(content, 'utf8')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(flags, 6)
  local.writeUInt16LE(0, 8)
  local.writeUInt32LE(0, 10)
  local.writeUInt32LE(0, 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(nameBytes.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(flags, 8)
  central.writeUInt16LE(0, 10)
  central.writeUInt32LE(0, 12)
  central.writeUInt32LE(0, 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(nameBytes.length, 28)
  central.writeUInt32LE(0, 42)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(46 + nameBytes.length, 12)
  end.writeUInt32LE(30 + nameBytes.length + data.length, 16)
  return new Uint8Array(Buffer.concat([local, nameBytes, data, central, nameBytes, end]))
}

test('names written as UTF-8 without the flag are still readable', () => {
  const entries = readZip(zipWith({ name: 'OEBPS/第一章.xhtml', content: '<p>正文</p>', flags: 0 }))
  assert.ok(entries.has('OEBPS/第一章.xhtml'), [...entries.keys()].join(','))
})

test('an encrypted entry is refused instead of read as text', () => {
  assert.throws(
    () => readZip(zipWith({ name: 'a.xml', content: 'ciphertext', flags: 0x1 })),
    (error) => error.name === 'ZipError' && error.code === 'encrypted',
  )
})
