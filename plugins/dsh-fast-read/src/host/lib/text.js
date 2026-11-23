/**
 * Text helpers shared by every parser and by the evidence checker.
 *
 * The one that matters for trust is {@link normalizeForMatch}: it makes a
 * comparison between a model's quote and the book's own text robust against
 * whitespace, full-width punctuation and case, without ever editing the text
 * that gets stored. Stored chapter text stays byte-for-byte what the book said.
 */

import { createHash } from 'node:crypto'

/**
 * Turn an XHTML/HTML fragment into plain text.
 *
 * Block-level tags become newlines so paragraphs survive; inline tags vanish.
 * Scripts, styles and comments are dropped before tag stripping so their
 * contents never leak into a chapter.
 *
 * @param {string} html - the markup.
 * @returns {string} plain text with single newlines between blocks.
 */
export function stripHtml(html) {
  let text = String(html ?? '')
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|pre|table)>/gi, '\n')
  text = text.replace(/<(p|div|h[1-6]|li|tr|blockquote|section|article|pre|table|ul|ol)\b[^>]*>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  return tidyText(text).replace(/\n{2,}/g, '\n')
}

/**
 * Decode the handful of entities a book realistically contains.
 * @param {string} text - text with entities.
 * @returns {string} text with entities replaced.
 */
function decodeEntities(text) {
  const named = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”',
    lsquo: '‘', rsquo: '’', middot: '·', bull: '•', copy: '©',
  }
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, key) => named[key.toLowerCase()] ?? match)
}

/**
 * Convert one numeric code point to a character, refusing nonsense.
 * @param {number} code - the code point.
 * @returns {string} one character or an empty string.
 */
function safeChar(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/**
 * Normalise whitespace and blank lines without changing any visible character.
 * @param {string} text - raw text.
 * @returns {string} text with `\n\n+` collapsed and trailing spaces removed.
 */
export function tidyText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** One character's comparison form: NFKC, unified quotes and dashes, ASCII-safe lowercase. */
export function normalizeChar(char) {
  const folded = char.normalize('NFKC')
  if (folded === '“' || folded === '”' || folded === '„' || folded === '‟') return '"'
  if (folded === '‘' || folded === '’' || folded === '‚' || folded === '‛') return "'"
  if (folded === '—' || folded === '–' || folded === '―' || folded === '－') return '-'
  if (folded === '…') return '.'
  if (folded.length === 1) {
    const lower = folded.toLowerCase()
    return lower.length === 1 ? lower : folded
  }
  return folded
}

/**
 * Normalise text for quote matching only.
 *
 * Removes every whitespace character, folds full-width forms through NFKC,
 * unifies quote and dash styles, and collapses runs of dashes and dots so a
 * book's `——` matches a quote's `—`, and `……` matches `...`. Never store the
 * result: it is a comparison key, not content.
 *
 * @param {string} text - the text to normalise.
 * @returns {string} the comparison key.
 */
export function normalizeForMatch(text) {
  return normalizeWithOffsets(String(text ?? '')).normalized
}

/**
 * Normalise text while remembering where each character came from.
 *
 * Multi-character expansions (an ellipsis, a ligature) and collapsed runs all
 * point back at the character that produced them, so an offset found in the
 * normalised text is still a real offset in the book.
 *
 * @param {string} text - the original text.
 * @returns {{ normalized: string, offsets: number[] }} the key and its offsets.
 */
export function normalizeWithOffsets(text) {
  const parts = []
  const offsets = []
  let lastDash = -1
  let dots = 0
  for (let index = 0; index < String(text ?? '').length; index += 1) {
    const char = text[index]
    if (/\s/.test(char)) continue
    const folded = normalizeChar(char)
    for (const piece of folded) {
      if (piece === '-') {
        if (lastDash >= 0) continue
        lastDash = index
        dots = 0
        parts.push('-')
        offsets.push(index)
        continue
      }
      lastDash = -1
      if (piece === '.') {
        if (dots >= 3) continue
        dots += 1
      } else {
        dots = 0
      }
      parts.push(piece)
      offsets.push(index)
    }
  }
  return { normalized: parts.join(''), offsets }
}

/**
 * A stable, filesystem-safe book id.
 *
 * The title contributes an ASCII slug when it has one; every title also
 * contributes a hash of the seed (source path plus content hash), so two books
 * with the same title stay apart and the same file imported twice lands in the
 * same directory.
 *
 * @param {string} title - the book title.
 * @param {string} seed - stable source identity (path + content hash).
 * @returns {string} the book id.
 */
export function bookIdOf(title, seed) {
  const ascii = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  const hash = createHash('sha256').update(String(seed)).digest('hex').slice(0, 8)
  return `${ascii.length >= 2 ? ascii : 'book'}-${hash}`
}

/**
 * SHA-256 of a buffer as lowercase hex.
 * @param {Uint8Array} bytes - the bytes.
 * @returns {string} the digest.
 */
export function sha256(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex')
}

/**
 * One-based line number of a character offset, for jumping to a quote.
 * @param {string} text - the chapter text.
 * @param {number} offset - the character offset.
 * @returns {number} the 1-based line number.
 */
export function lineOfOffset(text, offset) {
  const limit = Math.max(0, Math.min(text.length, offset))
  let line = 1
  for (let i = 0; i < limit; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

/**
 * Count characters, ignoring whitespace, for size estimates.
 * @param {string} text - the text.
 * @returns {number} the count of non-whitespace characters.
 */
export function charCount(text) {
  return normalizeForMatch(text).length
}
