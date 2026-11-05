/**
 * Unit checks for the archive writer: npm tarball shape, content completeness,
 * gzip validity, and the safety limits. Run with `node test/tar.test.mjs`.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPackageArchive, archiveFileName, ExportLimitError } from '../tar.js'

const root = mkdtempSync(join(tmpdir(), 'plugin-export-test-'))
try {
  mkdirSync(join(root, 'lib'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'ignored'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@acme/demo-plugin', version: '1.2.3' }))
  writeFileSync(join(root, 'lib', 'client.js'), 'export const ok = true\n')
  writeFileSync(join(root, 'node_modules', 'ignored', 'index.js'), 'no')
  writeFileSync(join(root, '.DS_Store'), 'no')

  const archive = buildPackageArchive(root, { note: '# note\n' })
  const file = join(root, 'demo.tgz')
  writeFileSync(file, archive)

  const listing = execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).trim().split('\n').sort()
  assert.deepEqual(listing, [
    'package/',
    'package/EXPORT-NOTE.md',
    'package/lib/',
    'package/lib/client.js',
    'package/package.json',
  ])

  const extracted = join(root, 'out')
  mkdirSync(extracted)
  execFileSync('tar', ['-xzf', file, '-C', extracted])
  assert.equal(JSON.parse(readFileSync(join(extracted, 'package', 'package.json'), 'utf8')).name, '@acme/demo-plugin')
  assert.equal(readFileSync(join(extracted, 'package', 'lib', 'client.js'), 'utf8'), 'export const ok = true\n')
  assert.ok(readFileSync(join(extracted, 'package', 'EXPORT-NOTE.md'), 'utf8').includes('note'))

  // gzip container: magic bytes and round-trip size sanity.
  assert.equal(archive[0], 0x1f)
  assert.equal(archive[1], 0x8b)

  assert.equal(archiveFileName('@acme/demo-plugin', '1.2.3'), 'demo-plugin-1.2.3.tgz')
  assert.equal(archiveFileName('@acme/weird name', undefined), 'weird-name-0.0.0.tgz')

  // Entry-count limit reports the dedicated error so the route can answer 413.
  assert.throws(() => buildPackageArchive(root, { maxFiles: 1 }), ExportLimitError)
  assert.throws(() => buildPackageArchive(root, { maxBytes: 16 }), ExportLimitError)
  console.log('tar.test: all checks passed')
} finally {
  rmSync(root, { recursive: true, force: true })
}
