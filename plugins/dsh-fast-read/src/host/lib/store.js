/**
 * The library on disk.
 *
 * Everything the plugin knows lives under `<workspace>/.dsh-books/`: one
 * directory per book, chapter text kept verbatim because quotes are checked
 * against it, and JSON files that a person can read, diff and hand-edit.
 * Writes are atomic (temp file then rename) so an interrupted extraction never
 * leaves a half-written graph behind.
 */

import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Directory name that holds the whole library. */
export const LIBRARY_DIR = '.dsh-books'

/**
 * Where a book's files live.
 * @param {string} root - the workspace root.
 * @param {string} bookId - the book id.
 * @returns {{ dir: string, meta: string, graph: string, guide: string, mindmap: string, summaries: string, chapter: (index: number) => string }}
 *   every path the service needs.
 */
export function bookPaths(root, bookId) {
  const dir = join(root, LIBRARY_DIR, bookId)
  return {
    dir,
    meta: join(dir, 'meta.json'),
    graph: join(dir, 'graph.json'),
    guide: join(dir, 'guide.md'),
    mindmap: join(dir, 'mindmap.json'),
    summaries: join(dir, 'summaries.json'),
    chapter: (index) => join(dir, 'chapters', `${String(index).padStart(4, '0')}.txt`),
  }
}

/**
 * Path of the library index.
 * @param {string} root - the workspace root.
 * @returns {string} the index path.
 */
export function indexPath(root) {
  return join(root, LIBRARY_DIR, 'index.json')
}

/**
 * Create a directory if it does not exist.
 * @param {string} dir - the directory.
 * @returns {Promise<void>} resolves once it exists.
 */
export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
}

/**
 * Read a JSON file, returning a fallback when it is absent or unreadable.
 * @template T
 * @param {string} file - the path.
 * @param {T} fallback - the value to use when there is nothing to read.
 * @returns {Promise<T>} the parsed value or the fallback.
 */
export async function readJson(file, fallback) {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/**
 * Write a JSON file atomically.
 * @param {string} file - the path.
 * @param {unknown} value - the value.
 * @returns {Promise<void>} resolves once written.
 */
export async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(temp, file)
}

/**
 * Read a UTF-8 text file, or `undefined` when it does not exist.
 * @param {string} file - the path.
 * @returns {Promise<string | undefined>} its contents.
 */
export async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Write a UTF-8 text file atomically.
 * @param {string} file - the path.
 * @param {string} text - the contents.
 * @returns {Promise<void>} resolves once written.
 */
export async function writeText(file, text) {
  const temp = `${file}.${process.pid}.tmp`
  await writeFile(temp, text, 'utf8')
  await rename(temp, file)
}

/**
 * Every book currently in the library, newest first.
 * @param {string} root - the workspace root.
 * @returns {Promise<{ bookId: string, meta: any }[]>} books with their metadata.
 */
export async function listBooks(root) {
  const dir = join(root, LIBRARY_DIR)
  let names
  try {
    names = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const books = []
  for (const entry of names) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const meta = await readJson(bookPaths(root, entry.name).meta, undefined)
    if (meta === undefined) continue
    books.push({ bookId: entry.name, meta })
  }
  books.sort((a, b) => String(b.meta.progress?.updatedAt ?? '').localeCompare(String(a.meta.progress?.updatedAt ?? '')))
  return books
}

/**
 * Rewrite the library index from the books on disk.
 * @param {string} root - the workspace root.
 * @returns {Promise<void>} resolves once the index is current.
 */
export async function writeIndex(root) {
  const books = await listBooks(root)
  const index = {
    schemaVersion: 1,
    books: books.map(({ bookId, meta }) => ({
      bookId,
      title: meta.title,
      author: meta.author,
      chapters: meta.chapters?.length ?? 0,
      nodes: meta.progress?.nodes ?? 0,
      edges: meta.progress?.edges ?? 0,
      guide: meta.progress?.guide === true,
      extracted: meta.progress?.extractedChapters?.length ?? 0,
      updatedAt: meta.progress?.updatedAt ?? '',
    })),
  }
  await writeJson(indexPath(root), index)
}
