import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { ParseError } from '../src/host/lib/errors.js'
import { parseEpub } from '../src/host/formats/epub.js'
import { charCount } from '../src/host/lib/text.js'
import { readZip } from '../src/host/lib/zip.js'

const BOOK = '/Users/maka.li/Downloads/乡下人的悲歌 (J.D. 万斯) (z-library.sk, 1lib.sk, z-lib.sk).epub'
const hasBook = existsSync(BOOK)

test('readZip reads an EPUB archive', () => {
  if (!hasBook) return
  const entries = readZip(readFileSync(BOOK))
  assert.ok(entries.has('META-INF/container.xml'))
  assert.ok(entries.has('content.opf'))
})

test('parseEpub recovers the book and its chapters', { skip: !hasBook }, () => {
  const book = parseEpub(readFileSync(BOOK))
  assert.equal(book.title, '乡下人的悲歌')
  assert.equal(book.author, 'J.D. 万斯')
  assert.ok(book.chapters.length >= 14, `only ${book.chapters.length} chapters`)
  const first = book.chapters[0]
  assert.ok(first.title.length > 0)
  const total = book.chapters.reduce((sum, chapter) => sum + chapter.text.length, 0)
  assert.ok(total > 140000 && total < 175000, `unexpected total ${total}`)
  // The contract is non-space characters; raw length also carries the newlines.
  assert.ok(book.chapters.every((chapter) => charCount(chapter.text) <= 6000))
  assert.ok(book.chapters.every((chapter) => chapter.text.length <= 7500))
  assert.ok(book.chapters.some((chapter) => chapter.text.includes('阿嬷')))
})

test('parseEpub refuses an archive with no container', () => {
  const emptyZip = makeStoredZip({ 'mimetype': 'application/epub+zip' })
  assert.throws(() => parseEpub(emptyZip), (error) => error instanceof ParseError && error.code === 'corrupt')
})

/**
 * Build a stored-only zip in memory, enough to prove the reader's error paths.
 * @param {Record<string, string>} files - name to content.
 * @returns {Uint8Array} the archive.
 */
function makeStoredZip(files) {
  const encoder = new TextEncoder()
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name)
    const data = encoder.encode(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(0, 10)
    local.writeUInt32LE(0, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt32LE(0, 12)
    central.writeUInt32LE(0, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes, data)
    centrals.push(central, nameBytes)
    offset += 30 + nameBytes.length + data.length
  }
  const centralOffset = offset
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  return new Uint8Array(Buffer.concat([...locals, ...centrals, end]))
}
