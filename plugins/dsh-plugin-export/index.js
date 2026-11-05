/**
 * Host half of `@local/dsh-plugin-export`: one authenticated download route that
 * packages an installed plugin bundle into a shareable npm-style `.tgz`.
 *
 * The route is addressed by package name. The package directory is resolved
 * through the Loader's own resolution bases, the same way the client-module
 * registry locates a package manifest, so linked, npm, git and built-in rows all
 * resolve without reading the profile's `package.json` directly.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { archiveFileName, buildPackageArchive, ExportLimitError } from './tar.js'

/** Cordis plugin name. */
export const name = 'plugin-export'

/** The Loader owns package resolution; the connection owns the authenticated route. */
export const inject = ['loader', 'connection']

/** Absolute pathname the Host registers the download under. */
export const PLUGIN_EXPORT_PATH = '/api/plugin.export'

/** Uncompressed size ceiling for one exported plugin. */
const MAX_BYTES = 64 * 1024 * 1024

/** Entry-count ceiling for one exported plugin. */
const MAX_FILES = 4000

/** Package names accepted from the client before resolution is attempted. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i

/**
 * Render one plain-text HTTP failure.
 * @param message - the diagnostic text.
 * @param status - HTTP status code.
 * @returns the response.
 */
function failure(message, status) {
  return new Response(`${message}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })
}

/**
 * Read one error's message.
 * @param error - the thrown value.
 * @returns its message.
 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Build a `require` anchored at one Loader resolution base.
 * @param anchor - a file URL, an absolute path, or a URL; directories are given a
 * placeholder file name so Node resolves relative to them.
 * @returns the anchored resolver, or undefined for an unusable anchor.
 */
function requireFrom(anchor) {
  try {
    let target
    if (anchor instanceof URL) target = anchor
    else if (typeof anchor !== 'string') return undefined
    else if (anchor.startsWith('file:')) target = new URL(anchor)
    else if (isAbsolute(anchor)) {
      const directory = existsSync(anchor) && statSync(anchor).isDirectory()
      target = pathToFileURL(directory ? join(anchor, '__resolve__.mjs') : anchor)
    } else target = new URL(anchor, 'file:///')
    return createRequire(target)
  } catch {
    return undefined
  }
}

/**
 * Walk up from one resolved module file until the manifest naming the package
 * appears.
 * @param file - absolute path of a module file inside the package.
 * @param packageName - exact package name to match.
 * @returns the package root, manifest and parsed manifest.
 */
function packageRootOf(file, packageName) {
  let current = existsSync(file) && statSync(file).isDirectory() ? file : dirname(file)
  for (;;) {
    const manifest = join(current, 'package.json')
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
        if (pkg.name === packageName) return { dir: current, manifest, pkg }
      } catch {
        // An unreadable ancestor manifest is not the package's own; keep walking.
      }
    }
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Resolve one installed plugin package to its directory.
 * @param ctx - Host context carrying the Loader.
 * @param packageName - exact package name.
 * @returns the located package, or undefined when no Loader base resolves it.
 */
export function locatePluginPackage(ctx, packageName) {
  const anchors = []
  try {
    for (const entry of ctx.loader.entries()) {
      const base = entry?.parent?.tree?.ctx?.baseUrl
      if (base !== undefined && base !== null) anchors.push(base)
    }
  } catch {
    // A Loader that cannot enumerate entries still leaves the context base below.
  }
  if (ctx.baseUrl !== undefined && ctx.baseUrl !== null) anchors.push(ctx.baseUrl)
  anchors.push(import.meta.url)
  const seen = new Set()
  for (const anchor of anchors) {
    const resolver = requireFrom(anchor)
    if (resolver === undefined) continue
    const key = String(anchor)
    if (seen.has(key)) continue
    seen.add(key)
    for (const specifier of [`${packageName}/package.json`, packageName]) {
      let resolved
      try {
        resolved = resolver.resolve(specifier)
      } catch {
        continue
      }
      const located = packageRootOf(resolved, packageName)
      if (located !== undefined) return located
    }
  }
  return undefined
}

/**
 * The Chinese text written into `package/EXPORT-NOTE.md` so the recipient never
 * needs a repeated explanation of what the file is or how to install it.
 * @param pkg - the exported package's manifest.
 * @param fileName - archive file name.
 * @returns the note body.
 */
function sharingNote(pkg, fileName) {
  const label = pkg.version === undefined ? pkg.name : `${pkg.name}@${pkg.version}`
  const description = typeof pkg.description === 'string' && pkg.description.trim() !== '' ? pkg.description.trim() : '—'
  return `# 插件分享说明

这个文件由 DSH 的「导出插件」功能生成，是一个标准 npm tarball（解压后为 \`package/\` 目录）。

- 插件包：\`${label}\`
- 插件简介：${description}
- 安装：打开 DSH，点击左侧的「插件」，再点「添加插件」，粘贴这个 \`.tgz\` 文件的绝对路径（例如 \`~/Downloads/${fileName}\`）。
- 另一种装法：解压后，把 \`package\` 目录的绝对路径粘贴进去。
- 插件启用后立即生效；取消启用或移除该插件即可回滚。
`
}

/** The route handler installed on the Host's authenticated fetch carrier. */
export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined) {
    ctx.logger?.warn?.('plugin-export: connection service unavailable; export route not registered')
    return
  }
  ctx.effect(() => connection.fetch.register({
    path: PLUGIN_EXPORT_PATH,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const url = new URL(request.url)
      const requested = url.searchParams.get('name')
      if (requested === null || requested.trim() === '') return failure('missing "name" query parameter', 400)
      const packageName = requested.trim()
      if (packageName.length > 300 || !PACKAGE_NAME.test(packageName)) return failure(`invalid package name: ${packageName}`, 400)
      let located
      try {
        located = locatePluginPackage(ctx, packageName)
      } catch (error) {
        ctx.logger?.warn?.('plugin-export: cannot resolve %s: %s', packageName, messageOf(error))
        return failure(`cannot resolve plugin package ${packageName}: ${messageOf(error)}`, 500)
      }
      if (located === undefined) return failure(`plugin package not found among installed plugins: ${packageName}`, 404)
      const declared = located.pkg.dsh?.bundle
      if (declared === undefined || declared === null || declared === false) {
        return failure(`${packageName} declares no dsh.bundle patch, so it is not a shareable plugin bundle`, 400)
      }
      const version = typeof located.pkg.version === 'string' ? located.pkg.version : undefined
      const fileName = archiveFileName(packageName, version)
      let body
      try {
        let root = located.dir
        try {
          root = realpathSync(root)
        } catch {
          // An archive-backed (app.asar) package has no host path to realpath.
        }
        body = buildPackageArchive(root, {
          maxBytes: MAX_BYTES,
          maxFiles: MAX_FILES,
          note: sharingNote(located.pkg, fileName),
        })
      } catch (error) {
        const limit = error instanceof ExportLimitError
        ctx.logger?.warn?.('plugin-export: cannot archive %s: %s', packageName, messageOf(error))
        return failure(`cannot archive ${packageName}: ${messageOf(error)}`, limit ? 413 : 500)
      }
      const headers = {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${fileName}"`,
        'content-length': String(body.byteLength),
      }
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
      return new Response(body, { status: 200, headers })
    },
  }), 'plugin-export: download route')
}
