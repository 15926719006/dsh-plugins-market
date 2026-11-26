/**
 * 会议纪要（Host 侧）
 *
 * 一场会的生命周期：`POST /start` 起采集器 → 每 20 秒切块本机转写 → `POST /stop`
 * 后转写尾巴、生成纪要、归档成 m4a。所有档案在 `~/.dsh/meeting-notes/records/<id>/`，
 * 音频从不上传；只有生成纪要时，原文文字会发给 DSH 当前模型。
 *
 * 前端只跟这组路由说话（见 README「接口」一节）。
 */
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { DEFAULT_ROOT, createStore, readJson, safeFilename, writeJson } from './src/host/store.js'
import { createWhisper } from './src/host/whisper.js'
import { createRecorder } from './src/host/recorder.js'
import * as capture from './src/host/capture.js'
import { generateMinutes } from './src/host/minutes.js'

/** Cordis 插件名。 */
export const name = 'meeting-notes'

/** 需要 Host 的浏览器通道、模型服务、默认模型选择。 */
export const inject = ['connection', 'llm', 'agentDefaultModel']

const BASE = '/api/meeting-notes'
const CONFIG_PATH = join(DEFAULT_ROOT, 'config.json')

/** 配置默认值；`config.json` 里只写想改的字段。 */
const DEFAULT_CONFIG = {
  whisperBin: null,
  whisperModel: null,
  modelMirror: null,
  language: 'zh',
  chunkSeconds: 20,
  keepWav: false,
  vocabulary: '',
  minutesProvider: null,
  minutesModel: null,
}

/** JSON 响应。 */
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function badRequest(message, code = null) {
  return json({ ok: false, error: message, code }, 400)
}

function queryOf(request) {
  return new URL(request.url).searchParams
}

async function bodyOf(request) {
  try {
    return (await request.json()) ?? {}
  } catch {
    return {}
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export function apply(ctx) {
  const store = createStore({ root: DEFAULT_ROOT })
  // whisper 持有这份可变配置；读到 config.json 后原地补齐。
  const settings = { ...DEFAULT_CONFIG }
  const whisper = createWhisper({ root: DEFAULT_ROOT, config: settings })
  const logger = (message) => {
    void store.logLine(`[host] ${message}`)
  }
  const recorder = createRecorder({ ctx, config: settings, store, whisper, capture, log: logger })

  let configReady = null
  const ensureConfig = () => {
    if (configReady === null) {
      configReady = readJson(CONFIG_PATH, {}).then(async (raw) => {
        for (const [key, value] of Object.entries(raw ?? {})) {
          if (key in DEFAULT_CONFIG) settings[key] = value
        }
        // 配置不合法时回到默认值，别让一场录音因为一个手滑打不开。
        if (!Number.isFinite(settings.chunkSeconds) || settings.chunkSeconds < 5) settings.chunkSeconds = DEFAULT_CONFIG.chunkSeconds
        await store.logLine(`[host] config loaded: ${JSON.stringify(settings)}`)
      })
    }
    return configReady
  }

  // 启动时把上一个进程残留的「录制中」标成中断（等用户点补完，音频不丢）。
  ctx.effect(() => {
    void ensureConfig().then(() => recorder.markInterrupted()).catch(() => {})
    return () => {}
  }, 'meeting-notes: recover stale')

  const route = (path, methods, handler) => {
    ctx.effect(
      () =>
        ctx.connection.fetch.register({
          path: `${BASE}${path}`,
          methods,
          requestBody: 'buffered',
          fetch: (request) => handler(request),
        }),
      `meeting-notes: ${path}`,
    )
  }

  route('/state', ['GET'], async () => {
    await ensureConfig()
    return json(await recorder.state())
  })

  route('/config', ['GET', 'POST'], async (request) => {
    await ensureConfig()
    if (request.method === 'GET') return json({ ok: true, config: settings })
    const body = await bodyOf(request)
    const next = { ...settings }
    for (const [key, value] of Object.entries(body ?? {})) {
      if (!(key in DEFAULT_CONFIG)) continue
      if (key === 'chunkSeconds') {
        if (Number.isFinite(value) && value >= 5 && value <= 300) next[key] = Math.round(value)
        continue
      }
      if (value === null || typeof value === 'string' || typeof value === 'boolean') next[key] = value
    }
    Object.assign(settings, next)
    await mkdir(DEFAULT_ROOT, { recursive: true })
    await writeJson(CONFIG_PATH, settings)
    await store.logLine(`[host] config saved: ${JSON.stringify(settings)}`)
    return json({ ok: true, config: settings })
  })

  route('/start', ['POST'], async (request) => {
    await ensureConfig()
    const body = await bodyOf(request)
    try {
      const result = await recorder.start({ title: typeof body.title === 'string' ? body.title : '' })
      await store.logLine(`[host] recording started: ${result.id}`)
      return json({ ok: true, ...result })
    } catch (error) {
      logger(`start failed: ${error?.stack ?? error}`)
      return badRequest(String(error?.message ?? error), error?.code ?? null)
    }
  })

  route('/stop', ['POST'], async () => {
    await ensureConfig()
    try {
      const result = await recorder.stop()
      await store.logLine(`[host] recording stopped: ${result.id}`)
      return json({ ok: true, ...result })
    } catch (error) {
      return badRequest(String(error?.message ?? error), error?.code ?? null)
    }
  })

  route('/cancel', ['POST'], async () => {
    try {
      const result = await recorder.cancel()
      return json({ ok: true, ...result })
    } catch (error) {
      return badRequest(String(error?.message ?? error), error?.code ?? null)
    }
  })

  route('/list', ['GET'], async () => {
    await ensureConfig()
    const records = await store.listRecords()
    return json({ ok: true, records: records.map(({ keywords, ...rest }) => ({ ...rest, keywords })) })
  })

  route('/record', ['GET', 'DELETE'], async (request) => {
    await ensureConfig()
    const id = queryOf(request).get('id') ?? ''
    if (id === '') return badRequest('id is required')
    if (request.method === 'DELETE') {
      await store.removeRecord(id)
      return json({ ok: true })
    }
    const detail = await store.detail(id)
    if (detail === null) return badRequest('档案不存在', 'missing')
    return json({ ok: true, ...detail })
  })

  route('/audio', ['GET'], async (request) => {
    const id = queryOf(request).get('id') ?? ''
    if (id === '') return badRequest('id is required')
    const view = store.paths(id)
    const file = (await exists(view.m4a)) ? view.m4a : (await exists(view.wav)) ? view.wav : null
    if (file === null) return badRequest('没有录音文件', 'missing')
    const size = (await stat(file)).size
    const contentType = file.endsWith('.wav') ? 'audio/wav' : 'audio/mp4'
    const range = request.headers.get('range')
    if (range !== null) {
      const match = /^bytes=(\d*)-(\d*)$/u.exec(range.trim())
      if (match !== null) {
        const start = match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1])
        const end = match[1] === '' || match[2] === '' ? size - 1 : Number(match[2])
        if (start >= size || end < start) {
          return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } })
        }
        const stream = createReadStream(file, { start, end })
        return new Response(Readable.toWeb(stream), {
          status: 206,
          headers: {
            'content-type': contentType,
            'content-length': String(end - start + 1),
            'content-range': `bytes ${start}-${end}/${size}`,
            'accept-ranges': 'bytes',
            'cache-control': 'no-store',
          },
        })
      }
    }
    return new Response(Readable.toWeb(createReadStream(file)), {
      status: 200,
      headers: {
        'content-type': contentType,
        'content-length': String(size),
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      },
    })
  })

  route('/rename', ['POST'], async (request) => {
    const body = await bodyOf(request)
    const id = typeof body.id === 'string' ? body.id : ''
    const title = typeof body.title === 'string' ? body.title.trim() : ''
    if (id === '' || title === '') return badRequest('id and title are required')
    const meta = await store.readMeta(id)
    if (meta === null) return badRequest('档案不存在', 'missing')
    await store.patchMeta(id, { title: title.slice(0, 120) })
    return json({ ok: true })
  })

  route('/import', ['POST'], async (request) => {
    const body = await bodyOf(request)
    const id = typeof body.id === 'string' ? body.id : ''
    const text = typeof body.text === 'string' ? body.text : ''
    if (id === '' || text.trim() === '') return badRequest('id and text are required')
    const meta = await store.readMeta(id)
    if (meta === null) return badRequest('档案不存在', 'missing')
    await store.importTranscript(id, text)
    await store.logLine(`[host] transcript imported: ${id}`)
    return json({ ok: true })
  })

  route('/regenerate', ['POST'], async (request) => {
    await ensureConfig()
    const body = await bodyOf(request)
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') return badRequest('id is required')
    const meta = await store.readMeta(id)
    if (meta === null) return badRequest('档案不存在', 'missing')
    void (async () => {
      try {
        await store.patchMeta(id, { status: 'generating', error: null })
        const transcript = await store.readTranscript(id)
        const result = await generateMinutes({ ctx, meta, transcript, config: settings })
        await store.writeMinutes(id, result.markdown)
        await store.patchMeta(id, { status: 'ready', summary: result.summary, minutesModel: result.model, error: null })
      } catch (error) {
        await store.logLine(`[host] regenerate failed: ${error?.stack ?? error}`)
        await store.patchMeta(id, { status: 'failed', error: String(error?.message ?? error) })
      }
    })()
    return json({ ok: true })
  })

  route('/recover', ['POST'], async (request) => {
    await ensureConfig()
    const body = await bodyOf(request)
    const id = typeof body.id === 'string' ? body.id : ''
    if (id === '') return badRequest('id is required')
    try {
      const result = await recorder.recover(id)
      return json({ ok: true, ...result })
    } catch (error) {
      return badRequest(String(error?.message ?? error), error?.code ?? null)
    }
  })

  route('/export', ['GET'], async (request) => {
    const params = queryOf(request)
    const id = params.get('id') ?? ''
    const kind = params.get('kind') === 'transcript' ? 'transcript' : 'minutes'
    if (id === '') return badRequest('id is required')
    const exported = await store.exportMarkdown(id, kind)
    if (exported === null) return badRequest('档案不存在', 'missing')
    return new Response(exported.markdown, {
      status: 200,
      headers: {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(exported.filename)}`,
        'cache-control': 'no-store',
      },
    })
  })

  route('/setup', ['POST'], async (request) => {
    await ensureConfig()
    const body = await bodyOf(request)
    const action = typeof body.action === 'string' ? body.action : ''
    if (action === 'install-binary') {
      void whisper.installBinary().catch((error) => store.logLine(`[host] install failed: ${error?.stack ?? error}`))
      return json({ ok: true, action })
    }
    if (action === 'download-model') {
      void whisper.downloadModel(typeof body.model === 'string' ? body.model : undefined).catch((error) => store.logLine(`[host] download failed: ${error?.stack ?? error}`))
      return json({ ok: true, action })
    }
    return badRequest('unknown action')
  })

  route('/log', ['POST'], async (request) => {
    const body = await bodyOf(request)
    const label = typeof body.label === 'string' ? body.label : 'client'
    const message = typeof body.message === 'string' ? body.message : ''
    await store.logLine(`[client:${label}] ${message}`)
    return json({ ok: true })
  })

  // 启动日志：排障时一眼看出插件挂上了什么。
  void store.logLine(`[host] meeting-notes loaded (root=${DEFAULT_ROOT})`)
}
