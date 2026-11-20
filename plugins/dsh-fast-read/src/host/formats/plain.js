/**
 * Plain text, Markdown and pasted content share one parser: the text is already
 * the content, so only chapter splitting applies.
 */

import { ParseError, PARSE_CODES } from '../lib/errors.js'
import { tidyText } from '../lib/text.js'
import { splitChapters } from './split.js'

/**
 * Parse plain text into chapters.
 * @param {string} text - the raw text.
 * @param {string} [title] - a title to use when the text has none.
 * @returns {{ title: string, author: string, chapters: { title: string, text: string }[] }}
 * @throws {ParseError} `empty` when no readable text remains.
 */
export function parsePlain(text, title) {
  const cleaned = tidyText(text)
  if (cleaned.length < 20) throw new ParseError(PARSE_CODES.empty, '这段文本太短，没有可读的内容')
  const chapters = splitChapters(cleaned)
  if (chapters.length === 0) throw new ParseError(PARSE_CODES.empty, '这段文本切不出章节')
  return { title: title?.trim() || '粘贴的文本', author: '', chapters }
}
