#!/usr/bin/env node
/**
 * Validate `site/index.json` with the official DSH plugin-market index validator (format 1).
 *
 *   node scripts/validate-index.mjs [index-url]
 *
 * The URL is the address the index will be served from (GitHub Pages by default). It only provides the origin for
 * relative icon references and the canonical URL check; the file itself is read from disk.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MarketIndexError, marketInstallTarget, parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INDEX_FILE = join(ROOT, 'site', 'index.json')
const DEFAULT_INDEX_URL = 'https://example.github.io/dsh-plugins-market/index.json'

const indexUrl = process.argv[2] ?? DEFAULT_INDEX_URL

function fail(message) {
  console.error(`validate-index: ${message}`)
  process.exit(1)
}

let document
try {
  document = JSON.parse(await readFile(INDEX_FILE, 'utf8'))
} catch (error) {
  fail(`cannot read ${INDEX_FILE}: ${error.message}`)
}

let index
try {
  index = parseMarketIndex(document, indexUrl)
} catch (error) {
  if (error instanceof MarketIndexError) {
    fail(`site/index.json is not a valid format-1 index: ${error.path} ${error.reason}`)
  }
  fail(error.stack ?? error.message)
}

console.log(`VALID format-1 index: ${indexUrl}`)
console.log(`plugins: ${String(index.plugins.length)}`)
for (const plugin of index.plugins) {
  console.log(`  - ${plugin.name} (${String(plugin.versions.length)} version(s))`)
}

const sample = index.plugins[0]
if (sample !== undefined) {
  const target = marketInstallTarget(sample.name, sample.versions[0])
  console.log(`sample install target: ${target.spec}${target.registry === undefined ? '' : `  (registry: ${target.registry})`}`)
}
