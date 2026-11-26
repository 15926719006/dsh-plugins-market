/**
 * 本机转写：whisper.cpp（`whisper-cli`）与语音模型
 *
 * 两条准备线各自独立：可执行文件（brew 装）和模型文件（下载一次，约 1.6GB）。
 * 录音与转写全程在本机，任何音频都不上传。
 */
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** 默认模型：large-v3-turbo，中文标点与中英混说最稳，M4 上跑得动。 */
export const DEFAULT_MODEL = 'ggml-large-v3-turbo.bin'
export const MODEL_REPO = 'ggerganov/whisper.cpp'
/** 小于这个字节数说明下载被截断，不算准备好。 */
const MODEL_MIN_BYTES = 100 * 1024 * 1024
/** 常见安装位置，省得每次都去问 PATH。 */
const BINARY_CANDIDATES = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', join('/opt/homebrew/bin', 'whisper-cpp')]

/**
 * whisper 在静音/噪声段上会输出固定的「幻觉」句子（训练数据里反复出现的字幕尾巴）。
 * 这些不是会议内容，直接丢掉，否则会污染原文和纪要。
 */
const HALLUCINATION_PATTERNS = [
  /请不吝点赞|訂閱|订阅|转发|打赏|明镜与点点|明鏡與點點/u,
  /字幕由|字幕志愿者|字幕組|字幕组|由.{0,8}字幕/u,
  /谢谢(大家)?(观看|收看)|感谢(观看|收看)|下期再见/u,
  /amara\.org|subtitles by|thanks? for watching|subscribe|transcript provided/iu,
  /字幕由\s*amara/iu,
]

/** 不是人话的片段，丢掉。 */
const NOISE_PATTERNS = [
  /^\[[^\]]*\]$/u,
  /^\([^)]*\)$/u,
  /^（[^）]*）$/u,
  /^\[?BLANK_AUDIO\]?$/iu,
  /^[\s.,，。!！?？~～、…·-]*$/u,
]

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { maxBuffer: 32 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      if (error !== null) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
    child?.stdout?.setEncoding?.('utf8')
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

/** `00:00:12,340` / `01:02:03,000` → 毫秒。 */
export function parseTimestamp(text) {
  const match = /^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/u.exec(String(text ?? '').trim())
  if (match === null) return null
  return Number(match[1]) * 3600000 + Number(match[2]) * 60000 + Number(match[3]) * 1000 + Number(match[4])
}

/** 清掉 whisper 常见的非语音标记与空串。 */
export function cleanSegment(text) {
  const value = String(text ?? '').replace(/\s+/gu, ' ').trim()
  if (value === '') return ''
  for (const pattern of NOISE_PATTERNS) if (pattern.test(value)) return ''
  for (const pattern of HALLUCINATION_PATTERNS) if (pattern.test(value)) return ''
  return value
}

/**
 * 解析 whisper-cli 的 `-oj` 输出。
 * @returns {Array<{ startMs: number, text: string }>}
 */
export function parseWhisperJson(raw) {
  let data
  try {
    data = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return []
  }
  const list = Array.isArray(data?.transcription) ? data.transcription : []
  const entries = []
  for (const item of list) {
    const text = cleanSegment(item?.text)
    if (text === '') continue
    let startMs = Number(item?.offsets?.from)
    if (!Number.isFinite(startMs)) startMs = parseTimestamp(item?.timestamps?.from) ?? 0
    entries.push({ startMs: Math.max(0, Math.round(startMs)), text })
  }
  // 逐块解码偶尔会重复同一句，连续去重即可，别做更激进的合并。
  const deduped = []
  for (const entry of entries) {
    const previous = deduped[deduped.length - 1]
    if (previous !== undefined && previous.text === entry.text) continue
    deduped.push(entry)
  }
  return deduped
}

/**
 * whisper 客户端（一个 Host 进程里一份就够）。
 * @param {{ root: string, config: { whisperBin?: string, whisperModel?: string, modelMirror?: string } }} options
 */
export function createWhisper({ root, config = {} }) {
  const modelsRoot = join(root, 'models')
  let downloading = null
  let installing = null
  let installLog = []
  let compileHint = null

  const modelName = () => {
    const configured = config.whisperModel
    if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
    return DEFAULT_MODEL
  }

  const modelPath = () => {
    const name = modelName()
    if (name.startsWith('/')) return name
    return join(modelsRoot, name)
  }

  const mirror = () => (typeof config.modelMirror === 'string' && config.modelMirror !== '' ? config.modelMirror : 'https://huggingface.co')

  let binaryCache = { path: null, at: 0 }

  async function binaryPath() {
    // UI 每 2 秒轮询一次 /state，别每次都去问 PATH。
    if (Date.now() - binaryCache.at < 30_000) return binaryCache.path
    const remember = (path) => {
      binaryCache = { path, at: Date.now() }
      return path
    }
    if (typeof config.whisperBin === 'string' && config.whisperBin !== '' && (await exists(config.whisperBin))) {
      return remember(config.whisperBin)
    }
    for (const candidate of BINARY_CANDIDATES) if (await exists(candidate)) return remember(candidate)
    try {
      const { stdout } = await execFileAsync('/usr/bin/which', ['whisper-cli'])
      const path = stdout.trim()
      if (path !== '') return remember(path)
    } catch {
      // 没装。
    }
    return remember(null)
  }

  async function state() {
    const binary = await binaryPath()
    const path = modelPath()
    let sizeBytes = 0
    try {
      sizeBytes = (await stat(path)).size
    } catch {
      sizeBytes = 0
    }
    const modelOk = sizeBytes >= MODEL_MIN_BYTES
    return {
      ready: binary !== null && modelOk,
      binary: {
        ok: binary !== null,
        path: binary,
        hint: binary === null ? '需要安装 whisper.cpp：brew install whisper.cpp' : null,
      },
      model: {
        ok: modelOk,
        name: modelName(),
        path,
        sizeBytes,
        downloading: downloading === null ? null : { ...downloading },
      },
      installing: installing === null ? null : { active: installing, log: installLog.slice(-8) },
      language: typeof config.language === 'string' ? config.language : 'zh',
    }
  }

  /** 下载模型（进度写进 state().model.downloading）。已有完整文件就直接返回。 */
  async function downloadModel(name = modelName()) {
    if (downloading !== null) return
    await mkdir(modelsRoot, { recursive: true })
    const target = name.startsWith('/') ? name : join(modelsRoot, name)
    try {
      const { size } = await stat(target)
      if (size >= MODEL_MIN_BYTES) return
    } catch {
      // 还没下。
    }
    const url = `${mirror()}/${MODEL_REPO}/resolve/main/${name}`
    downloading = { received: 0, total: 0, url }
    const part = `${target}.part`
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (!response.ok || response.body === null) throw new Error(`下载失败：HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length') ?? 0)
      downloading.total = Number.isFinite(total) ? total : 0
      const sink = createWriteStream(part)
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value !== undefined) {
            downloading.received += value.byteLength
            if (!sink.write(Buffer.from(value))) await new Promise((resolve) => sink.once('drain', resolve))
          }
        }
      } finally {
        await new Promise((resolve) => sink.end(resolve))
      }
      const { size } = await stat(part)
      if (size < MODEL_MIN_BYTES) throw new Error(`模型文件不完整（${size} 字节）`)
      await rename(part, target)
    } catch (error) {
      await rm(part, { force: true })
      throw error
    } finally {
      downloading = null
    }
  }

  /** 安装 whisper.cpp（brew）。已经有就不动。 */
  async function installBinary() {
    if (installing !== null) return
    if ((await binaryPath()) !== null) return
    installing = 'running'
    installLog = ['brew install whisper.cpp']
    try {
      const brewPath = (await exists('/opt/homebrew/bin/brew')) ? '/opt/homebrew/bin/brew' : '/usr/local/bin/brew'
      const { stdout, stderr } = await execFileAsync(brewPath, ['install', 'whisper.cpp'], { timeout: 20 * 60 * 1000 })
      installLog.push(...`${stdout}\n${stderr}`.split('\n').filter((line) => line.trim() !== '').slice(-12))
      binaryCache = { path: null, at: 0 }
      if ((await binaryPath()) === null) throw new Error('安装完成但找不到 whisper-cli')
    } finally {
      installing = null
    }
  }

  /** 转写一个 wav 文件。 */
  async function transcribe(wavPath, { language = 'zh', prompt = '', threads = 4 } = {}) {
    const binary = await binaryPath()
    if (binary === null) throw new Error('没找到 whisper-cli（brew install whisper.cpp）')
    const model = modelPath()
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const outBase = wavPath.replace(/\.wav$/u, '') || wavPath
    const outputBase = `${outBase}.whisper-${suffix}`
    const args = ['-m', model, '-f', wavPath, '-l', language === '' ? 'auto' : language, '-oj', '-of', outputBase, '-np', '-t', String(threads)]
    if (typeof prompt === 'string' && prompt.trim() !== '') args.push('--prompt', prompt.trim())
    try {
      await execFileAsync(binary, args, { timeout: 10 * 60 * 1000 })
      const raw = await readFile(`${outputBase}.json`, 'utf8')
      return { entries: parseWhisperJson(raw), binary, model }
    } finally {
      await rm(`${outputBase}.json`, { force: true })
      await rm(`${outputBase}.json.txt`, { force: true })
    }
  }

  return {
    modelName,
    modelPath,
    binaryPath,
    state,
    downloadModel,
    installBinary,
    transcribe,
    modelsRoot,
    get compileHint() {
      return compileHint
    },
  }
}
