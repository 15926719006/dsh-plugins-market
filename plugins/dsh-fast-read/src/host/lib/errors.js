/**
 * One error type for everything a book file can do wrong.
 *
 * Callers branch on `code`, never on the message: the tool turns each code into
 * a repair instruction the model can pass on to the person ("this EPUB is
 * DRM-protected, export a non-DRM copy").
 */

/** Codes a parser may report. */
export const PARSE_CODES = Object.freeze({
  corrupt: 'corrupt',
  encrypted: 'encrypted',
  empty: 'empty',
  unsupported: 'unsupported',
  noSwift: 'no-swift',
  ocrFailed: 'ocr-failed',
})

/**
 * A parse failure with a stable code.
 */
export class ParseError extends Error {
  /**
   * @param {string} code - one of {@link PARSE_CODES}.
   * @param {string} message - what a person can act on.
   * @param {unknown} [cause] - the underlying failure.
   */
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ParseError'
    this.code = code
  }
}

/**
 * Wrap an unknown failure as a corrupt-file parse error.
 * @param {unknown} error - whatever was thrown.
 * @param {string} what - the format that failed.
 * @returns {ParseError} the wrapped error.
 */
export function corrupt(error, what) {
  const detail = error instanceof Error ? error.message : String(error)
  return new ParseError(PARSE_CODES.corrupt, `${what} 文件损坏或无法解析：${detail}`, error)
}
