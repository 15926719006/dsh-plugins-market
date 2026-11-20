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
import { DEMAND_STATUS, DEFECT_STATUS, TASK_STATUS, groupOf, labelOf } from './lib/devops/labels.mjs'

const NOTES_ROUTE = '/api/workbench/notes'
const CONFIG_ROUTE = '/api/workbench/config'
const REFS_ROUTE = '/api/workbench/refs'
const RECORDS_ROUTE = '/api/workbench/records'
const RECORDS_PATH = join(DIR, 'records.json')
/** 状态会变，缓存短一点；标题跟着一起缓存也不吃亏。 */
const RECORD_TTL_MS = 10 * 60 * 1000

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
    path: RECORDS_ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleRecords(ctx, request),
  }), 'workbench: records route')

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

  let userMessages = 0
  let assistantMessages = 0
  let firstAt = null
  let lastAt = null
  let ref = null
  for (const event of events) {
    if (typeof event?.time === 'number') {
      if (firstAt === null || event.time < firstAt) firstAt = event.time
      if (lastAt === null || event.time > lastAt) lastAt = event.time
    }
    const type = String(event?.type ?? '')
    if (type.startsWith('assistant')) assistantMessages += 1
    if (!type.startsWith('user')) continue
    // 大量 `user/message` 是注入的上下文（时间、运行时快照、技能清单、AGENTS 规则、
    // 上级 agent 的消息）；只有 source.kind === 'user' 才是人真正打出来的话。
    if (event?.data?.source?.kind !== 'user') continue
    userMessages += 1
    if (ref !== null) continue
    const text = JSON.stringify(event?.data ?? {})
    const links = findLinkRefs(text)
    if (links.length >= 3) continue
    if (links.length > 0) {
      ref = links[0]
      continue
    }
    const refs = findRefs(text)
    if (refs.length === 1) ref = refs[0]
  }

  return {
    refs: ref === null ? [] : [ref],
    userMessages,
    assistantMessages,
    firstAt,
    lastAt,
  }
}

/** 从投影缓存里取这条会话的费用；取不到就是 null。 */
function costOf(ctx, header) {
  try {
    const cache = ctx.get('sessionProjectionCache')
    if (cache === undefined || typeof cache.cachedSnapshot !== 'function' || header === undefined) return null
    const snapshot = cache.cachedSnapshot(header)
    const usage = snapshot?.values?.costUsage ?? snapshot?.rows?.costUsage?.val ?? null
    return typeof usage?.cost === 'number' ? usage.cost : null
  } catch {
    return null
  }
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
    const headers = {}
    try {
      const query = ctx.get('sessionQuery')
      if (query !== undefined && typeof query.listSessions === 'function') {
        for (const record of await query.listSessions()) {
          if (record?.header?.id !== undefined) headers[record.header.id] = record.header
        }
      }
    } catch {
      // 拿不到 header 就只是没有费用，不影响分类。
    }
    const cachedEntries = cache.entries !== null && typeof cache.entries === 'object' && cache.entries !== undefined
      ? cache.entries
      : {}
    const entries = cache.rule === REF_RULE_VERSION ? cachedEntries : {}

    const sessions = {}
    const pending = []
    for (const item of requested) {
      const id = typeof item?.id === 'string' ? item.id : ''
      if (id === '') continue
      const updatedAt = typeof item?.updatedAt === 'number' ? item.updatedAt : 0
      const hit = entries[id]
      if (hit !== undefined && hit.updatedAt === updatedAt && Array.isArray(hit.refs) && typeof hit.userMessages === 'number') {
        sessions[id] = hit
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
        const entry = { updatedAt: item.updatedAt, ...found, cost: costOf(ctx, headers[item.id]) }
        entries[item.id] = entry
        sessions[item.id] = entry
        scanned += 1
      } catch {
        failed += 1
      }
    }

    if (scanned > 0 || failed === 0) await writeJson(REFS_PATH, { version: 1, rule: REF_RULE_VERSION, entries })
    return json({
      ok: true,
      sessions,
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
 * 版本单标题里的发布日期：「2026-11-23 常规版本」→ 那天发布。
 * 需求状态只说“完成了”，不说哪天发的，所以上线日期从这里取。
 */
export function deriveFromVersion(versionTitle, now = Date.now()) {
  const match = /(\d{4})-(\d{2})-(\d{2})/u.exec(String(versionTitle ?? ''))
  if (match === null) return { at: null, released: false }
  const at = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`)
  if (!Number.isFinite(at)) return { at: null, released: false }
  return { at, released: at <= now }
}

/**
 * 从平台返回里读出这条记录的标题与状态。
 *
 * 状态直接用平台自己的字段（中文表取自 `onerway-pmo`）：需求单
 * `data.demand.status`、任务 `data.status`、缺陷 `data.status`。
 */
/** 「2026-11-09」→ 那天 00:00 的时间戳；解析不了就是 null。 */
function dayOf(value) {
  if (typeof value !== 'string' || value === '') return null
  const match = /(\d{4})-(\d{2})-(\d{2})/u.exec(value)
  if (match === null) return null
  const at = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00+08:00`)
  return Number.isFinite(at) ? at : null
}

export function readRecord(kind, data) {
  if (data === null || typeof data !== 'object') {
    return { title: '', statusCode: '', statusLabel: '', group: 'unknown', version: null, schedule: null }
  }
  if (kind === 'demand') {
    const order = data.order ?? {}
    const demand = data.demand ?? {}
    return {
      title: typeof order.title === 'string' ? order.title : '',
      statusCode: String(demand.status ?? ''),
      statusLabel: labelOf(demand.status, DEMAND_STATUS),
      group: groupOf('demand', demand.status),
      version: typeof order.version === 'string' ? order.version : null,
      // 计划日期：判断“延没延期”的基准。
      schedule: {
        start: dayOf(demand.targetStartDate),
        testPlan: dayOf(demand.planTestDate),
        endPlan: dayOf(demand.targetEndDate),
      },
    }
  }
  if (kind === 'task') {
    return {
      title: typeof data.name === 'string' ? data.name : '',
      statusCode: String(data.status ?? ''),
      statusLabel: labelOf(data.status, TASK_STATUS),
      group: groupOf('task', data.status),
      version: null,
    }
  }
  if (kind === 'defect') {
    return {
      title: typeof data.name === 'string' ? data.name : '',
      statusCode: String(data.status ?? ''),
      statusLabel: labelOf(data.status, DEFECT_STATUS),
      group: groupOf('defect', data.status),
      version: null,
    }
  }
  return { title: '', statusCode: '', statusLabel: '', group: 'unknown', version: null }
}

/** 问平台要一条记录：标题、状态、版本，以及能算出来的上线日期。 */
async function fetchRecord(ref, credentials, baseUrl) {
  const headers = {
    authorization: `Bearer ${credentials.token}`,
    accept: 'application/json',
    'content-type': 'application/json',
  }
  const kind = kindOfRef(ref)
  const empty = { title: '', statusCode: '', statusLabel: '', group: 'unknown', version: null, schedule: null, onlineAt: null, plannedAt: null, versionTitle: null }

  try {
    if (kind === 'demand') {
      const response = await fetch(`${baseUrl}/api/devops/demand/detail/${ref}`, { headers })
      const body = await response.json().catch(() => null)
      const record = readRecord('demand', body?.data ?? null)

      let plannedAt = null
      let versionTitle = null
      const versionOrderId = body?.data?.order?.aggregatedToVersionOrderId
      if (typeof versionOrderId === 'string' && versionOrderId !== '') {
        try {
          const versionResponse = await fetch(`${baseUrl}/api/devops/release/order/detail`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ orderId: versionOrderId }),
          })
          const versionBody = await versionResponse.json().catch(() => null)
          versionTitle = versionBody?.data?.title ?? null
          const schedule = deriveFromVersion(versionTitle)
          if (schedule.at !== null && schedule.released) plannedAt = schedule.at
        } catch {
          versionTitle = null
        }
      }
      return { ...record, plannedAt, versionTitle, onlineAt: record.group === 'done' ? plannedAt : null }
    }
    if (kind === 'task') {
      const response = await fetch(`${baseUrl}/api/devops/task/detail/${ref}`, { headers })
      const body = await response.json().catch(() => null)
      return { ...empty, ...readRecord('task', body?.data ?? null) }
    }
    if (kind === 'defect') {
      const response = await fetch(`${baseUrl}/api/devops/defect/detail/${ref}`, { headers })
      const body = await response.json().catch(() => null)
      return { ...empty, ...readRecord('defect', body?.data ?? null) }
    }
    const resolved = await resolveDevopsTitle(ref, credentials).catch(() => null)
    return { ...empty, title: resolved?.title ?? '' }
  } catch {
    return empty
  }
}

/**
 * 批量取记录状态。缓存 10 分钟：状态变化要能很快看到，但不必每次刷新都问平台。
 */
async function handleRecords(ctx, request) {
  try {
    const body = await request.json()
    const requested = Array.isArray(body?.refs) ? body.refs.filter((ref) => typeof ref === 'string' && ref !== '') : []
    const credentials = loadDevopsCredentials()
    const cache = await readJson(RECORDS_PATH, {})
    const entries = cache.records !== null && typeof cache.records === 'object' && cache.records !== undefined ? cache.records : {}

    const records = {}
    const now = Date.now()
    let fetched = 0
    for (const ref of [...new Set(requested)]) {
      const hit = entries[ref]
      const url = urlOfRef(credentials.baseUrl, ref)
      if (hit !== undefined && typeof hit.at === 'number' && now - hit.at < RECORD_TTL_MS) {
        records[ref] = { ...hit, url, at: undefined }
        continue
      }
      if (credentials.token === '') {
        records[ref] = { title: '', version: null, statusCode: '', statusLabel: '', group: 'unknown', schedule: null, onlineAt: null, plannedAt: null, versionTitle: null, url }
        continue
      }
      let record
      try {
        record = await fetchRecord(ref, credentials, credentials.baseUrl)
        fetched += 1
      } catch {
        record = { title: '', version: null, statusCode: '', statusLabel: '', group: 'unknown', schedule: null, onlineAt: null, plannedAt: null, versionTitle: null }
      }
      entries[ref] = { ...record, at: now }
      records[ref] = { ...record, url }
    }

    if (fetched > 0) await writeJson(RECORDS_PATH, { version: 3, records: entries })
    return json({ ok: true, records, fetched, hasCredential: credentials.token !== '' })
  } catch (error) {
    ctx.logger?.warn?.(`workbench: records route failed: ${error instanceof Error ? error.message : String(error)}`)
    return json({ ok: false, error: 'records route failed' }, 500)
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
