/**
 * Build an npm-pack-shaped `.tgz` for one installed plugin directory.
 *
 * npm tarballs put every file under a `package/` directory; pnpm accepts such a
 * local tarball with `pnpm add file:<path>.tgz`, which is exactly what the
 * Plugin Manager's "Add plugin" flow runs for an absolute `.tgz` path. Only Node
 * built-ins are used, so the profile gains no dependency.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const BLOCK = 512

/** Entries that never belong in a shareable plugin archive. */
const EXCLUDED = new Set(['node_modules', '.git', '.hg', '.svn', '.DS_Store'])

/** Raised when a directory is too large to export in one buffered archive. */
export class ExportLimitError extends Error {
  /**
   * @param message - which limit was hit.
   */
  constructor(message) {
    super(message)
    this.name = 'ExportLimitError'
    this.code = 'EEXPORTLIMIT'
  }
}

/**
 * Encode an octal tar header field: zero-padded digits followed by a NUL byte.
 * @param value - non-negative integer.
 * @param width - complete field width in bytes.
 * @returns the width-byte ASCII field.
 */
function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`
}

/**
 * Split an archive path into the ustar `name` and `prefix` fields.
 * @param archivePath - slash-separated path inside the archive.
 * @returns the two fields, or throws when the path cannot be represented.
 */
function splitPath(archivePath) {
  if (Buffer.byteLength(archivePath) <= 100) return { name: archivePath, prefix: '' }
  for (let index = archivePath.length - 1; index > 0; index -= 1) {
    if (archivePath[index] !== '/') continue
    const prefix = archivePath.slice(0, index)
    const name = archivePath.slice(index + 1)
    if (Buffer.byteLength(name) <= 100 && Buffer.byteLength(prefix) <= 155) return { name, prefix }
  }
  throw new Error(`archive path too long for ustar: ${archivePath}`)
}

/**
 * Build one 512-byte ustar header block.
 * @param entry - path, size, mode, typeflag and modification time.
 * @returns the header block.
 */
function tarHeader(entry) {
  const block = Buffer.alloc(BLOCK)
  const { name, prefix } = splitPath(entry.path)
  block.write(name, 0, 100, 'utf8')
  block.write(octal(entry.mode, 8), 100, 8, 'ascii')
  block.write(octal(0, 8), 108, 8, 'ascii')
  block.write(octal(0, 8), 116, 8, 'ascii')
  block.write(octal(entry.size, 12), 124, 12, 'ascii')
  block.write(octal(entry.mtime, 12), 136, 12, 'ascii')
  block.write('        ', 148, 8, 'ascii')
  block.write(entry.type, 156, 1, 'ascii')
  block.write('ustar', 257, 5, 'ascii')
  block.write('00', 263, 2, 'ascii')
  block.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${octal(sum, 7)} `, 148, 8, 'ascii')
  return block
}

/**
 * Build the shareable archive for one plugin package.
 * @param rootDir - absolute package directory to read.
 * @param options - optional note file and safety limits.
 * @param options.note - extra text written to `package/EXPORT-NOTE.md`.
 * @param options.maxBytes - uncompressed byte ceiling (default 64 MiB).
 * @param options.maxFiles - entry-count ceiling (default 4000).
 * @returns the gzipped tarball bytes.
 * @throws {ExportLimitError} when the directory exceeds a limit.
 */
export function buildPackageArchive(rootDir, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
  const maxFiles = options.maxFiles ?? 4000
  const mtime = Math.floor(Date.now() / 1000)
  const chunks = []
  let total = 0
  let count = 0

  /** Append one already-built chunk and enforce the byte ceiling. */
  const push = (chunk) => {
    total += chunk.byteLength
    if (total > maxBytes) {
      throw new ExportLimitError(`plugin directory exceeds the ${maxBytes} byte export limit`)
    }
    chunks.push(chunk)
  }

  /** Append one directory entry (name keeps its trailing slash). */
  const addDirectory = (path) => {
    push(tarHeader({ path, size: 0, mode: 0o755, mtime, type: '5' }))
  }

  /** Append one file entry plus its zero padding. */
  const addFile = (path, content) => {
    push(tarHeader({ path, size: content.byteLength, mode: 0o644, mtime, type: '0' }))
    push(content)
    const pad = (BLOCK - (content.byteLength % BLOCK)) % BLOCK
    if (pad > 0) push(Buffer.alloc(pad))
  }

  /** Recursively archive one directory. */
  const walk = (dir, prefix) => {
    for (const entryName of readdirSync(dir).sort()) {
      if (EXCLUDED.has(entryName)) continue
      const full = join(dir, entryName)
      const archivePath = `${prefix}${entryName}`
      const linkStat = lstatSync(full)
      if (linkStat.isSymbolicLink()) {
        const target = statSync(full)
        if (!target.isFile()) continue
        count += 1
        if (count > maxFiles) throw new ExportLimitError(`plugin directory exceeds the ${maxFiles} entry export limit`)
        addFile(archivePath, readFileSync(full))
        continue
      }
      if (linkStat.isDirectory()) {
        count += 1
        if (count > maxFiles) throw new ExportLimitError(`plugin directory exceeds the ${maxFiles} entry export limit`)
        addDirectory(`${archivePath}/`)
        walk(full, `${archivePath}/`)
        continue
      }
      if (!linkStat.isFile()) continue
      count += 1
      if (count > maxFiles) throw new ExportLimitError(`plugin directory exceeds the ${maxFiles} entry export limit`)
      addFile(archivePath, readFileSync(full))
    }
  }

  addDirectory('package/')
  walk(rootDir, 'package/')
  const note = typeof options.note === 'string' && options.note.length > 0 ? options.note : undefined
  if (note !== undefined) addFile('package/EXPORT-NOTE.md', Buffer.from(note, 'utf8'))
  push(Buffer.alloc(BLOCK))
  push(Buffer.alloc(BLOCK))
  return gzipSync(Buffer.concat(chunks, total), { level: 9 })
}

/**
 * Browser-safe archive file name for one package.
 * @param packageName - package name, scoped or not.
 * @param version - package version when known.
 * @returns `name-version.tgz` with every unsafe character replaced.
 */
export function archiveFileName(packageName, version) {
  const bare = packageName.replace(/^@[^/]+\//, '')
  const slug = `${bare}-${version ?? '0.0.0'}`.replace(/[^A-Za-z0-9._-]/g, '-')
  return `${slug}.tgz`
}
