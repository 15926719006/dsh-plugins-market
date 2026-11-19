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

const NOTES_ROUTE = '/api/workbench/notes'
const CONFIG_ROUTE = '/api/workbench/config'
const LOG_ROUTE = '/api/workbench/log'
const LOG_PATH = join(DIR, 'client.log')

/** 旁注里允许写入的字段，其余一律丢弃。 */
const NOTE_FIELDS = ['outcome', 'next', 'status', 'impact', 'note', 'refs']
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
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
    if (sessionId === '') return json({ ok: false, error: 'sessionId is required' }, 400)

    const notes = await readNotes()
    const current = notes[sessionId] !== null && typeof notes[sessionId] === 'object' && notes[sessionId] !== undefined
      ? notes[sessionId]
      : {}
    const patch = cleanPatch(body.patch)
    const next = { ...current, ...patch, sessionId, updatedAt: Date.now(), writtenBy: 'user' }
    notes[sessionId] = next
    await writeJson(NOTES_PATH, { version: 1, notes })
    return json({ ok: true, note: next })
  } catch (error) {
    ctx.logger?.warn?.(`workbench: notes route failed: ${error instanceof Error ? error.message : String(error)}`)
    return json({ ok: false, error: 'notes route failed' }, 500)
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
