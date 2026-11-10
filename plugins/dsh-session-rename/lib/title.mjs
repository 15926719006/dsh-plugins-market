/**
 * Title composition for the devops prefix feature.
 *
 * A devops-prefixed title is `"<number> <platform title>｜<summary>"`. The
 * platform title is kept when it fits, the summary always gets a minimum share,
 * and the whole string never exceeds the title service's byte budget. When the
 * budget is too small for the full prefix, the compressed `"<number>｜<summary>"`
 * form is used so the number and the outcome survive, and when even that does
 * not fit the prefix alone is returned.
 *
 * Pure functions only; the Host route reads the budget and calls them.
 */

/** The separator between the devops prefix and the model summary. */
export const DEVOPS_TITLE_SEPARATOR = '｜'

/** The least room a summary gets, in UTF-8 bytes (four CJK characters). */
export const MIN_SUMMARY_BYTES = 12

/** Default title budget when the live title service cannot be read. */
export const DEFAULT_TITLE_BYTES = 240

/**
 * System instruction for the devops-prefixed path: only the short summary is
 * requested because the number and platform title are added by the Host.
 */
export const DEVOPS_SUMMARY_PROMPT = [
  'Read the conversation between the human user and the assistant, then write a very short summary of what this session actually did or produced.',
  'A devops record number and its own title are already added as a prefix by the host, so return ONLY the summary part: never repeat the number, the platform title, or any prefix.',
  'Return only the summary on a single line: no quotes, no numbering, no explanation, no Markdown, no line breaks.',
  'Use the language of the conversation.',
  'Aim for about 12 CJK characters, or about 6 words in other languages.',
  'If the conversation is too sparse, return the shortest reasonable phrase describing the outcome.',
].join('\n')

/** UTF-8 size of one string. */
function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

/** Cut one string to a UTF-8 byte budget without splitting a code point. */
function truncateUtf8(text, maxBytes) {
  if (utf8Bytes(text) <= maxBytes) return text
  let used = 0
  let output = ''
  for (const character of text) {
    const size = utf8Bytes(character)
    if (used + size > maxBytes) break
    output += character
    used += size
  }
  return output
}

/** Collapse a platform title or model answer to one trimmed line. */
function oneLine(value) {
  return String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Compose the final title from a devops record and the model summary.
 * @param {object} input - the pieces.
 * @param {unknown} input.number - the platform record number, e.g. `RO-20261027-008`.
 * @param {unknown} input.platformTitle - the platform's own title.
 * @param {unknown} input.summary - the model's short summary (may be empty).
 * @param {number} [input.maxBytes] - the title service's byte budget.
 * @returns {string} the composed title, or an empty string without a number.
 */
export function composeDevopsTitle({ number, platformTitle, summary, maxBytes = DEFAULT_TITLE_BYTES }) {
  const num = oneLine(number)
  if (num.length === 0) return ''
  const title = oneLine(platformTitle)
  const text = oneLine(summary)
  const budget = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_TITLE_BYTES
  const separator = DEVOPS_TITLE_SEPARATOR
  const separatorBytes = utf8Bytes(separator)

  let prefix = title.length === 0 ? num : `${num} ${title}`
  const minSummaryBytes = Math.min(MIN_SUMMARY_BYTES, utf8Bytes(text))
  const reserved = text.length === 0 ? 0 : separatorBytes + minSummaryBytes
  const prefixBudget = Math.max(utf8Bytes(num), budget - reserved)
  if (utf8Bytes(prefix) > prefixBudget) {
    // Keep the number whole; shorten the platform title around it.
    const titleRoom = prefixBudget - utf8Bytes(num) - 1
    prefix = titleRoom > 0 ? `${num} ${truncateUtf8(title, titleRoom)}`.trimEnd() : num
  }

  if (text.length === 0) return prefix

  const summaryRoom = budget - utf8Bytes(prefix) - separatorBytes
  if (summaryRoom < MIN_SUMMARY_BYTES) {
    // No room for the full prefix and a usable summary: keep number + summary.
    const compressedRoom = budget - utf8Bytes(num) - separatorBytes
    if (compressedRoom >= MIN_SUMMARY_BYTES) {
      return `${num}${separator}${truncateUtf8(text, compressedRoom).trimEnd()}`
    }
    return prefix
  }
  return `${prefix}${separator}${truncateUtf8(text, summaryRoom).trimEnd()}`
}
