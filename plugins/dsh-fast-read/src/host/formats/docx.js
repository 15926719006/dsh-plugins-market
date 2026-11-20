/**
 * DOCX parsing: read `word/document.xml`, start a chapter at a Heading 1 or 2
 * paragraph, and keep every other paragraph as body text.
 */

import { corrupt, ParseError, PARSE_CODES } from '../lib/errors.js'
import { stripHtml, tidyText } from '../lib/text.js'
import { readZip } from '../lib/zip.js'
import { normalizeChapters } from './split.js'

/** Paragraph styles Word and LibreOffice use for chapter titles. */
const HEADING_STYLE = /^(Heading|heading|标题)\s*[12]$/

/**
 * Parse a DOCX file.
 * @param {Uint8Array} bytes - the file contents.
 * @returns {{ title: string, author: string, chapters: { title: string, text: string }[] }}
 * @throws {ParseError} `corrupt` or `empty`.
 */
export function parseDocx(bytes) {
  let entries
  try {
    entries = readZip(bytes)
  } catch (error) {
    throw corrupt(error, 'DOCX')
  }
  const raw = entries.get('word/document.xml')
  if (raw === undefined) throw new ParseError(PARSE_CODES.corrupt, 'DOCX 缺少 word/document.xml')
  const xml = Buffer.from(raw).toString('utf8')

  const chapters = []
  let title = ''
  let body = []
  const flush = () => {
    const text = tidyText(body.join('\n'))
    if (text.length > 0 || title.length > 0) chapters.push({ title, text })
    title = ''
    body = []
  }

  for (const match of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)) {
    const paragraph = match[1]
    const text = paragraphText(paragraph)
    if (text.length === 0) continue
    const style = /<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(paragraph)?.[1] ?? ''
    if (HEADING_STYLE.test(style)) {
      flush()
      title = text
      continue
    }
    body.push(text)
  }
  flush()

  const read = chapters.filter((chapter) => chapter.text.length > 0)
  if (read.length === 0) throw new ParseError(PARSE_CODES.empty, 'DOCX 没有可读的正文')
  return { title: read[0].title || '未命名文档', author: '', chapters: normalizeChapters(read) }
}

/**
 * Text of one Word paragraph.
 * @param {string} paragraph - the paragraph XML.
 * @returns {string} its text with line breaks preserved.
 */
function paragraphText(paragraph) {
  const withBreaks = paragraph.replace(/<w:br\s*\/>/g, '\n').replace(/<w:tab\s*\/>/g, '\t')
  const runs = [...withBreaks.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((match) => match[1])
  return tidyText(stripHtml(runs.join('')).replace(/\n{2,}/g, '\n'))
}
