/**
 * PDF parsing: compile the bundled Swift helper once, run it per book, then
 * clean up the page stream into chapters.
 *
 * The helper does the platform-specific work (PDFKit text layer, Vision OCR),
 * so this file only has to be good at two things: caching the binary, and
 * turning noisy page text into paragraphs worth extracting.
 */

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { ParseError, PARSE_CODES } from '../lib/errors.js'
import { tidyText } from '../lib/text.js'
import { isHeading, splitChapters } from './split.js'

const run = promisify(execFile)

/** Where this package's own files live. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** The Swift source, shipped with the package. */
export const SWIFT_SOURCE = join(HERE, '..', '..', '..', 'bin', 'pdftext.swift')

/**
 * Parse a PDF file.
 * @param {string} path - the PDF path.
 * @param {Uint8Array} bytes - its bytes, already read by the caller.
 * @returns {Promise<{ title: string, author: string, chapters: { title: string, text: string }[], pages: number, ocrPages: number }>}
 *   the book, plus how many pages needed OCR.
 */
export async function parsePdf(path, bytes) {
  if (bytes.length === 0) throw new ParseError(PARSE_CODES.empty, '这个 PDF 是空文件')
  const binary = await ensureBinary()
  let stdout
  try {
    const result = await run(binary, [path], { maxBuffer: 256 * 1024 * 1024 })
    stdout = result.stdout
  } catch (error) {
    if (error?.code === 4) {
      throw new ParseError(PARSE_CODES.encrypted, '这个 PDF 有密码保护，请先解除密码再导入', error)
    }
    const detail = error instanceof Error ? error.message : String(error)
    throw new ParseError(PARSE_CODES.corrupt, `PDF 解析失败：${detail.slice(0, 300)}`, error)
  }
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0)
  let title = ''
  let pages = 0
  let ocrPages = 0
  const pageTexts = []
  for (const line of lines) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type === 'meta') {
      title = String(record.title ?? '')
      pages = Number(record.pages ?? 0)
      continue
    }
    if (record.type === 'page') {
      if (record.ocr === true) ocrPages += 1
      pageTexts.push({ page: Number(record.page), text: String(record.text ?? ''), ocr: record.ocr === true })
    }
  }
  if (pageTexts.length === 0) throw new ParseError(PARSE_CODES.empty, '这个 PDF 没有可读的文字（也没有可用 OCR 的页面）')

  const body = assemble(pageTexts)
  if (body.length < 50) throw new ParseError(PARSE_CODES.empty, '这个 PDF 识别不出正文，可能是纯图片或被加密')
  const chapters = splitChapters(body)
  return {
    title: tidyText(title) || path.split('/').pop()?.replace(/\.pdf$/i, '') || '未命名 PDF',
    author: '',
    chapters: chapters.length > 0 ? chapters : [{ title: '全文', text: body }],
    pages,
    ocrPages,
  }
}

/**
 * Turn per-page text into one paragraph stream.
 *
 * Two cleanups matter more than they look: repeated headers and footers become
 * fake chapters if left in, and OCR hard-wraps every line, which would turn a
 * paragraph into twenty "paragraphs" and ruin quote matching.
 *
 * @param {{ page: number, text: string, ocr: boolean }[]} pages - page texts.
 * @returns {string} the assembled text.
 */
export function assemble(pages) {
  const cleaned = pages.map((page) => stripFurniture(page.text, page.ocr))
  const frequency = new Map()
  for (const text of cleaned) {
    for (const line of edgeLines(text)) {
      frequency.set(line, (frequency.get(line) ?? 0) + 1)
    }
  }
  const repeated = new Set([...frequency.entries()].filter(([, count]) => count >= Math.max(3, pages.length * 0.3)).map(([line]) => line))
  const blocks = []
  for (const text of cleaned) {
    const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
    const kept = lines.filter((line, index) => {
      const isEdge = index < 2 || index >= lines.length - 2
      if (!isEdge) return true
      if (repeated.has(line)) return false
      if (/^[-–—\s]*\d{1,4}[-–—\s]*$/.test(line)) return false
      return true
    })
    blocks.push(kept.join('\n'))
  }
  return joinParagraphs(blocks.join('\n'))
}

/**
 * Remove control characters and page-number-ish junk from one page.
 * @param {string} text - page text.
 * @param {boolean} ocr - whether it came from OCR.
 * @returns {string} cleaned text.
 */
function stripFurniture(text, ocr) {
  const lines = String(text ?? '')
    .replace(/\u0000/g, '')
    .split('\n')
    .map((line) => line.trim())
  if (ocr) {
    // OCR frequently keeps the page number on its own line.
    return lines.filter((line) => !/^\d{1,4}$/.test(line)).join('\n')
  }
  return lines.join('\n')
}

/**
 * First and last two lines of a page, the places running headers live.
 * @param {string} text - page text.
 * @returns {string[]} candidate furniture lines.
 */
function edgeLines(text) {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.length <= 3) return []
  return [lines[0], lines[1], lines[lines.length - 2], lines[lines.length - 1]].filter((line) => line.length > 0)
}

/**
 * Join hard-wrapped OCR lines back into paragraphs.
 *
 * A line that ends in sentence-ending punctuation stays its own paragraph; a
 * line that does not is a wrap and joins the next one.
 *
 * @param {string} text - the page stream.
 * @returns {string} paragraphs separated by single newlines.
 */
function joinParagraphs(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  const paragraphs = []
  let current = ''
  for (const line of lines) {
    if (current.length === 0) {
      current = line
    } else if (isHeading(current) || isHeading(line)) {
      paragraphs.push(current)
      current = line
    } else if (/[。！？!?…”』」】]$/.test(current) || /^[•·\-–—]/.test(line)) {
      paragraphs.push(current)
      current = line
    } else if (line.length < 12) {
      paragraphs.push(current)
      current = line
    } else {
      current += line
    }
  }
  if (current.length > 0) paragraphs.push(current)
  return tidyText(paragraphs.join('\n'))
}

/**
 * Compile the Swift helper on first use and reuse it afterwards.
 *
 * The cache lives inside the plugin's own directory so two books never race to
 * compile, and a source change forces one recompile.
 *
 * @returns {Promise<string>} the binary path.
 * @throws {ParseError} `no-swift` when the toolchain is missing.
 */
export async function ensureBinary() {
  const cacheDir = join(dirname(SWIFT_SOURCE), '..', '.cache')
  const binary = join(cacheDir, 'pdftext')
  try {
    await mkdir(cacheDir, { recursive: true })
  } catch {
    /* the compile error below is the useful one */
  }
  const fresh = existsSync(binary) && existsSync(SWIFT_SOURCE) && statSync(binary).mtimeMs > statSync(SWIFT_SOURCE).mtimeMs
  if (fresh) return binary

  try {
    await run('swiftc', ['-O', SWIFT_SOURCE, '-o', binary], { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 })
    return binary
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/command not found|ENOENT|xcrun|unable to find utility/i.test(detail)) {
      throw new ParseError(PARSE_CODES.noSwift, 'PDF 解析需要 Xcode 命令行工具（swiftc）。装好后再试，或先把 PDF 转成 EPUB', error)
    }
    throw new ParseError(PARSE_CODES.corrupt, `PDF 解析器编译失败：${detail.slice(0, 300)}`, error)
  }
}

/**
 * Read a PDF's first page as text, used by tests and quick checks.
 * @param {string} path - the PDF path.
 * @returns {Promise<string>} first-page text.
 */
export async function firstPageText(path) {
  const bytes = await readFile(path)
  const parsed = await parsePdf(path, bytes)
  return parsed.chapters[0]?.text ?? ''
}
