/**
 * Turn a book's plain text into chapters.
 *
 * Splitting is a heuristic by nature, but two rules are not negotiable because
 * everything downstream depends on them: a chapter is never longer than the
 * extraction window a model can handle, and no text is ever dropped while
 * splitting. Merging short front matter into its neighbour is allowed to lose
 * the boundary, never the words.
 */

import { charCount, tidyText } from '../lib/text.js'

/** Lines that start a new chapter in Chinese and English books. */
const HEADING_PATTERNS = [
  /^第[零一二三四五六七八九十百千两\d]{1,6}[章回节篇卷部]/,
  /^chapter\s+[0-9ivxlcdm]+/i,
  /^(引言|前言|序言|序|楔子|开篇|尾声|结语|后记|致谢|注释|附录|参考文献|目录|版权页|书名页)$/,
  /^[一二三四五六七八九十]{1,3}[、.]\s*\S{1,30}$/,
]

/**
 * Whether one line looks like a chapter heading.
 * @param {string} line - one trimmed line.
 * @returns {boolean} true when it should start a chapter.
 */
export function isHeading(line) {
  const value = String(line ?? '').trim()
  if (value.length === 0 || value.length > 40) return false
  if (/[。！？!?]$/.test(value)) return false
  return HEADING_PATTERNS.some((pattern) => pattern.test(value))
}

/**
 * Split one book's text into chapters of at most `targetMax` characters.
 *
 * @param {string} text - the book text, one paragraph per line.
 * @param {object} [options] - tuning knobs.
 * @param {number} [options.targetMax] - largest allowed chapter, in non-space characters.
 * @param {number} [options.minChars] - chapters below this size merge into the previous one.
 * @returns {{ title: string, text: string }[]} chapters in reading order.
 */
export function splitChapters(text, options = {}) {
  const targetMax = options.targetMax ?? 6000
  const minChars = options.minChars ?? 800
  const value = tidyText(text)
  if (value.length === 0) return []

  const lines = value.split('\n')
  /** @type {{ title: string, text: string }[]} */
  const rough = []
  let title = ''
  let body = []

  const flush = () => {
    const content = tidyText(body.join('\n'))
    if (content.length > 0) rough.push({ title: title || defaultTitle(rough.length), text: content })
    title = ''
    body = []
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line.length === 0) {
      body.push('')
      continue
    }
    if (isHeading(line) && charCount(body.join('\n')) >= Math.min(minChars, 200)) {
      flush()
      title = line
      continue
    }
    if (title === '') {
      // A heading-looking line while collecting front matter becomes the title
      // of the first chapter only when it is followed by real text.
      if (isHeading(line)) {
        title = line
        continue
      }
    }
    body.push(line)
  }
  flush()

  const merged = mergeShort(rough, minChars)
  return splitLong(merged, targetMax)
}

/**
 * Give an unnamed first chapter a neutral name.
 * @param {number} index - the chapter's position.
 * @returns {string} a title.
 */
function defaultTitle(index) {
  return index === 0 ? '开篇' : `第 ${index + 1} 部分`
}

/**
 * Merge chapters below the minimum size into their predecessor.
 * @param {{ title: string, text: string }[]} chapters - the rough split.
 * @param {number} minChars - the threshold.
 * @returns {{ title: string, text: string }[]} merged chapters.
 */
function mergeShort(chapters, minChars) {
  /** @type {{ title: string, text: string }[]} */
  const out = []
  for (const chapter of chapters) {
    const previous = out[out.length - 1]
    if (previous !== undefined && charCount(chapter.text) < minChars) {
      previous.text = `${previous.text}\n\n${chapter.text}`
      continue
    }
    out.push({ ...chapter })
  }
  if (out.length === 0) return out
  // Short front matter that became the first chapter merges forward instead.
  while (out.length > 1 && charCount(out[0].text) < minChars) {
    const first = out.shift()
    out[0].text = `${first.text}\n\n${out[0].text}`
  }
  return out
}

/**
 * Split chapters that exceed the extraction window at line boundaries.
 * @param {{ title: string, text: string }[]} chapters - chapters to split.
 * @param {number} targetMax - the largest chapter size.
 * @returns {{ title: string, text: string }[]} chapters that fit.
 */
function splitLong(chapters, targetMax) {
  /** @type {{ title: string, text: string }[]} */
  const out = []
  for (const chapter of chapters) {
    if (charCount(chapter.text) <= targetMax) {
      out.push(chapter)
      continue
    }
    const parts = []
    let current = []
    let size = 0
    for (const line of chapter.text.split('\n')) {
      for (const piece of cutLine(line, targetMax)) {
        const pieceSize = charCount(piece)
        if (size > 0 && size + pieceSize > targetMax) {
          parts.push(current.join('\n'))
          current = []
          size = 0
        }
        current.push(piece)
        size += pieceSize
      }
    }
    if (current.length > 0) parts.push(current.join('\n'))
    parts.forEach((part, index) => {
      out.push({
        title: index === 0 ? chapter.title : `${chapter.title}（续 ${index + 1}）`,
        text: tidyText(part),
      })
    })
  }
  return out
}

/**
 * Cut one line so that no piece exceeds the window.
 *
 * A book with no paragraph breaks (scanned OCR, a pasted essay) would otherwise
 * produce one chapter far above the extraction window, which breaks the call
 * estimate and makes every quote check walk the whole book. Sentences are tried
 * first; a sentence that is still too long is cut by characters.
 *
 * @param {string} line - one line of text.
 * @param {number} targetMax - the largest allowed size in non-space characters.
 * @returns {string[]} pieces that fit.
 */
function cutLine(line, targetMax) {
  if (charCount(line) <= targetMax) return [line]
  const sentences = line.split(/(?<=[。！？；!?;])/u).filter((part) => part.length > 0)
  const pieces = []
  let current = ''
  const flush = () => {
    if (current.length > 0) pieces.push(current)
    current = ''
  }
  for (const sentence of sentences) {
    if (charCount(sentence) > targetMax) {
      flush()
      const step = Math.max(1, targetMax)
      for (let index = 0; index < sentence.length; index += step) pieces.push(sentence.slice(index, index + step))
      continue
    }
    if (charCount(current) + charCount(sentence) > targetMax) flush()
    current += sentence
  }
  flush()
  return pieces
}

/**
 * Re-split chapters that a container format already separated (EPUB spine,
 * DOCX heading runs) so they obey the same size rules as everything else.
 * @param {{ title: string, text: string }[]} chapters - parser output.
 * @param {number} [targetMax] - largest allowed chapter.
 * @returns {{ title: string, text: string }[]} normalised chapters.
 */
export function normalizeChapters(chapters, targetMax = 6000) {
  const cleaned = chapters
    .map((chapter) => ({ title: String(chapter.title ?? '').trim(), text: tidyText(chapter.text) }))
    .filter((chapter) => charCount(chapter.text) > 0)
    .map((chapter, index) => ({ ...chapter, title: chapter.title || defaultTitle(index) }))
  return splitLong(mergeShort(cleaned, 800), targetMax)
}
