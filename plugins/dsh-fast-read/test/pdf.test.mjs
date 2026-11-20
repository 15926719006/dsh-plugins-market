import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parsePdf } from '../src/host/formats/pdf.js'

const hasCups = existsSync('/usr/sbin/cupsfilter')

/**
 * Make a two-chapter Chinese PDF using the system print filter.
 * @returns {string | undefined} the path, or undefined when unavailable.
 */
function makePdf() {
  if (!hasCups) return undefined
  const dir = mkdtempSync(join(tmpdir(), 'fast-read-pdf-'))
  const source = join(dir, 'book.txt')
  const body = (label) => Array.from({ length: 30 }, (_, index) => `第${index + 1}段：${label}的内容，用来确认 PDF 文字层能被正确读取。`).join('\n')
  writeFileSync(source, `第一章 起点\n${body('第一章')}\n第二章 转折\n${body('第二章')}\n`, 'utf8')
  const pdf = join(dir, 'book.pdf')
  execFileSync('/usr/sbin/cupsfilter', ['-m', 'application/pdf', source], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 32 * 1024 * 1024 })
  const out = execFileSync('/usr/sbin/cupsfilter', ['-m', 'application/pdf', source], { maxBuffer: 32 * 1024 * 1024 })
  writeFileSync(pdf, out)
  return pdf
}

const pdfPath = makePdf()

test('parsePdf reads text-layer pages and splits chapters', { skip: pdfPath === undefined }, async () => {
  const book = await parsePdf(pdfPath, readFileSync(pdfPath))
  assert.equal(book.ocrPages, 0)
  assert.ok(book.pages >= 1)
  assert.ok(book.chapters.length >= 2, `only ${book.chapters.length} chapters`)
  assert.match(book.chapters[0].title, /第一章/)
  assert.match(book.chapters[0].text, /第1段/)
})

test('parsePdf refuses an empty file', async () => {
  await assert.rejects(() => parsePdf('empty.pdf', new Uint8Array()), /空文件/)
})
