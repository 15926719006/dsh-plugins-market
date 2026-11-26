/**
 * 录音编排（Host 侧状态机）
 *
 * 一次录制就是「采集器写 WAV → Host 每 20 秒切一块 → 左右声道分别本机转写 →
 * 追加原文 → 停止后归档并生成纪要」。这里不碰 HTTP，也不碰 UI。
 *
 * 关键点：
 * - DSH 必须开着；采集器是子进程，父进程被强杀时它自己会收尾退出。
 * - 采集器每 5 秒重写 WAV 头，Host 每次切块前再兜一次，所以录音随时可播放。
 * - 停止后归档在后台跑（转写 → 纪要 → m4a），不阻塞页面。
 * - DSH 崩溃留下的 `recording` 档案由 `recover()` 补完，音频不丢。
 */
import { execFile } from 'node:child_process'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BYTES_PER_SAMPLE,
  FRAME_BYTES,
  SAMPLE_RATE,
  channelOf,
  fixHeader,
  formatClock,
  framesOfFile,
  framesToMs,
  peakOf,
  readFrames,
  speechWindow,
  wrapMonoWav,
} from './wav.js'
import { flattenEntries, localMinute, recordIdOf } from './store.js'
import { generateMinutes } from './minutes.js'

/** 一块 20 秒：说话人的停顿基本落在块内，延迟也可以接受。 */
export const BLOCK_SECONDS = 20

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error !== null) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 一块里声道峰值的下限：低于它就当没说话，省一次 whisper。 */
const SILENCE_PEAK = 0.004

/**
 * @param {{
 *   ctx: any,
 *   config: object,
 *   store: any,
 *   whisper: any,
 *   capture: any,
 *   log: (message: string) => void,
 * }} options
 */
export function createRecorder({ ctx, config, store, whisper, capture, log }) {
  /** 正在录（或正在收停止）的那一场。 */
  let current = null
  /** 后台收尾中的档案：id → { phase }。 */
  const finalizing = new Map()
  /** 按块缓存的帧数。 */
  const blockFrames = () => Math.round((config.chunkSeconds ?? BLOCK_SECONDS) * SAMPLE_RATE)

  const logIt = (message) => {
    try {
      log(message)
    } catch {
      // 日志失败不影响录音。
    }
  }

  const helperPath = () => join(store.root, 'bin', 'dsh-meeting-capture')
  const sourcePath = () => new URL('../../helper/capture.swift', import.meta.url).pathname

  async function ensureHelper() {
    return capture.compileCapture({
      srcPath: sourcePath(),
      cacheDir: join(store.root, 'bin'),
      log: logIt,
    })
  }

  function publicRecording() {
    if (current === null) return null
    return {
      id: current.id,
      title: current.title,
      startedAt: current.startedAt,
      elapsedMs: current.elapsedMs,
      status: current.phase === 'preparing' ? 'preparing' : 'recording',
      blocks: current.blockIndex,
      micPeak: current.micPeak,
      systemPeak: current.systemPeak,
    }
  }

  function liveEntries() {
    if (current === null) return []
    return current.entries.slice(-80)
  }

  async function state() {
    const setup = await whisper.state()
    return {
      recording: publicRecording(),
      live: { entries: liveEntries(), blocks: current?.blockIndex ?? 0 },
      finalizing: [...finalizing.entries()].map(([id, value]) => ({ id, phase: value.phase })),
      setup,
      config: {
        recordsRoot: store.root,
        chunkSeconds: config.chunkSeconds ?? BLOCK_SECONDS,
        language: config.language ?? 'zh',
        keepWav: config.keepWav === true,
        whisperModel: whisper.modelName(),
        minutesProvider: config.minutesProvider ?? null,
        minutesModel: config.minutesModel ?? null,
      },
    }
  }

  /** 把 [fromFrame, toFrame) 这一块转写成结构化条目。 */
  async function transcribeRange(wavPath, fromFrame, toFrame, index) {
    const pcm = await readFrames(wavPath, fromFrame, toFrame)
    if (pcm.length === 0) return { index, startMs: framesToMs(fromFrame), endMs: framesToMs(toFrame), entries: [] }
    const workDir = join(store.root, 'tmp')
    await mkdir(workDir, { recursive: true })
    // 名字带随机后缀：pump 与 finalize 可能同时切同一块，不能互相删临时文件。
    const tag = `${index}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const micPath = join(workDir, `block-${tag}-me.wav`)
    const systemPath = join(workDir, `block-${tag}-them.wav`)
    const micPcm = channelOf(pcm, 0)
    const systemPcm = channelOf(pcm, 1)
    const options = { language: config.language ?? 'zh', prompt: config.vocabulary ?? '' }
    const entries = []
    /** 掐掉块首尾静音后转写，再把偏移加回去：时间轴更准，也少掉静音幻觉。 */
    const transcribeChannel = async (mono, speaker, filePath) => {
      const window = speechWindow(mono)
      if (window === null) return
      const trimmed = mono.subarray(window.startFrame * BYTES_PER_SAMPLE, window.endFrame * BYTES_PER_SAMPLE)
      if (peakOf(trimmed) < SILENCE_PEAK) return
      await import('node:fs/promises').then((fs) => fs.writeFile(filePath, wrapMonoWav(trimmed)))
      const result = await whisper.transcribe(filePath, options)
      const offset = framesToMs(window.startFrame)
      for (const entry of result.entries) entries.push({ speaker, startMs: offset + entry.startMs, text: entry.text })
    }
    try {
      await transcribeChannel(micPcm, 'me', micPath)
      await transcribeChannel(systemPcm, 'them', systemPath)
    } finally {
      await rm(micPath, { force: true })
      await rm(systemPath, { force: true })
    }
    entries.sort((a, b) => a.startMs - b.startMs)
    return { index, startMs: framesToMs(fromFrame), endMs: framesToMs(toFrame), entries }
  }

  /** 录音中：把已经写满的块追上去。 */
  async function pump() {
    const session = current
    if (session === null || session.busy || session.phase !== 'recording') return
    session.busy = true
    try {
      const wavPath = store.paths(session.id).wav
      const fixed = await fixHeader(wavPath)
      if (fixed === null) return
      session.elapsedMs = framesToMs(fixed.frames)
      const per = blockFrames()
      const available = Math.floor(fixed.frames / per)
      // 一次最多追三块，别让一轮 tick 拖太久。
      for (let i = 0; i < 3 && session.blockIndex < available; i += 1) {
        const index = session.blockIndex
        const block = await transcribeRange(wavPath, index * per, (index + 1) * per, index)
        // 转写期间用户可能已经点了停止：停止后的补块交给 finalize，这里不再写。
        if (current !== session) return
        await store.appendBlock(session.id, block)
        session.blockIndex = index + 1
        for (const entry of block.entries) {
          session.entries.push({ speaker: entry.speaker, startMs: block.startMs + entry.startMs, text: entry.text })
        }
        if (session.entries.length > 400) session.entries = session.entries.slice(-200)
      }
    } catch (error) {
      logIt(`pump failed: ${error?.message ?? error}`)
      session.failures += 1
      if (session.failures >= 5) throw error
    } finally {
      session.busy = false
    }
  }

  /** 开始一场会。 */
  async function start({ title } = {}) {
    if (current !== null) {
      const error = new Error('已经在录另一场了')
      error.code = 'busy'
      throw error
    }
    const setup = await whisper.state()
    if (!setup.ready) {
      const error = new Error(setup.binary.ok ? '语音模型还没准备好' : 'whisper.cpp 还没准备好')
      error.code = 'setup'
      throw error
    }
    const id = recordIdOf()
    const startedAt = new Date()
    const finalTitle = typeof title === 'string' && title.trim() !== '' ? title.trim() : `会议 ${localMinute(startedAt)}`
    current = {
      id,
      title: finalTitle,
      startedAt: startedAt.toISOString(),
      phase: 'preparing',
      entries: [],
      blockIndex: 0,
      elapsedMs: 0,
      busy: false,
      failures: 0,
      micPeak: 0,
      systemPeak: 0,
      helper: null,
      timer: null,
    }
    let helper = null
    try {
      const binPath = await ensureHelper()
      const view = await store.ensureRecordDirs(id)
      await store.createRecord({ id, title: finalTitle, startedAt, whisperModel: whisper.modelName(), language: config.language ?? 'zh' })
      const started = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('采集器启动超时')), 8000)
        helper = capture.startCapture({
          binPath,
          outPath: view.wav,
          onEvent: (event) => {
            if (event?.event === 'started') {
              clearTimeout(timeout)
              resolve(event)
            } else if (event?.event === 'level') {
              if (current !== null) {
                current.micPeak = Number(event.mic ?? 0)
                current.systemPeak = Number(event.system ?? 0)
              }
            } else if (event?.event === 'error') {
              logIt(`capture error: ${event.message}`)
            }
          },
          onStderr: (line) => logIt(`capture stderr: ${line}`),
        })
        helper.child?.once?.('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        helper.child?.once?.('exit', (code) => {
          if (current !== null && current.phase === 'recording') logIt(`capture exited early: ${code}`)
        })
      })
      logIt(`capture started: ${JSON.stringify(started)}`)
      current.helper = helper
      current.phase = 'recording'
      current.timer = setInterval(() => {
        pump().catch((error) => logIt(`pump: ${error?.message ?? error}`))
      }, 2000)
      return { id }
    } catch (error) {
      if (helper !== null) await helper.stop?.().catch(() => {})
      current = null
      await store.removeRecord(id).catch(() => {})
      throw error
    }
  }

  /** 停止并交给后台收尾。 */
  async function stop() {
    if (current === null) {
      const error = new Error('当前没有在录音')
      error.code = 'idle'
      throw error
    }
    const session = current
    // 先挡住 pump：后面的补块由 finalize 一次做完。
    session.phase = 'stopping'
    current = null
    if (session.timer !== null) clearInterval(session.timer)
    if (session.helper !== null) await session.helper.stop?.().catch(() => {})
    // 等正在跑的那一轮 pump 落地（最多 15 秒），避免同一块被 pump 与 finalize 各转一遍。
    const deadline = Date.now() + 15000
    while (session.busy && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
    const wavPath = store.paths(session.id).wav
    const fixed = await fixHeader(wavPath)
    const totalFrames = fixed?.frames ?? 0
    await store.patchMeta(session.id, {
      status: 'transcribing',
      durationMs: framesToMs(totalFrames),
      endedAt: new Date().toISOString(),
    })
    const task = finalize({ id: session.id, totalFrames, blockIndex: session.blockIndex }).catch((error) => {
      logIt(`finalize failed: ${error?.message ?? error}`)
    })
    void task
    return { id: session.id, status: 'transcribing' }
  }

  /** 放弃这场：删采集器进程与档案。 */
  async function cancel() {
    if (current === null) {
      const error = new Error('当前没有在录音')
      error.code = 'idle'
      throw error
    }
    const session = current
    current = null
    if (session.timer !== null) clearInterval(session.timer)
    if (session.helper !== null) await session.helper.stop?.().catch(() => {})
    await store.removeRecord(session.id).catch(() => {})
    return { ok: true }
  }

  /** 把剩下的块转写掉、生成纪要、归档。 */
  async function finalize({ id, totalFrames, blockIndex }) {
    finalizing.set(id, { phase: 'transcribing' })
    const wavPath = store.paths(id).wav
    try {
      if (await exists(wavPath)) {
        const fixed = await fixHeader(wavPath)
        const frames = fixed?.frames ?? totalFrames
        const per = blockFrames()
        const available = Math.floor(frames / per)
        for (let index = blockIndex; index < available; index += 1) {
          const block = await transcribeRange(wavPath, index * per, (index + 1) * per, index)
          await store.appendBlock(id, block)
        }
        // 尾巴不足一块但够 1 秒，也转掉，别把最后一句丢了。
        const tailStart = available * per
        const tailFrames = frames - tailStart
        if (tailFrames > SAMPLE_RATE) {
          const block = await transcribeRange(wavPath, tailStart, frames, available)
          await store.appendBlock(id, block)
        }
        await store.patchMeta(id, { durationMs: framesToMs(frames), endedAt: new Date().toISOString() })
      }
      finalizing.set(id, { phase: 'generating' })
      await store.patchMeta(id, { status: 'generating' })
      const meta = await store.readMeta(id)
      const transcript = await store.readTranscript(id)
      const hasText = flattenEntries(transcript).length > 0
      if (!hasText) {
        await store.writeMinutes(id, '# 没有识别到语音\n\n这场会没有识别到可用的语音内容（麦克风和系统声音都是静音）。\n')
        await store.patchMeta(id, { status: 'ready', summary: '没有识别到语音', error: 'no-speech' })
      } else {
        const result = await generateMinutes({ ctx, meta, transcript, config })
        await store.writeMinutes(id, result.markdown)
        await store.patchMeta(id, {
          status: 'ready',
          title: meta.title === undefined || /^会议 \d/u.test(meta.title) ? result.title : meta.title,
          summary: result.summary,
          minutesModel: result.model,
          error: null,
        })
      }
      finalizing.set(id, { phase: 'archiving' })
      await archiveAudio(id)
    } catch (error) {
      logIt(`finalize ${id}: ${error?.stack ?? error}`)
      await store.patchMeta(id, { status: 'failed', error: String(error?.message ?? error) }).catch(() => {})
    } finally {
      finalizing.delete(id)
    }
    return { id }
  }

  /** WAV → m4a，省 6 倍空间；没 ffmpeg 就保留 wav。 */
  async function archiveAudio(id) {
    const view = store.paths(id)
    if (!(await exists(view.wav))) return
    try {
      await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', view.wav, '-c:a', 'aac', '-b:a', '96k', view.m4a])
      if (config.keepWav !== true) await rm(view.wav, { force: true })
    } catch {
      // 转码失败就把 wav 留着，原档更重要。
    }
    await rm(view.tmp, { recursive: true, force: true }).catch(() => {})
  }

  /** 补完一场中途断掉的录制（DSH 被强杀、或点了补完）。 */
  async function recover(id) {
    if (finalizing.has(id)) return { id, status: 'busy' }
    const meta = await store.readMeta(id)
    if (meta === null) {
      const error = new Error('档案不存在')
      error.code = 'missing'
      throw error
    }
    const setup = await whisper.state()
    if (!setup.ready) {
      const error = new Error('语音模型还没准备好')
      error.code = 'setup'
      throw error
    }
    const wavPath = store.paths(id).wav
    const transcript = await store.readTranscript(id)
    const frames = (await exists(wavPath)) ? framesOfFile((await stat(wavPath)).size) : 0
    await store.patchMeta(id, { status: 'transcribing' })
    const task = finalize({ id, totalFrames: frames, blockIndex: transcript.blocks.length })
      .catch((error) => logIt(`recover failed: ${error?.message ?? error}`))
    void task
    return { id, status: 'transcribing' }
  }

  /** 插件启动时：把上一个进程留下的「录制中」标成中断，等用户点补完。 */
  async function markInterrupted() {
    for (const record of await store.recoverable()) {
      if (record.status !== 'recording') continue
      await store.patchMeta(record.id, { status: 'interrupted', error: 'DSH 在录制中被关闭' }).catch(() => {})
    }
  }

  return {
    state,
    start,
    stop,
    cancel,
    recover,
    markInterrupted,
    get blockFrames() {
      return blockFrames()
    },
    formatClock,
  }
}
