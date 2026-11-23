/**
 * EPUB parsing: container → OPF → spine order → plain text per document.
 *
 * Nothing here renders a book. It reads the reading order the book itself
 * declares, strips markup, and hands chapters to the shared normaliser so a
 * 300 KB EPUB and a pasted essay obey the same size rules.
 */

import { corrupt, ParseError, PARSE_CODES } from '../lib/errors.js'
import { stripHtml, tidyText } from '../lib/text.js'
import { readZip } from '../lib/zip.js'
import { isHeading, normalizeChapters } from './split.js'

/** Front and back matter that carries no knowledge worth a model call. */
const DROP_PATTERN = /^(封面|书名页|版权页|目录|注释|参考文献|Table of Contents)$|图书在版编目|CIP数据/

/**
 * Parse an EPUB file.
 * @param {Uint8Array} bytes - the file contents.
 * @returns {{ title: string, author: string, chapters: { title: string, text: string }[] }}
 * @throws {ParseError} `encrypted`, `corrupt` or `empty`.
 */
export function parseEpub(bytes) {
  let entries
  try {
    entries = readZip(bytes)
  } catch (error) {
    if (error?.code === 'encrypted') {
      throw new ParseError(PARSE_CODES.encrypted, '这本 EPUB 的条目是加密的，请换一份非加密的 EPUB', error)
    }
    throw corrupt(error, 'EPUB')
  }
  assertNoDrm(entries)

  const container = readEntryText(entries, 'META-INF/container.xml')
  if (container === undefined) throw new ParseError(PARSE_CODES.corrupt, 'EPUB 缺少 META-INF/container.xml')
  const rootfile = firstAttributes(container, 'rootfile')['full-path']
  if (rootfile === undefined) throw new ParseError(PARSE_CODES.corrupt, 'EPUB 的 container.xml 里没有 rootfile')
  const opfText = readEntryText(entries, rootfile)
  if (opfText === undefined) throw new ParseError(PARSE_CODES.corrupt, `EPUB 里找不到 ${rootfile}`)

  const base = directoryOf(rootfile)
  const title = metadataValue(opfText, 'dc:title') || '未命名'
  const author = metadataValue(opfText, 'dc:creator')

  const manifest = new Map()
  for (const tag of allTags(opfText, 'item')) {
    const attrs = attributesOf(tag)
    if (attrs.id !== undefined && attrs.href !== undefined) {
      manifest.set(attrs.id, { href: attrs.href, type: attrs['media-type'] ?? '' })
    }
  }

  const chapters = []
  for (const tag of allTags(opfText, 'itemref')) {
    const attrs = attributesOf(tag)
    const idref = attrs.idref
    if (idref === undefined) continue
    if (attrs.linear === 'no') continue
    const item = manifest.get(idref)
    if (item === undefined || !isTextDocument(item.type, item.href)) continue
    const path = resolvePath(base, item.href)
    const html = readEntryText(entries, path)
    if (html === undefined) continue
    const text = stripHtml(html)
    if (text.length < 60 || isTocDocument(text)) continue
    const { heading, body } = peelHeading(text, title)
    if (body.length < 60) continue
    if (heading !== undefined && DROP_PATTERN.test(heading) && body.length < 1500) continue
    chapters.push({ title: heading ?? '', text: body })
  }

  if (chapters.length === 0) throw new ParseError(PARSE_CODES.empty, 'EPUB 没有可读的正文')
  return { title, author, chapters: normalizeChapters(chapters) }
}

/**
 * Refuse DRM-protected books with a sentence a person can act on.
 * @param {Map<string, Uint8Array>} entries - archive entries.
 */
function assertNoDrm(entries) {
  const text = readEntryText(entries, 'META-INF/encryption.xml')
  if (text === undefined) return
  const algorithms = [...text.matchAll(/Algorithm\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1])
  // Font obfuscation (IDPF embedding or Adobe's font algorithm) is not DRM.
  const fontOnly = algorithms.length > 0 && algorithms.every((algorithm) => /embedding|font/i.test(algorithm))
  if (fontOnly) return
  if (algorithms.length > 0 || /<EncryptedData\b/i.test(text)) {
    throw new ParseError(PARSE_CODES.encrypted, '这本 EPUB 有 DRM 保护，请换一份非加密的 EPUB')
  }
}

/**
 * Read one archive entry as UTF-8 text.
 * @param {Map<string, Uint8Array>} entries - archive entries.
 * @param {string} path - the entry path.
 * @returns {string | undefined} the text, or undefined when absent.
 */
function readEntryText(entries, path) {
  const direct = entries.get(path)
  if (direct !== undefined) return Buffer.from(direct).toString('utf8')
  let decoded
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return undefined
  }
  const raw = entries.get(decoded)
  if (raw === undefined) return undefined
  return Buffer.from(raw).toString('utf8')
}

/**
 * Every opening tag with a given name.
 * @param {string} xml - the document.
 * @param {string} tagName - the tag name.
 * @returns {string[]} the matched tags.
 */
function allTags(xml, tagName) {
  const pattern = new RegExp(`<${tagName}\\b[^>]*?/?>`, 'g')
  return xml.match(pattern) ?? []
}

/**
 * Attributes of one tag as a plain object.
 * @param {string} tag - the tag text.
 * @returns {Record<string, string>} attribute values.
 */
function attributesOf(tag) {
  /** @type {Record<string, string>} */
  const out = {}
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[match[1]] = match[2]
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*'([^']*)'/g)) out[match[1]] = match[2]
  return out
}

/**
 * Attributes of the first tag with a given name.
 * @param {string} xml - the document.
 * @param {string} tagName - the tag name.
 * @returns {Record<string, string>} attribute values, empty when not found.
 */
function firstAttributes(xml, tagName) {
  const tag = allTags(xml, tagName)[0]
  return tag === undefined ? {} : attributesOf(tag)
}

/**
 * Read one Dublin Core metadata field.
 * @param {string} opf - the OPF document.
 * @param {string} name - the element name.
 * @returns {string} the text, or an empty string.
 */
function metadataValue(opf, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i')
  const match = pattern.exec(opf)
  return match === null ? '' : tidyText(stripHtml(match[1]))
}

/**
 * Whether a manifest item is an XHTML document.
 * @param {string} type - the media type.
 * @param {string} href - the file name.
 * @returns {boolean} true for text documents.
 */
function isTextDocument(type, href) {
  return /xhtml|html|xml/i.test(type) || /\.x?html?$/i.test(href)
}

/**
 * Directory part of an archive path.
 * @param {string} path - the path.
 * @returns {string} the directory, with a trailing slash, or an empty string.
 */
function directoryOf(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index + 1)
}

/**
 * Resolve a relative href against the OPF's directory.
 * @param {string} base - the directory part.
 * @param {string} href - the relative href.
 * @returns {string} the archive path.
 */
function resolvePath(base, href) {
  const clean = href.split('#')[0]
  if (clean.startsWith('/')) return clean.slice(1)
  const parts = `${base}${clean}`.split('/')
  const out = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

/**
 * A table-of-contents document: mostly short heading lines, little prose.
 * @param {string} text - the document text.
 * @returns {boolean} true when the document is a table of contents.
 */
function isTocDocument(text) {
  const lines = text.split('\n').filter((line) => line.trim().length > 0)
  if (lines.length < 6) return false
  const headings = lines.filter((line) => isHeading(line)).length
  return headings / lines.length > 0.6 && text.length < 3000
}

/**
 * Separate a document's own heading from its body.
 *
 * EPUB documents often repeat the book title at the top; that line is not a
 * chapter heading and is dropped instead of becoming one.
 *
 * @param {string} text - the stripped document.
 * @param {string} bookTitle - the book's title.
 * @returns {{ heading: string | undefined, body: string }} the split.
 */
function peelHeading(text, bookTitle) {
  const lines = text.split('\n')
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  if (lines.length === 0) return { heading: undefined, body: '' }
  const first = lines[0].trim()
  if (first === bookTitle || first.replace(/\s+/g, '') === bookTitle.replace(/\s+/g, '')) {
    lines.shift()
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  }
  const next = lines[0]?.trim() ?? ''
  if (isHeading(next)) {
    lines.shift()
    while (lines.length > 0 && lines[0].trim() === '') lines.shift()
    return { heading: next, body: tidyText(lines.join('\n')) }
  }
  return { heading: undefined, body: tidyText(lines.join('\n')) }
}
