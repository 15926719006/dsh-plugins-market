/**
 * 工作台（Host 侧）
 *
 * 只做一件事：把"会话里本来没有的东西"持久化下来 —— 结论、下一步、状态、单号。
 * 会话事件、标题、时间、归档状态一律不碰，全部从内核派生。
 *
 * 数据落在 `~/.dsh/workbench/`：
 * - notes.json  按 sessionId 一行旁注
 * - config.json 工作工作区路径
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.dsh', 'workbench')
const NOTES_PATH = join(DIR, 'notes.json')
const CONFIG_PATH = join(DIR, 'config.json')

import { loadDevopsCredentials } from './lib/devops/devops-credentials.mjs'
import { resolveDevopsTitle } from './lib/devops/devops-resolve.mjs'
import { kindOfRef } from './lib/devops/devops-refs.mjs'

const NOTES_ROUTE = '/api/workbench/notes'
const CONFIG_ROUTE = '/api/workbench/config'
const REFS_ROUTE = '/api/workbench/refs'
const TITLES_ROUTE = '/api/workbench/titles'
const TITLES_PATH = join(DIR, 'titles.json')
/** 标题缓存多久重新取一次；需求标题偶尔会改，但不用每次刷新都问平台。 */
const TITLE_TTL_MS = 6 * 60 * 60 * 1000
const REFS_PATH = join(DIR, 'refs.json')

/** 单号归类规则的版本；改规则就 +1，让旧缓存失效。 */
const REF_RULE_VERSION = 5

/** devops 链接里的编号（比裸编号更可信：链接是用户主动贴过来的）。 */
const LINK_REF_PATTERN = /devops\.ronhan\.com\/[^\s"'<>)\]]*?\/([A-Z]{2,4}-\d{4,}(?:-\d{3})?(?:-S\d+)?)/g

/**
 * devops 编号。和 `session-rename` 用的那一套一致：需求 RO、任务 T、专项 P、
 * 缺陷 BUG、issue ON3，子任务带 -S04 后缀。
 */
const REF_PATTERN = /\b(RO-\d{8}-\d{3}(?:-S\d+)?|T-\d{8}-\d{3}|P-\d{8}-\d{3}|BUG-\d{8}-\d{3}|ON3-\d{4,})\b/g
const LOG_ROUTE = '/api/workbench/log'
const LOG_PATH = join(DIR, 'client.log')

/** 旁注里允许写入的字段，其余一律丢弃。 */
const NOTE_FIELDS = ['outcome', 'next', 'status', 'impact', 'note', 'refs', 'reviveAt']
/** 状态取值。 */
const STATUSES = ['open', 'done', 'dropped']

export const inject = ['connection']

export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: NOTES_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: (request) => handleNotes(ctx, request),
  }), 'workbench: notes route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: CONFIG_ROUTE,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: (request) => handleConfig(ctx, request),
  }), 'workbench: config route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: REFS_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleRefs(ctx, request),
  }), 'workbench: refs route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: TITLES_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleTitles(ctx, request),
  }), 'workbench: titles route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: LOG_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleLog(ctx, request),
  }), 'workbench: log route')
}

/** 读 JSON；文件不存在或损坏时返回兜底值。 */
async function readJson(path, fallback) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

/** 原子写：先写临时文件再 rename。 */
async function writeJson(path, value) {
  await mkdir(DIR, { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

/** 默认工作工作区。 */
function defaultWorkRoot() {
  return join(homedir(), 'Desktop', 'work')
}

/** 读配置，补齐默认值。 */
async function readConfig() {
  const raw = await readJson(CONFIG_PATH, {})
  const workRoot = typeof raw.workRoot === 'string' && raw.workRoot.trim() !== ''
    ? raw.workRoot
    : defaultWorkRoot()
  return { workRoot }
}

/** 读全部旁注。 */
async function readNotes() {
  const raw = await readJson(NOTES_PATH, {})
  const notes = raw.notes !== null && typeof raw.notes === 'object' && raw.notes !== undefined
    ? raw.notes
    : {}
  return notes
}

/** 清洗一条旁注的补丁。 */
function cleanPatch(input) {
  const patch = {}
  if (input === null || typeof input !== 'object') return patch
  for (const field of NOTE_FIELDS) {
    if (!(field in input)) continue
    const value = input[field]
    if (field === 'refs') {
      if (!Array.isArray(value)) continue
      patch.refs = value
        .filter((ref) => ref !== null && typeof ref === 'object' && typeof ref.ref === 'string' && ref.ref !== '')
        .map((ref) => ({
          kind: typeof ref.kind === 'string' ? ref.kind : 'ref',
          ref: ref.ref,
          url: typeof ref.url === 'string' ? ref.url : null,
        }))
      continue
    }
    if (field === 'reviveAt') {
      if (typeof value === 'number' && Number.isFinite(value)) patch.reviveAt = value
      continue
    }
    if (field === 'status') {
      if (typeof value === 'string' && STATUSES.includes(value)) patch.status = value
      continue
    }
    if (typeof value === 'string') patch[field] = value
  }
  return patch
}

/** JSON 响应。 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** GET 全部旁注；POST 写入一条。 */
async function handleNotes(ctx, request) {
  try {
    if (request.method === 'GET') {
      const [notes, config] = await Promise.all([readNotes(), readConfig()])
      return json({ ok: true, notes, config })
    }

    const body = await request.json()
    // key 现在有两种：`session:<id>`（未挂单的会话）和 `devops:<单号>`（任务）。
    const key = typeof body?.key === 'string' && body.key !== ''
      ? body.key
      : typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (key === '') return json({ ok: false, error: 'key is required' }, 400)

    const notes = await readNotes()
    const current = notes[key] !== null && typeof notes[key] === 'object' && notes[key] !== undefined
      ? notes[key]
      : {}
    const patch = cleanPatch(body.patch)
    const next = { ...current, ...patch, key, updatedAt: Date.now(), writtenBy: 'user' }
    notes[key] = next
    await writeJson(NOTES_PATH, { version: 1, notes })
    return json({ ok: true, note: next })
  } catch (error) {
    ctx.logger?.warn?.(`workbench: notes route failed: ${error instanceof Error ? error.message : String(error)}`)
    return json({ ok: false, error: 'notes route failed' }, 500)
  }
}

/** 子任务归到父需求；专项（P-）是容器，不作为任务。 */
function normalizeRef(ref) {
  const parent = ref.replace(/-S\d+$/u, '')
  return parent.startsWith('P-') ? null : parent
}

/** 从一段文本里抠出全部 devops 编号（去重）。 */
function findRefs(text) {
  const found = new Set()
  for (const match of text.matchAll(REF_PATTERN)) {
    const ref = normalizeRef(match[1])
    if (ref !== null) found.add(ref)
  }
  return [...found]
}

/** 从一段文本里抠出 devops 链接里的编号（去重）。 */
function findLinkRefs(text) {
  const found = new Set()
  for (const match of text.matchAll(LINK_REF_PATTERN)) {
    const ref = normalizeRef(match[1])
    if (ref !== null) found.add(ref)
  }
  return [...found]
}

/**
 * 找出一个会话在谈的那**一个**单号。
 *
 * 规则（用真实日志定过）：先看用户说过的话，按时间取第一个出现的编号；
 * 用户没提过，才退到助手文本里的第一个。
 *
 * 为什么不看工具输出：一次拉列表、一次 grep 文档就能带出几十个编号，
 * 按"整份日志出现过的编号"归类，会把毫不相干的会话挂到同一个任务上。
 * 为什么只取一个：一个会话干一件事，多出来的编号是顺手提到的。
 */
async function scanSession(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query === undefined || typeof query.readSession !== 'function') return null
  const snapshot = await query.readSession(sessionId)
  const events = Array.isArray(snapshot?.events) ? snapshot.events : []

  for (const event of events) {
    if (!String(event?.type ?? '').startsWith('user')) continue
    // 大量 `user/message` 是注入的上下文（时间、运行时快照、技能清单、AGENTS 规则、
    // 上级 agent 的消息）；只有 source.kind === 'user' 才是人真正打出来的话。
    if (event?.data?.source?.kind !== 'user') continue
    const text = JSON.stringify(event?.data ?? {})

    // 1) 用户贴了链接：1~2 个链接以第一个为主（第二个常是“复用它的分支”）；
    //    3 个以上是批量检索（“拉一下这周的单”），不算跟进。
    const links = findLinkRefs(text)
    if (links.length >= 3) continue
    if (links.length > 0) return [links[0]]

    // 2) 只有裸编号：一条消息里恰好一个，才算在说这件事。
    const refs = findRefs(text)
    if (refs.length === 1) return [refs[0]]
  }
  return []
}

/**
 * 批量给会话找编号。缓存按会话的 updatedAt 失效，所以只有新会话或新消息才会重扫。
 * 单次请求最多扫 `limit` 个，没扫到的在响应里报出来，客户端下次继续。
 */
async function handleRefs(ctx, request) {
  try {
    const body = await request.json()
    const requested = Array.isArray(body?.sessions) ? body.sessions : []
    const cache = await readJson(REFS_PATH, {})
    // 规则升版就作废旧缓存：旧规则下的结果会把无关会话挂到同一个任务上。
    const cachedEntries = cache.entries !== null && typeof cache.entries === 'object' && cache.entries !== undefined
      ? cache.entries
      : {}
    const entries = cache.rule === REF_RULE_VERSION ? cachedEntries : {}

    const refs = {}
    const pending = []
    for (const item of requested) {
      const id = typeof item?.id === 'string' ? item.id : ''
      if (id === '') continue
      const updatedAt = typeof item?.updatedAt === 'number' ? item.updatedAt : 0
      const hit = entries[id]
      if (hit !== undefined && hit.updatedAt === updatedAt && Array.isArray(hit.refs)) {
        refs[id] = hit.refs
        continue
      }
      pending.push({ id, updatedAt })
    }

    const limit = 40
    const batch = pending.slice(0, limit)
    let scanned = 0
    let failed = 0
    for (const item of batch) {
      try {
        const found = await scanSession(ctx, item.id)
        if (found === null) {
          failed = batch.length
          break
        }
        entries[item.id] = { updatedAt: item.updatedAt, refs: found }
        refs[item.id] = found
        scanned += 1
      } catch {
        failed += 1
      }
    }

    if (scanned > 0 || failed === 0) await writeJson(REFS_PATH, { version: 1, rule: REF_RULE_VERSION, entries })
    return json({
      ok: true,
      refs,
      scanned,
      failed,
      pending: Math.max(0, pending.length - batch.length),
      hasScanner: ctx.get('sessionQuery') !== undefined,
    })
  } catch (error) {
    ctx.logger?.warn?.(`workbench: refs route failed: ${error instanceof Error ? error.message : String(error)}`)
    return json({ ok: false, error: 'refs route failed' }, 500)
  }
}

/** 打开这条记录的链接。平台的路由按记录类型不同，认不出的就不给链接。 */
function urlOfRef(baseUrl, ref) {
  const kind = kindOfRef(ref)
  const base = String(baseUrl ?? '').replace(/\/+$/u, '')
  if (kind === 'demand') return `${base}/#demand/${ref}`
  if (kind === 'task') return `${base}/task/${ref}`
  if (kind === 'project') return `${base}/#project-management/${ref}`
  if (kind === 'defect') return `${base}/defect/${ref}`
  return null
}

/**
 * 给每个单号取平台上的标题，界面才不是一串编号。
 *
 * 取不到（没配 token、平台慢、记录被删）就如实返回空标题，界面只显示编号，
 * 不会挡住任何东西。
 */
async function handleTitles(ctx, request) {
  try {
    const body = await request.json()
    const requested = Array.isArray(body?.refs) ? body.refs.filter((ref) => typeof ref === 'string' && ref !== '') : []
    const credentials = loadDevopsCredentials()
    const cache = await readJson(TITLES_PATH, {})
    const entries = cache.refs !== null && typeof cache.refs === 'object' && cache.refs !== undefined ? cache.refs : {}

    const titles = {}
    let fetched = 0
    const now = Date.now()
    for (const ref of [...new Set(requested)]) {
      const hit = entries[ref]
      if (hit !== undefined && typeof hit.at === 'number' && now - hit.at < TITLE_TTL_MS && typeof hit.title === 'string') {
        titles[ref] = { title: hit.title, url: hit.url ?? urlOfRef(credentials.baseUrl, ref) }
        continue
      }
      if (credentials.token === '') {
        titles[ref] = { title: '', url: urlOfRef(credentials.baseUrl, ref) }
        continue
      }
      let title = ''
      try {
        const resolved = await resolveDevopsTitle(ref, credentials)
        title = typeof resolved?.title === 'string' ? resolved.title : ''
        fetched += 1
      } catch {
        title = ''
      }
      const url = urlOfRef(credentials.baseUrl, ref)
      entries[ref] = { title, url, at: now }
      titles[ref] = { title, url }
    }

    if (fetched > 0) await writeJson(TITLES_PATH, { version: 1, refs: entries })
    return json({ ok: true, titles, fetched, hasCredential: credentials.token !== '' })
  } catch (error) {
    ctx.logger?.warn?.(`workbench: titles route failed: ${error instanceof Error ? error.message : String(error)}`)
    return json({ ok: false, error: 'titles route failed' }, 500)
  }
}

/** 客户端把加载/注册异常写回这里，排障用。 */
async function handleLog(ctx, request) {
  try {
    const body = await request.json()
    const line = `${new Date().toISOString()} ${String(body?.label ?? '?')} ${String(body?.message ?? '')}\n`
    await mkdir(DIR, { recursive: true })
    await appendFile(LOG_PATH, line, 'utf8')
    return json({ ok: true })
  } catch (error) {
    ctx.logger?.warn?.(`workbench: log route failed: ${error instanceof Error ? error.message : String(error)}`)
    return json({ ok: false }, 500)
  }
}

/** GET 配置；POST 改工作工作区。 */
async function handleConfig(ctx, request) {
  try {
    if (request.method === 'GET') return json({ ok: true, config: await readConfig() })
    const body = await request.json()
    const workRoot = typeof body?.workRoot === 'string' ? body.workRoot.trim() : ''
    if (workRoot === '') return json({ ok: false, error: 'workRoot is required' }, 400)
    await writeJson(CONFIG_PATH, { workRoot })
    return json({ ok: true, config: { workRoot } })
  } catch (error) {
    ctx.logger?.warn?.(`workbench: config route failed: ${error instanceof Error ? error.message : String(error)}`)
    return json({ ok: false, error: 'config route failed' }, 500)
  }
}
