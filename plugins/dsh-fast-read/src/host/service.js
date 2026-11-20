/**
 * The Host service behind the four tools.
 *
 * It owns the only two things the model cannot be trusted to do: parse a file
 * into chapters, and decide whether a claimed sentence really exists in the
 * book. Everything else is bookkeeping on disk.
 */

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { PARSE_CODES, ParseError } from './lib/errors.js'
import { applyEdges, applyMindmap, applyNodes } from './lib/validate.js'
import { bookIdOf, charCount, sha256, tidyText } from './lib/text.js'
import {
  bookPaths,
  ensureDir,
  listBooks,
  readJson,
  readText,
  writeIndex,
  writeJson,
  writeText,
} from './lib/store.js'
import { parseDocx } from './formats/docx.js'
import { parseEpub } from './formats/epub.js'
import { parsePlain } from './formats/plain.js'
import { PROTOCOL } from './protocol.js'

/** Formats the importer accepts, by file extension. */
const BY_EXTENSION = {
  '.epub': 'epub',
  '.pdf': 'pdf',
  '.txt': 'text',
  '.md': 'text',
  '.markdown': 'text',
  '.html': 'html',
  '.htm': 'html',
  '.docx': 'docx',
}

/** Formats people ask for that this version refuses, with a next step. */
const REFUSED = {
  '.mobi': 'MOBI 暂不支持，请先用 Calibre 或在线工具转成 EPUB',
  '.azw3': 'AZW3 暂不支持，请先转成 EPUB',
  '.azw': 'AZW 暂不支持，请先转成 EPUB',
  '.djvu': 'DjVu 暂不支持，请先转成 PDF 或 EPUB',
}

/** Characters a model is asked to handle per extraction unit. */
export const EXTRACTION_WINDOW = 6000

/**
 * The FastRead service.
 */
export class FastRead {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
   */
  constructor(ctx) {
    this.ctx = ctx
  }

  /**
   * Import a book file or pasted text.
   * @param {string} root - the workspace root.
   * @param {{ path?: string, text?: string, title?: string, author?: string }} input - what to import.
   * @returns {Promise<any>} the import summary.
   */
  async importBook(root, input) {
    const source = await this.readSource(input)
    const bookId = bookIdOf(source.title, `${source.path ?? ''}:${source.sha256}`)
    const paths = bookPaths(root, bookId)

    const existing = await readJson(paths.meta, undefined)
    if (existing !== undefined && existing.source?.sha256 === source.sha256) {
      return this.describeBook(root, existing, { reused: true })
    }

    await ensureDir(`${paths.dir}/chapters`)
    const uploaded = []
    for (const chapter of source.chapters) {
      const index = uploaded.length + 1
      uploaded.push({
        index,
        title: chapter.title,
        file: `chapters/${String(index).padStart(4, '0')}.txt`,
        chars: charCount(chapter.text),
      })
      await writeText(paths.chapter(index), chapter.text)
    }

    const meta = {
      schemaVersion: 1,
      bookId,
      title: source.title,
      author: source.author || input.author || '',
      source: {
        kind: source.kind,
        path: source.path ?? '',
        bytes: source.bytes,
        sha256: source.sha256,
        parsedAt: new Date().toISOString(),
        ...(source.pages === undefined ? {} : { pages: source.pages, ocrPages: source.ocrPages }),
      },
      chapters: uploaded,
      progress: {
        imported: true,
        extractedChapters: [],
        nodes: 0,
        edges: 0,
        guide: false,
        mindmap: false,
        updatedAt: new Date().toISOString(),
      },
    }
    await writeJson(paths.meta, meta)
    await writeJson(paths.graph, { schemaVersion: 1, nodes: [], edges: [], updatedAt: meta.progress.updatedAt })
    await writeIndex(root)
    return this.describeBook(root, meta)
  }

  /**
   * Read one window of a chapter.
   * @param {string} root - the workspace root.
   * @param {string} bookId - the book.
   * @param {number} chapter - the chapter number.
   * @param {number} [offset] - first character.
   * @param {number} [limit] - window size in characters.
   * @returns {Promise<any>} the window and how to continue.
   */
  async readChapter(root, bookId, chapter, offset = 0, limit = 8000) {
    const paths = bookPaths(root, bookId)
    const meta = await readJson(paths.meta, undefined)
    if (meta === undefined) throw new ParseError(PARSE_CODES.empty, `找不到书 ${bookId}，先用 book_import 导入`)
    const entry = (meta.chapters ?? []).find((item) => item.index === Number(chapter))
    if (entry === undefined) throw new ParseError(PARSE_CODES.empty, `《${meta.title}》没有第 ${chapter} 章`)
    const text = (await readText(paths.chapter(entry.index))) ?? ''
    const start = Math.max(0, Math.min(text.length, Math.trunc(offset)))
    const end = Math.min(text.length, start + Math.max(200, Math.trunc(limit)))
    return {
      bookId,
      chapter: entry.index,
      title: entry.title,
      text: text.slice(start, end),
      total: text.length,
      offset: start,
      nextOffset: end >= text.length ? null : end,
    }
  }

  /**
   * Persist one validated piece of the extraction.
   * @param {string} root - the workspace root.
   * @param {string} bookId - the book.
   * @param {string} kind - `nodes`, `edges`, `chapter-summary`, `guide` or `mindmap`.
   * @param {any} payload - the model's contribution.
   * @returns {Promise<any>} what was accepted and what was rejected.
   */
  async record(root, bookId, kind, payload) {
    const paths = bookPaths(root, bookId)
    const meta = await readJson(paths.meta, undefined)
    if (meta === undefined) throw new ParseError(PARSE_CODES.empty, `找不到书 ${bookId}`)
    const chapters = await this.chaptersOf(root, meta)
    const graph = await readJson(paths.graph, { schemaVersion: 1, nodes: [], edges: [] })

    let nextGraph = graph
    let issues = []
    let accepted = 0

    if (kind === 'nodes') {
      const items = Array.isArray(payload) ? payload : payload?.nodes ?? []
      if (items.length === 0) issues = [{ code: 'empty-payload', message: 'nodes 为空：payload 要写成 { "nodes": [ … ] }' }]
      const result = applyNodes(graph, chapters, items)
      nextGraph = result.graph
      issues = result.issues
      accepted = result.accepted
      await writeJson(paths.graph, nextGraph)
    } else if (kind === 'edges') {
      const items = Array.isArray(payload) ? payload : payload?.edges ?? []
      if (items.length === 0) issues = [{ code: 'empty-payload', message: 'edges 为空：payload 要写成 { "edges": [ … ] }' }]
      const result = applyEdges(graph, chapters, items)
      nextGraph = result.graph
      issues = result.issues
      accepted = result.accepted
      await writeJson(paths.graph, nextGraph)
    } else if (kind === 'chapter-summary') {
      const chapter = Number(payload?.chapter)
      const summary = tidyText(payload?.summary ?? '')
      if (!Number.isInteger(chapter) || summary.length < 8) {
        issues = [{ code: 'bad-summary', message: '章节摘要需要 chapter 与至少 8 字的 summary' }]
      } else {
        const summaries = await readJson(paths.summaries, { schemaVersion: 1, byChapter: {} })
        summaries.byChapter[String(chapter)] = summary
        await writeJson(paths.summaries, summaries)
        accepted = 1
      }
    } else if (kind === 'guide') {
      const markdown = tidyText(typeof payload === 'string' ? payload : payload?.markdown ?? '')
      const nodeNames = (nextGraph.nodes ?? []).map((node) => node.name)
      const mentioned = nodeNames.filter((name) => markdown.includes(name)).length
      if (markdown.length < 200) {
        issues = [{ code: 'guide-too-short', message: '导读至少 200 字' }]
      } else if (mentioned < 2) {
        issues = [{ code: 'guide-detached', message: '导读没有提到书里的概念，先把节点抽出来再写导读' }]
      } else {
        await writeText(paths.guide, markdown)
        accepted = 1
      }
    } else if (kind === 'mindmap') {
      const result = applyMindmap(payload, nextGraph)
      issues = result.issues
      await writeJson(paths.mindmap, result.mindmap)
      accepted = 1
    } else {
      throw new ParseError(PARSE_CODES.unsupported, `未知的 kind: ${kind}`)
    }

    if (kind === 'nodes' || kind === 'edges') {
      meta.progress.nodes = (nextGraph.nodes ?? []).length
      meta.progress.edges = (nextGraph.edges ?? []).length
    }
    if (kind === 'guide' && accepted > 0) meta.progress.guide = true
    if (kind === 'mindmap' && accepted > 0) meta.progress.mindmap = true
    if (kind === 'chapter-summary' && accepted > 0) {
      const chapter = Number(payload.chapter)
      const list = new Set(meta.progress.extractedChapters ?? [])
      list.add(chapter)
      meta.progress.extractedChapters = [...list].sort((a, b) => a - b)
    }
    meta.progress.updatedAt = new Date().toISOString()
    await writeJson(paths.meta, meta)
    await writeIndex(root)

    return {
      kind,
      accepted,
      issues,
      counts: { nodes: (nextGraph.nodes ?? []).length, edges: (nextGraph.edges ?? []).length },
      progress: meta.progress,
    }
  }

  /**
   * The library, or one book, with what to do next.
   * @param {string} root - the workspace root.
   * @param {string} [bookId] - limit to one book.
   * @param {string} [action] - `books` (default) or `protocol`.
   * @returns {Promise<any>} state and next steps.
   */
  async state(root, bookId, action) {
    if (action === 'protocol') {
      return { action: 'protocol', books: await this.state(root).then((state) => state.books), protocol: PROTOCOL, nextSteps: ['按协议对第 1 章执行 book_read → book_record'] }
    }
    const all = await listBooks(root)
    const books = all
      .filter((entry) => bookId === undefined || entry.bookId === bookId)
      .map((entry) => this.summarize(entry))
    if (books.length === 0) {
      return {
        books: [],
        nextSteps: ['还没有书。先调用 book_import，参数给书籍的绝对路径（EPUB/PDF/TXT/DOCX）或直接给 text。'],
      }
    }
    return { books, nextSteps: books[0].nextSteps }
  }

  /**
   * Load every chapter's text for quote checking.
   * @param {string} root - the workspace root.
   * @param {any} meta - the book's metadata.
   * @returns {Promise<{ index: number, text: string }[]>} chapters with text.
   */
  async chaptersOf(root, meta) {
    const paths = bookPaths(root, meta.bookId)
    const out = []
    for (const chapter of meta.chapters ?? []) {
      out.push({ index: chapter.index, text: (await readText(paths.chapter(chapter.index))) ?? '' })
    }
    return out
  }

  /**
   * Read the source bytes and parse them into chapters.
   * @param {{ path?: string, text?: string, title?: string, author?: string }} input - the request.
   * @returns {Promise<any>} a parsed source.
   */
  async readSource(input) {
    if (typeof input?.text === 'string' && input.text.trim().length > 0) {
      const parsed = parsePlain(input.text, input.title)
      const bytes = Buffer.from(input.text, 'utf8')
      return { ...parsed, kind: 'paste', bytes: bytes.length, sha256: sha256(bytes), path: '' }
    }
    const path = String(input?.path ?? '').trim()
    if (path.length === 0) throw new ParseError(PARSE_CODES.unsupported, '请给 path（书籍文件）或 text（直接粘贴的正文）')
    const extension = extname(path).toLowerCase()
    if (REFUSED[extension] !== undefined) throw new ParseError(PARSE_CODES.unsupported, REFUSED[extension])
    const format = BY_EXTENSION[extension]
    if (format === undefined) throw new ParseError(PARSE_CODES.unsupported, `不支持的格式 ${extension || '（无扩展名）'}；支持 EPUB / PDF / TXT / MD / HTML / DOCX`)

    let bytes
    try {
      bytes = await readFile(path)
    } catch (error) {
      throw new ParseError(PARSE_CODES.corrupt, `读不到这个文件：${path}`, error)
    }

    let parsed
    if (format === 'epub') parsed = parseEpub(bytes)
    else if (format === 'docx') parsed = parseDocx(bytes)
    else if (format === 'pdf') {
      const { parsePdf } = await import('./formats/pdf.js')
      parsed = await parsePdf(path, bytes)
    } else {
      const { stripHtml } = await import('./lib/text.js')
      const text = format === 'html' ? stripHtml(bytes.toString('utf8')) : bytes.toString('utf8')
      parsed = parsePlain(text, input.title)
    }
    return {
      ...parsed,
      path,
      kind: format,
      bytes: bytes.length,
      sha256: sha256(bytes),
      pages: parsed.pages,
      ocrPages: parsed.ocrPages,
    }
  }

  /**
   * The public shape of one imported book.
   * @param {string} root - the workspace root.
   * @param {any} meta - its metadata.
   * @param {{ reused?: boolean }} [options] - extra facts.
   * @returns {any} the import summary.
   */
  describeBook(root, meta, options = {}) {
    const totalChars = (meta.chapters ?? []).reduce((sum, chapter) => sum + (chapter.chars ?? 0), 0)
    const calls = (meta.chapters ?? []).length + 2
    return {
      bookId: meta.bookId,
      title: meta.title,
      author: meta.author,
      chapters: (meta.chapters ?? []).map((chapter) => ({ index: chapter.index, title: chapter.title, chars: chapter.chars })),
      estimate: {
        units: (meta.chapters ?? []).length,
        calls,
        chars: totalChars,
        note: `约 ${calls} 次模型调用（${(meta.chapters ?? []).length} 章 + 导读/脑图）；正文 ${Math.round(totalChars / 1000)}k 字`,
      },
      ...(options.reused === true ? { reused: true } : {}),
      root,
    }
  }

  /**
   * One line of the library list.
   * @param {{ bookId: string, meta: any }} entry - a book on disk.
   * @returns {any} its progress and next step.
   */
  summarize(entry) {
    const { meta } = entry
    const total = (meta.chapters ?? []).length
    const done = new Set(meta.progress?.extractedChapters ?? []).size
    const missing = (meta.chapters ?? []).map((chapter) => chapter.index).filter((index) => !(meta.progress?.extractedChapters ?? []).includes(index))
    const nextChapter = missing[0]
    const nextSteps = []
    if (nextChapter !== undefined) nextSteps.push(`读第 ${nextChapter} 章：book_read({ bookId: '${entry.bookId}', chapter: ${nextChapter} })`)
    if (nextChapter === undefined && meta.progress?.guide !== true) nextSteps.push('章节都抽完了，写导读：book_record({ kind: \'guide\' })')
    if (nextChapter === undefined && meta.progress?.mindmap !== true) nextSteps.push('写脑图：book_record({ kind: \'mindmap\' })')
    if (nextSteps.length === 0) nextSteps.push('这本书已经完成，右侧栏「速读」页可以直接看')
    return {
      bookId: entry.bookId,
      title: meta.title,
      author: meta.author,
      chapters: total,
      done,
      nodes: meta.progress?.nodes ?? 0,
      edges: meta.progress?.edges ?? 0,
      guide: meta.progress?.guide === true,
      mindmap: meta.progress?.mindmap === true,
      nextSteps,
    }
  }
}
