#!/usr/bin/env node
/**
 * Build the DSH plugin market index (format 1) for this repository.
 *
 * For every directory under `plugins/` it reads the package manifest, the icon and the hand-written display
 * metadata in `plugins.json`, then emits one Git-sourced version pinned to the current commit. The result is
 * written to `site/index.json`, which GitHub Pages publishes.
 *
 * The repository URL and commit normally come from the CI environment ($GITHUB_REPOSITORY, $GITHUB_SHA) or from
 * `git remote get-url origin` / `git rev-parse HEAD`. They can be overridden for a dry run outside a checkout:
 *
 *   node scripts/build-index.mjs --repo https://github.com/example/dsh-plugins-market --commit <40-hex>
 */
import { execFileSync } from 'node:child_process'
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = join(ROOT, 'plugins')
const OUTPUT_FILE = join(ROOT, 'site', 'index.json')
const DISPLAY_FILE = join(ROOT, 'plugins.json')

/** Must stay equal to the validator's limit: 32 KiB of decoded icon bytes. */
const MAX_ICON_BYTES = 32 * 1024
/** Must stay equal to the validator's rule: a lowercase 40-hex-digit commit SHA. */
const COMMIT = /^[0-9a-f]{40}$/u
/** The SemVer 2.0.0 grammar for one exact version, as used by the index validator. */
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  'u',
)
/** The validator rejects publish timestamps at or above this bound. */
const MAX_PUBLISH_TIMESTAMP = 1e11

/** Print an error and exit non-zero: the index must never be published half-built. */
function fail(message) {
  console.error(`build-index: ${message}`)
  process.exit(1)
}

/** Parse `--repo <url>` and `--commit <sha>`; reject anything else so a typo cannot silently build a wrong index. */
function parseArgs(argv) {
  const options = {}
  for (let position = 0; position < argv.length; position += 1) {
    const argument = argv[position]
    if (argument === '--repo' || argument === '--commit') {
      const value = argv[position + 1]
      if (value === undefined || value.startsWith('--')) fail(`${argument} needs a value`)
      options[argument.slice(2)] = value
      position += 1
    } else {
      fail(`unknown argument ${JSON.stringify(argument)}; supported: --repo <url>, --commit <sha>`)
    }
  }
  return options
}

/** Run a git command in this repository; `undefined` when git or the repository is unavailable. */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

/**
 * Normalize a repository location to the canonical `https://host/owner/repo` form the index validator requires.
 * Accepts the HTTPS, SSH (`ssh://` and `git@host:owner/repo`) and bare `owner/repo` spellings.
 */
function canonicalRepository(value, source) {
  let text = value.trim()
  if (text === '') fail(`${source} is empty`)

  let url
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(text)
  if (!text.includes('://') && scp !== null && text.includes('@')) {
    // git@github.com:owner/repo.git (scp-like SSH form).
    url = new URL(`https://${scp[1]}/${scp[2]}`)
  } else if (!text.includes('://') && /^[^/\s]+\/[^/\s]+$/u.test(text)) {
    // `$GITHUB_REPOSITORY` is `owner/repo`, not a URL.
    url = new URL(`https://github.com/${text}`)
  } else {
    try {
      url = new URL(text)
    } catch {
      fail(`${source} ${JSON.stringify(value)} is not a repository URL or an owner/repo pair`)
    }
    if (url.protocol === 'ssh:' || url.protocol === 'git:') {
      // The SSH user (`git@`) is not a credential for the HTTPS URL the index needs.
      url = new URL(`https://${url.host}${url.pathname}`)
    } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      fail(`${source} ${JSON.stringify(value)} must use an https, ssh, or git URL`)
    }
  }

  if (url.username !== '' || url.password !== '') fail(`${source} ${JSON.stringify(value)} must not contain credentials`)
  if (url.search !== '' || url.hash !== '') fail(`${source} ${JSON.stringify(value)} must not contain a query or fragment`)

  let path = url.pathname.replace(/\/+$/u, '')
  path = path.replace(/\.git$/u, '').replace(/\/+$/u, '')
  const segments = path.split('/').filter((segment) => segment !== '')
  if (segments.length !== 2) {
    fail(`${source} ${JSON.stringify(value)} must name a repository as https://host/owner/repo (2 path segments)`)
  }
  return `https://${url.host}/${segments[0]}/${segments[1]}`
}

/** The repository URL: `--repo`, then `$GITHUB_REPOSITORY`, then the `origin` remote. */
function repositoryUrl(options) {
  if (options.repo !== undefined) return canonicalRepository(options.repo, '--repo')
  const fromEnvironment = process.env.GITHUB_REPOSITORY
  if (fromEnvironment !== undefined && fromEnvironment.trim() !== '') {
    return canonicalRepository(fromEnvironment, 'GITHUB_REPOSITORY')
  }
  const fromRemote = git(['remote', 'get-url', 'origin'])
  if (fromRemote !== undefined && fromRemote !== '') {
    return canonicalRepository(fromRemote, 'git remote get-url origin')
  }
  fail('cannot determine the repository URL; set GITHUB_REPOSITORY, add a git origin, or pass --repo <url>')
}

/** The commit SHA: `--commit`, then `$GITHUB_SHA`, then `git rev-parse HEAD`; it must be lowercase 40-hex. */
function commitSha(options) {
  let value
  if (options.commit !== undefined) value = options.commit.trim()
  else if (process.env.GITHUB_SHA !== undefined && process.env.GITHUB_SHA.trim() !== '') value = process.env.GITHUB_SHA.trim()
  else value = git(['rev-parse', 'HEAD'])

  if (value === undefined || value === '') {
    fail('cannot determine the commit; set GITHUB_SHA, run inside a git checkout, or pass --commit <40-hex-sha>')
  }
  if (!COMMIT.test(value)) {
    fail(`commit ${JSON.stringify(value)} must be 40 lowercase hex digits (pass --commit <sha> or set GITHUB_SHA)`)
  }
  return value
}

/** The commit time of `plugins/<directory>` in Unix seconds; the current time when git has no answer. */
function publishTimestamp(directory) {
  const value = git(['log', '-1', '--format=%ct', '--', `plugins/${directory}`])
  const timestamp = value === undefined || value === '' ? Number.NaN : Number(value)
  if (Number.isInteger(timestamp) && timestamp >= 0 && timestamp < MAX_PUBLISH_TIMESTAMP) return timestamp
  return Math.floor(Date.now() / 1000)
}

/** The inline `data:` icon from `plugins/<directory>/icon.svg`, or `undefined` when there is no usable icon. */
async function inlineIcon(directory) {
  const iconPath = join(PLUGINS_DIR, directory, 'icon.svg')
  if (!existsSync(iconPath)) {
    console.warn(`build-index: warning: ${directory} has no icon.svg; the plugin is published without an icon`)
    return undefined
  }
  const bytes = await readFile(iconPath)
  if (bytes.byteLength > MAX_ICON_BYTES) {
    console.warn(
      `build-index: warning: ${directory}/icon.svg is ${String(bytes.byteLength)} bytes, over the ${String(MAX_ICON_BYTES)}-byte inline limit; the plugin is published without an icon`,
    )
    return undefined
  }
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`
}

/** Read and check `plugins/<directory>/package.json`; the manifest must state the package name and an exact version. */
async function packageManifest(directory) {
  const manifestPath = join(PLUGINS_DIR, directory, 'package.json')
  if (!existsSync(manifestPath)) fail(`plugins/${directory}/package.json is missing`)
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    fail(`plugins/${directory}/package.json is not valid JSON: ${error.message}`)
  }
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') {
    fail(`plugins/${directory}/package.json has no package name`)
  }
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) {
    fail(`plugins/${directory}/package.json version ${JSON.stringify(manifest.version)} is not an exact SemVer version`)
  }
  return manifest
}

/** Build one plugin entry from its package manifest and the display metadata in `plugins.json`. */
async function pluginEntry(directory, display, repository, commit) {
  const manifest = await packageManifest(directory)
  if (display === undefined) {
    fail(`plugins.json has no display metadata for plugins/${directory} (add its title, description, category and keywords)`)
  }
  if (typeof display.title !== 'object' || display.title === null || typeof display.title.en !== 'string') {
    fail(`plugins.json entry for ${directory} needs a localized title with "en"`)
  }

  const version = {
    version: manifest.version,
    publishTimestamp: publishTimestamp(directory),
    source: { type: 'git', url: repository, commit, path: `plugins/${directory}` },
  }
  const dsh = manifest.engines?.dsh
  if (typeof dsh === 'string' && dsh.trim() !== '') version.engines = { dsh }

  const metadata = {}
  if (display.category !== undefined) metadata.category = display.category
  if (Array.isArray(display.keywords) && display.keywords.length > 0) metadata.keywords = display.keywords
  if (Array.isArray(display.labels) && display.labels.length > 0) metadata.labels = display.labels
  if (typeof display.sortKeys === 'object' && display.sortKeys !== null) metadata.sortKeys = display.sortKeys

  const entry = {
    name: manifest.name,
    repository: { url: repository, directory: `plugins/${directory}` },
  }
  if (display.title !== undefined) entry.title = display.title
  if (display.description !== undefined) entry.description = display.description
  const icon = await inlineIcon(directory)
  if (icon !== undefined) entry.icon = icon
  entry.metadata = metadata
  entry.versions = [version]
  return entry
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const repository = repositoryUrl(options)
  const commit = commitSha(options)

  let display
  try {
    display = JSON.parse(await readFile(DISPLAY_FILE, 'utf8'))
  } catch (error) {
    fail(`plugins.json is missing or invalid JSON: ${error.message}`)
  }
  if (display.index === undefined || display.index.title === undefined) {
    fail('plugins.json needs an "index.title"')
  }

  let directories
  try {
    directories = (await readdir(PLUGINS_DIR, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    fail(`cannot read the plugins directory: ${error.message}`)
  }
  if (directories.length === 0) fail('plugins/ contains no plugin directories; publish an index only when there is something to install')

  const plugins = []
  const names = new Set()
  for (const directory of directories) {
    const entry = await pluginEntry(directory, display.plugins?.[directory], repository, commit)
    if (names.has(entry.name)) fail(`two plugin directories publish the package name ${entry.name}`)
    names.add(entry.name)
    plugins.push(entry)
  }

  const index = { format: 1, ...display.index, metadata: display.metadata ?? {}, plugins }
  await mkdir(dirname(OUTPUT_FILE), { recursive: true })
  await writeFile(OUTPUT_FILE, `${JSON.stringify(index, null, 2)}\n`)

  console.log(`built ${OUTPUT_FILE}`)
  console.log(`repo:   ${repository}`)
  console.log(`commit: ${commit}`)
  console.log(`plugins (${String(plugins.length)}):`)
  for (const plugin of plugins) {
    console.log(`  - ${plugin.name}@${plugin.versions[0].version}  ${plugin.versions[0].source.path}`)
  }
}

main().catch((error) => {
  console.error(`build-index: ${error.stack ?? error.message}`)
  process.exit(1)
})
