#!/usr/bin/env node
/**
 * One-stop plugin publish: sync a plugin into this repo, keep the index metadata, bump its version, build and
 * validate the index, push, wait for GitHub Pages, then install the new commit into the running DSH profile.
 *
 *   node scripts/publish.mjs <plugin> [options]
 *
 * `<plugin>` is a directory under `plugins/` or a plugin directory elsewhere (`--from` is only needed when the
 * argument is not already a path). Examples:
 *
 *   node scripts/publish.mjs dsh-task-notify --bump patch          # publish 0.1.1 and install it
 *   node scripts/publish.mjs --from ~/Desktop/work/dsh-new --bump patch --category tools
 *   node scripts/publish.mjs dsh-cost-stat --dev                   # link-install for local iteration, no push
 *   node scripts/publish.mjs dsh-task-notify --no-push             # build and validate only
 *
 * Options: --bump patch|minor|major, --category <id>, --dev, --no-push, --no-install, --dry-run,
 *          --profile <name> (default $DSH_PROFILE or desktop), --origin <url>, --index-url <url>,
 *          --message <commit message>.
 */
import { execFileSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { call, detectOrigin } from './lib/dsh-api.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = join(ROOT, 'plugins')
const DISPLAY_FILE = join(ROOT, 'plugins.json')
const EXCLUDED = new Set(['node_modules', '.git', '.cache', '.DS_Store'])

function log(message) {
  console.log(message)
}

function fail(message) {
  console.error(`publish: ${message}`)
  process.exit(1)
}

function parseArguments(argv) {
  const options = { positionals: [] }
  const switches = new Set(['dry-run', 'no-push', 'no-install', 'dev'])
  const values = new Set(['bump', 'category', 'profile', 'origin', 'index-url', 'message', 'from'])
  for (let position = 0; position < argv.length; position += 1) {
    const argument = argv[position]
    if (argument === '--help' || argument === '-h') {
      log('node scripts/publish.mjs <plugin> [--from <dir>] [--bump patch|minor|major] [--category <id>]')
      log('                          [--dev] [--no-push] [--no-install] [--dry-run] [--profile desktop]')
      process.exit(0)
    }
    if (!argument.startsWith('--')) {
      options.positionals.push(argument)
      continue
    }
    const name = argument.slice(2)
    if (switches.has(name)) {
      options[name] = true
    } else if (values.has(name)) {
      const value = argv[position + 1]
      if (value === undefined || value.startsWith('--')) fail(`--${name} 需要一个值`)
      options[name] = value
      position += 1
    } else {
      fail(`未知参数 ${argument}`)
    }
  }
  return options
}

function git(arguments_, options = {}) {
  return execFileSync('git', arguments_, { cwd: ROOT, encoding: 'utf8', stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'] })
}

function run(command, arguments_, env = {}) {
  const result = execFileSync(command, arguments_, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, ...env },
  })
  return result.trim()
}

/** `https://github.com/owner/repo` and `owner/repo` from the origin remote. */
function repository() {
  const remote = git(['remote', 'get-url', 'origin'])
  const cleaned = remote.trim().replace(/\.git$/u, '').replace(/\/+$/u, '')
  const match = /github\.com[/:]([^/]+)\/([^/]+)$/u.exec(cleaned)
  if (match === null) fail(`origin remote 不是 GitHub 仓库：${remote.trim()}`)
  return { url: `https://github.com/${match[1]}/${match[2]}`, owner: match[1], repo: match[2] }
}

function pagesIndexUrl(owner, repo) {
  return `https://${owner}.github.io/${repo}/index.json`
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function bumpVersion(version, kind) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version)
  if (match === null) fail(`版本 ${version} 不是 x.y.z 形式，无法自动递增`)
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

async function copyPlugin(source, destination) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await cp(source, destination, {
    recursive: true,
    filter: (path) => !EXCLUDED.has(basename(path)),
  })
}

/** Warn about the repo's plugin-doc conventions without blocking a publish. */
async function checkDocs(pluginDir) {
  const readme = join(pluginDir, 'README.md')
  if (!existsSync(readme)) {
    log('  ! 没有 README.md：插件详情页会没有说明')
    return
  }
  const text = await readFile(readme, 'utf8')
  const docsDir = join(pluginDir, 'docs')
  const images = existsSync(docsDir)
    ? (await import('node:fs/promises')).readdir(docsDir).then((names) => names.filter((name) => /\.(?:png|jpe?g|webp|gif)$/iu.test(name)))
    : Promise.resolve([])
  const found = await images
  if (!text.includes('## 效果图')) log('  ! README 没有「## 效果图」小节（插件规范要求真实界面截图）')
  else if (found.length === 0) log('  ! README 有「## 效果图」但 docs/ 里没有图片')
}

/** Add `docs/*.png` to the manifest's `files` when the docs exist but the list forgets them. */
async function ensureDocsListed(pluginDir, manifest) {
  if (!Array.isArray(manifest.files)) return false
  const docsDir = join(pluginDir, 'docs')
  if (!existsSync(docsDir)) return false
  const names = await (await import('node:fs/promises')).readdir(docsDir)
  if (!names.some((name) => /\.(?:png|jpe?g|webp|gif)$/iu.test(name))) return false
  if (manifest.files.some((entry) => entry.startsWith('docs/'))) return false
  manifest.files.push('docs/*.png')
  log('  · package.json files 里补上 docs/*.png')
  return true
}

/** Read the plugin's own localized meta, used to seed a missing plugins.json entry. */
async function localizedMeta(pluginDir) {
  const read = async (file) => {
    const path = join(pluginDir, 'locale', file)
    if (!existsSync(path)) return undefined
    try {
      return (await readJson(path)).meta
    } catch {
      return undefined
    }
  }
  const zh = await read('zh.json')
  const en = await read('en.json')
  return {
    title: { ...(zh?.title === undefined ? {} : { zh: zh.title }), ...(en?.title === undefined ? {} : { en: en.title }) },
    description: { ...(zh?.description === undefined ? {} : { zh: zh.description }), ...(en?.description === undefined ? {} : { en: en.description }) },
  }
}

async function ensureDisplayEntry(display, dirName, pluginDir, manifest, category) {
  if (display.plugins[dirName] !== undefined) return false
  const meta = await localizedMeta(pluginDir)
  const title = { ...meta.title }
  if (title.en === undefined) title.en = title.zh ?? manifest.name
  const description = { ...meta.description }
  if (description.zh === undefined) description.zh = manifest.description ?? title.zh ?? ''
  if (description.en === undefined) description.en = manifest.description ?? description.zh
  if (!Object.hasOwn(display.metadata.categories, category)) {
    fail(`分类 ${category} 没有在 plugins.json 的 metadata.categories 里声明（已有：${Object.keys(display.metadata.categories).join(', ')}）`)
  }
  display.plugins[dirName] = {
    title,
    description,
    category,
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords : [],
    sortKeys: { recommended: 10 },
  }
  log(`  · plugins.json 里新建了 ${dirName} 的展示信息（分类 ${category}），后续可手动润色`)
  return true
}

async function waitForRun(owner, repo, sha) {
  const deadline = Date.now() + 8 * 60 * 1000
  let run
  while (Date.now() < deadline) {
    try {
      const listing = JSON.parse(
        execFileSync('gh', ['run', 'list', '--repo', `${owner}/${repo}`, '--workflow', 'publish-index.yml', '--limit', '20', '--json', 'databaseId,headSha,status,conclusion'], { encoding: 'utf8' }),
      )
      run = listing.find((candidate) => candidate.headSha === sha)
    } catch {
      return { waited: false }
    }
    if (run !== undefined) break
    await new Promise((done) => setTimeout(done, 8000))
  }
  if (run === undefined) return { waited: false }
  const runId = run.databaseId
  while (Date.now() < deadline) {
    let view
    try {
      view = JSON.parse(execFileSync('gh', ['run', 'view', String(runId), '--repo', `${owner}/${repo}`, '--json', 'status,conclusion'], { encoding: 'utf8' }))
    } catch (error) {
      return { waited: false, runId, note: String(error?.message ?? error).slice(0, 200) }
    }
    if (view.status === 'completed') return { waited: true, runId, conclusion: view.conclusion }
    await new Promise((done) => setTimeout(done, 8000))
  }
  return { waited: false, runId }
}

async function indexShowsCommit(indexUrl, sha) {
  try {
    const response = await fetch(`${indexUrl}?t=${Date.now()}`, { redirect: 'error' })
    if (!response.ok) return false
    const index = await response.json()
    return index.plugins?.every((plugin) => plugin.versions?.[0]?.source?.commit === sha) === true
  } catch {
    return false
  }
}

async function profileDependency(profile, name) {
  const path = join(process.env.HOME, '.dsh', 'profiles', profile, 'package.json')
  if (!existsSync(path)) fail(`找不到 profile ${profile} 的 package.json（${path}）；用 --profile 指定正在运行的 profile`)
  const manifest = await readJson(path)
  return { path, spec: manifest.dependencies?.[name] }
}

async function installLocally({ name, spec, profile, origin, indexUrl }) {
  const { path: profilePath, spec: current } = await profileDependency(profile, name)
  if (current !== undefined) {
    log(`  · 先卸载当前安装（${current.slice(0, 60)}…）`)
    await call('pluginManager/removeBundle', { name }, { origin })
  }
  log(`  · 安装 ${spec.slice(0, 100)}…`)
  const result = await call('pluginManager/installBundle', { spec, options: { saveExact: true } }, { origin })
  if (result?.application === 'failed') {
    fail(`安装失败（${result.error?.code ?? 'unknown'}）：${String(result.error?.diagnostic ?? '').slice(0, 800)}`)
  }
  const { spec: saved } = await profileDependency(profile, name)
  if (saved === undefined) fail('安装后 profile package.json 里没有这个依赖')
  if (result?.application === 'restart-required') log('  ! DSH 提示需要重启才能生效')
  log(`  ✓ 已安装，profile 依赖：${saved.slice(0, 120)}`)
  try {
    await call('pluginMarket/search', { url: indexUrl, query: { refresh: true, offset: 0, limit: 1, sort: { kind: 'index' } } }, { origin })
  } catch {
    // The index source may not be configured in this profile; only a cache warm-up.
  }
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const repositoryInfo = repository()
  const indexUrl = options['index-url'] ?? pagesIndexUrl(repositoryInfo.owner, repositoryInfo.repo)
  const origin = options.origin ?? detectOrigin()
  const profile = options.profile ?? process.env.DSH_PROFILE ?? 'desktop'
  const dryRun = options['dry-run'] === true
  const dev = options.dev === true
  const push = dryRun !== true && dev !== true && options['no-push'] !== true
  const install = dryRun !== true && options['no-install'] !== true

  const requested = options.positionals[0] ?? options.from
  if (requested === undefined) fail('需要一个插件：`node scripts/publish.mjs <plugins 里的目录名>` 或 `--from <外部目录>`')
  const sourceDir = options.from !== undefined ? resolve(options.from) : resolve(PLUGINS_DIR, requested)
  if (!existsSync(join(sourceDir, 'package.json'))) fail(`${sourceDir} 里没有 package.json`)
  const dirName = basename(sourceDir)
  const destination = options.from !== undefined ? join(PLUGINS_DIR, dirName) : sourceDir

  log(`插件：${dirName}`)
  log(`仓库：${repositoryInfo.url}`)
  log(`索引：${indexUrl}`)
  log(`安装：${dev ? `本地 link（${profile}）` : profile}${push ? '，发布后从 GitHub 安装' : '，不发布'}`)

  log('\n[1/7] 同步插件文件')
  if (destination !== sourceDir) {
    if (existsSync(destination)) log(`  · 覆盖 plugins/${dirName}`)
    await copyPlugin(sourceDir, destination)
    log(`  ✓ 已复制到 plugins/${dirName}`)
  } else {
    log('  ✓ 插件就在 plugins/ 里，无需复制')
  }

  const manifestPath = join(destination, 'package.json')
  const manifest = await readJson(manifestPath)
  if (typeof manifest.name !== 'string' || manifest.name.trim() === '') fail('package.json 缺少 name')
  if (!/^\d+\.\d+\.\d+/u.test(manifest.version ?? '')) fail(`package.json 的 version ${JSON.stringify(manifest.version)} 不是 SemVer`)
  if (manifest.dsh?.bundle?.patch === undefined) fail('package.json 没有声明 dsh.bundle.patch：已安装的 bundle 不会生效')
  if (!existsSync(join(destination, manifest.dsh.bundle.patch))) fail(`dsh.bundle.patch 指向的 ${manifest.dsh.bundle.patch} 不存在`)
  if (manifest.dsh?.client !== undefined) {
    const clientEntry = manifest.exports?.['./client']
    if (clientEntry === undefined) fail('声明了 dsh.client 但 package.json 没有 exports["./client"]')
    if (!existsSync(join(destination, clientEntry))) fail(`exports["./client"] 指向的 ${clientEntry} 不存在（先构建客户端再发布）`)
  }
  await checkDocs(destination)
  if (await ensureDocsListed(destination, manifest)) await writeJson(manifestPath, manifest)

  log('\n[2/7] 索引展示信息')
  const display = await readJson(DISPLAY_FILE)
  if (await ensureDisplayEntry(display, dirName, destination, manifest, options.category ?? 'tools')) await writeJson(DISPLAY_FILE, display)
  else log('  ✓ plugins.json 里已有该插件的展示信息')

  log('\n[3/7] 版本号')
  if (options.bump !== undefined) {
    const next = bumpVersion(manifest.version, options.bump)
    manifest.version = next
    await writeJson(manifestPath, manifest)
    log(`  ✓ ${dirName} → ${next}`)
    if (destination !== sourceDir) {
      const sourceManifestPath = join(sourceDir, 'package.json')
      const sourceManifest = await readJson(sourceManifestPath)
      sourceManifest.version = next
      await writeJson(sourceManifestPath, sourceManifest)
      log(`  ✓ 源目录版本号也同步为 ${next}`)
    }
  } else {
    log(`  · 未指定 --bump，保持 ${manifest.version}（版本不变时市场不会提示「有新版本」）`)
  }

  log('\n[4/7] 构建并校验索引')
  run(process.execPath, ['scripts/build-index.mjs'])
  run(process.execPath, ['scripts/validate-index.mjs', indexUrl])
  log('  ✓ format-1 校验通过')

  if (dryRun) {
    log('\n--dry-run：已停在推送前，没有提交、推送或安装')
    return
  }

  let sha = git(['rev-parse', 'HEAD']).trim()
  if (dev) {
    log('\n[5/7] 跳过发布（--dev）')
    await installLocally({ name: manifest.name, spec: `link:${destination}`, profile, origin, indexUrl })
    log('\n完成：本地 link 安装已更新，改代码刷新页面即可看到效果')
    return
  }

  log('\n[5/7] 提交并推送')
  git(['add', '-A'])
  const status = git(['status', '--porcelain'])
  if (status.trim() === '') {
    log('  · 没有文件变化，跳过提交（仍会用当前 commit 安装）')
  } else if (push) {
    const message = options.message ?? `发布 ${manifest.name}@${manifest.version}`
    git(['commit', '-m', message])
    sha = git(['rev-parse', 'HEAD']).trim()
    log(`  · ${message}  ${sha.slice(0, 8)}`)
    run('git', ['push'], { GIT_TERMINAL_PROMPT: '0' })
    log('  ✓ 已推送')
  } else {
    log('  · 有未提交的变化，但 --no-push 下不提交')
  }

  if (!push) {
    log('\n--no-push：跳过 GitHub Pages 等待与安装')
    return
  }

  log('\n[6/7] 等待 GitHub Pages 部署')
  const runState = await waitForRun(repositoryInfo.owner, repositoryInfo.repo, sha)
  if (runState.waited === true) {
    if (runState.conclusion !== 'success') fail(`Actions 运行 ${runState.runId} 失败：gh run view ${runState.runId} --log-failed`)
    log(`  ✓ Actions 成功（run ${runState.runId}）`)
  } else if (runState.runId !== undefined) {
    log(`  ! 没等到 Actions 结束，请查看 run ${runState.runId}`)
  } else {
    log('  ! 没有 gh 或拿不到 run 状态，改为轮询索引地址')
  }
  const deadline = Date.now() + 4 * 60 * 1000
  let deployed = await indexShowsCommit(indexUrl, sha)
  while (!deployed && Date.now() < deadline) {
    await new Promise((done) => setTimeout(done, 10000))
    deployed = await indexShowsCommit(indexUrl, sha)
  }
  if (deployed) log(`  ✓ 线上索引已指向 ${sha.slice(0, 8)}`)
  else log('  ! 线上索引还没更新（Pages 偶尔延迟），继续安装不影响')

  if (!install) {
    log('\n--no-install：跳过本地安装')
    return
  }

  log('\n[7/7] 安装到本机 DSH')
  await installLocally({
    name: manifest.name,
    spec: `git+${repositoryInfo.url}.git#${sha}&path:/plugins/${dirName}`,
    profile,
    origin,
    indexUrl,
  })

  log('\n完成')
  log(`  插件：${manifest.name}@${manifest.version}`)
  log(`  索引：${indexUrl}`)
  log(`  别人：发现页缓存 10 分钟（或点刷新）后会看到「有新版本」，卸载再装即更新`)
}

main().catch((error) => {
  console.error(`publish: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
