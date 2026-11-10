/**
 * Unit checks for the Host half: package resolution through Loader bases and the
 * download route handler, driven without the composed Host.
 * Run with `node test/route.test.mjs`.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply, locatePluginPackage, PLUGIN_EXPORT_PATH } from '../index.js'
import { archiveFileName } from '../tar.js'

const profileDir = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const baseUrl = pathToFileURL(`${profileDir}/`).href

/** Minimal Host context: Loader bases, a captured connection route, and a logger. */
function fakeContext() {
  const captured = {}
  const ctx = {
    baseUrl,
    logger: { warn() {} },
    loader: {
      entries: () => [{ parent: { tree: { ctx: { baseUrl } } } }],
    },
    get(service) {
      if (service !== 'connection') return undefined
      return {
        fetch: {
          register(route) {
            captured.route = route
            return () => {}
          },
        },
      }
    },
    effect(callback) {
      return callback()
    },
  }
  return { ctx, captured }
}

const located = locatePluginPackage(fakeContext().ctx, '@local/dsh-pinned-top')
assert.ok(located !== undefined, 'resolves an installed linked package')
assert.equal(located.pkg.name, '@local/dsh-pinned-top')
assert.equal(locatePluginPackage(fakeContext().ctx, '@local/not-installed'), undefined)

const { ctx, captured } = fakeContext()
apply(ctx)
assert.equal(captured.route.path, PLUGIN_EXPORT_PATH)
assert.deepEqual(captured.route.methods, ['GET', 'HEAD'])

const head = await captured.route.fetch(new Request(`http://localhost${PLUGIN_EXPORT_PATH}?name=${encodeURIComponent('@local/dsh-pinned-top')}`, { method: 'HEAD' }))
assert.equal(head.status, 200)
assert.equal(head.headers.get('content-disposition'), `attachment; filename="${archiveFileName('@local/dsh-pinned-top', located.pkg.version)}"`)
assert.equal(head.headers.get('content-type'), 'application/gzip')
assert.equal(await head.text(), '')

const get = await captured.route.fetch(new Request(`http://localhost${PLUGIN_EXPORT_PATH}?name=${encodeURIComponent('@local/dsh-pinned-top')}`))
assert.equal(get.status, 200)
const bytes = new Uint8Array(await get.arrayBuffer())
assert.equal(bytes[0], 0x1f)
assert.equal(bytes[1], 0x8b)
const dir = mkdtempSync(join(tmpdir(), 'plugin-export-route-'))
try {
  const file = join(dir, 'out.tgz')
  writeFileSync(file, bytes)
  const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' })
  assert.match(listing, /^package\/package\.json$/m)
  assert.match(listing, /^package\/lib\/client\.js$/m)
  assert.match(listing, /^package\/EXPORT-NOTE\.md$/m)
  execFileSync('tar', ['-xzf', file, '-C', dir])
  const manifest = JSON.parse(readFileSync(join(dir, 'package', 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@local/dsh-pinned-top')
  assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml')
  const note = readFileSync(join(dir, 'package', 'EXPORT-NOTE.md'), 'utf8')
  assert.match(note, /^# 插件分享说明/m)
  assert.match(note, /「插件」/)
  assert.match(note, /「添加插件」/)
  assert.doesNotMatch(note, /Sharing note|This file was produced|Install:/)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

const missing = await captured.route.fetch(new Request(`http://localhost${PLUGIN_EXPORT_PATH}`, { method: 'GET' }))
assert.equal(missing.status, 400)
const unknown = await captured.route.fetch(new Request(`http://localhost${PLUGIN_EXPORT_PATH}?name=%40local%2Fnope`, { method: 'GET' }))
assert.equal(unknown.status, 404)
const traversal = await captured.route.fetch(new Request(`http://localhost${PLUGIN_EXPORT_PATH}?name=..%2F..%2Fetc`, { method: 'GET' }))
assert.equal(traversal.status, 400)
console.log('route.test: all checks passed')
