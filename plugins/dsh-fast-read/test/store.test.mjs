import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { writeJson } from '../src/host/lib/store.js'

test('concurrent writes to one file do not collide', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fast-read-store-'))
  const file = join(dir, 'index.json')
  await Promise.all(Array.from({ length: 8 }, (_, index) => writeJson(file, { index })))
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(typeof parsed.index, 'number')
})
