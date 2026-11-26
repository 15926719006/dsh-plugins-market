/**
 * 会议档案库
 *
 * 一场会一个目录：`<root>/records/<id>/`
 *   meta.json           会议信息与状态
 *   audio.wav           录制中（2 声道 16k，ch0=我 ch1=对方）
 *   audio.m4a           停止后归档（AAC）
 *   transcript.json     原文（结构化，按块）
 *   transcript.md       原文（人读时间轴）
 *   transcript.auto.*   导入官方转写时，本机自动版留底
 *   minutes.md          纪要
 *
 * 状态机：recording → transcribing → generating → ready；出错 failed；DSH 被强杀留下
 * recording/interrupted，由 `recoverable()` 找出来补完。
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatClock } from './wav.js'

export const DEFAULT_ROOT = join(homedir(), '.dsh', 'meeting-notes')

export const STATUSES = ['recording', 'transcribing', 'generating', 'ready', 'failed', 'interrupted']
/** 这些状态说明档案没做完，需要补。 */
export const UNFINISHED = ['recording', 'transcribing', 'generating', 'interrupted']

/** `20261126-104230`（本地时间）。 */
export function recordIdOf(date = new Date()) {
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

/** `2026-11-26 10:42`（本地时间）。 */
export function localMinute(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 把 blocks 摊平成带绝对时间的条目。 */
export function flattenEntries(transcript) {
  const blocks = Array.isArray(transcript?.blocks) ? transcript.blocks : []
  const out = []
  for (const block of blocks) {
    const base = Number.isFinite(block?.startMs) ? block.startMs : 0
    const entries = Array.isArray(block?.entries) ? block.entries : []
    for (const entry of entries) {
      const text = typeof entry?.text === 'string' ? entry.text.trim() : ''
      if (text === '') continue
      out.push({
        speaker: entry.speaker === 'me' ? 'me' : entry.speaker === 'them' ? 'them' : 'note',
        startMs: base + (Number.isFinite(entry.startMs) ? entry.startMs : 0),
        text,
      })
    }
  }
  return out
}

/** 说话人标签。 */
export function speakerLabel(speaker) {
  if (speaker === 'me') return '我'
  if (speaker === 'them') return '对方'
  return ''
}

/** 原文 Markdown（人读时间轴）。 */
export function renderTranscriptMd(meta, transcript) {
  const entries = flattenEntries(transcript)
  const lines = []
  lines.push(`# 原文 · ${meta?.title ?? '未命名会议'}`)
  lines.push('')
  lines.push(`- 时间：${meta?.startedAt === undefined ? '未知' : localMinute(new Date(meta.startedAt))}`)
  lines.push(`- 时长：${formatClock(meta?.durationMs ?? 0)}`)
  const sourceLabel = meta?.transcriptSource === 'imported'
    ? '导入的官方转写'
    : `本机转写（whisper.cpp / ${meta?.whisperModel ?? '模型'}）`
  lines.push(`- 来源：${sourceLabel}`)
  lines.push('')
  lines.push('## 时间轴')
  lines.push('')
  if (entries.length === 0) {
    lines.push('（没有识别到语音）')
  } else {
    for (const entry of entries) {
      const label = speakerLabel(entry.speaker)
      const prefix = label === '' ? '' : `${label}：`
      lines.push(`[${formatClock(entry.startMs)}] ${prefix}${entry.text}`)
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** 导入的官方转写：整段文本按行拆成 note 条目，不猜说话人。 */
export function buildImportedTranscript(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const entries = lines.map((line) => ({ speaker: 'note', startMs: null, text: line }))
  return {
    source: 'imported',
    blocks: [{ index: 0, startMs: 0, endMs: 0, entries }],
  }
}

/** 列表里给搜索用的关键词串。 */
export function keywordsOf(meta, transcript) {
  const parts = [meta?.title ?? '', meta?.summary ?? '']
  for (const entry of flattenEntries(transcript ?? { blocks: [] }).slice(0, 400)) parts.push(entry.text)
  return parts.join(' ').slice(0, 6000)
}

/** 读 JSON，坏了给兜底。 */
export async function readJson(path, fallback = null) {
  try {
    const text = await readFile(path, 'utf8')
    const parsed = JSON.parse(text)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** 原子写 JSON。 */
export async function writeJson(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 打开一个档案库。
 * @param {{ root?: string }} options
 */
export function createStore({ root = DEFAULT_ROOT } = {}) {
  const recordsRoot = join(root, 'records')

  const paths = (id) => {
    const dir = join(recordsRoot, id)
    return {
      dir,
      dirOf: (name) => join(dir, name),
      meta: join(dir, 'meta.json'),
      transcriptJson: join(dir, 'transcript.json'),
      transcriptMd: join(dir, 'transcript.md'),
      autoJson: join(dir, 'transcript.auto.json'),
      autoMd: join(dir, 'transcript.auto.md'),
      minutes: join(dir, 'minutes.md'),
      wav: join(dir, 'audio.wav'),
      m4a: join(dir, 'audio.m4a'),
      tmp: join(dir, 'tmp'),
    }
  }

  async function ensureRecordDirs(id) {
    const view = paths(id)
    await mkdir(view.dir, { recursive: true })
    await mkdir(view.tmp, { recursive: true })
    return view
  }

  async function readMeta(id) {
    const meta = await readJson(paths(id).meta, null)
    if (meta === null || typeof meta !== 'object') return null
    return { status: 'recording', ...meta }
  }

  async function writeMeta(id, meta) {
    await ensureRecordDirs(id)
    const next = { ...meta, updatedAt: new Date().toISOString() }
    await writeJson(paths(id).meta, next)
    return next
  }

  async function patchMeta(id, patch) {
    const current = (await readMeta(id)) ?? { id }
    return writeMeta(id, { ...current, ...patch })
  }

  async function createRecord({ id, title, startedAt = new Date(), whisperModel, language }) {
    const view = await ensureRecordDirs(id)
    const meta = {
      id,
      title: title?.trim() === '' || title === undefined ? '未命名会议' : title.trim(),
      startedAt: startedAt.toISOString(),
      endedAt: null,
      durationMs: 0,
      status: 'recording',
      transcriptSource: 'auto',
      summary: '',
      whisperModel: whisperModel ?? null,
      language: language ?? 'zh',
      minutesModel: null,
      error: null,
      createdAt: new Date().toISOString(),
    }
    await writeMeta(id, meta)
    await writeJson(view.transcriptJson, { source: 'auto', blocks: [] })
    await writeFile(view.transcriptMd, renderTranscriptMd(meta, { source: 'auto', blocks: [] }), 'utf8')
    return meta
  }

  async function readTranscript(id) {
    const transcript = await readJson(paths(id).transcriptJson, null)
    if (transcript === null || typeof transcript !== 'object' || !Array.isArray(transcript.blocks)) {
      return { source: 'auto', blocks: [] }
    }
    return { source: transcript.source === 'imported' ? 'imported' : 'auto', blocks: transcript.blocks }
  }

  async function saveTranscript(id, transcript) {
    const view = await ensureRecordDirs(id)
    const meta = (await readMeta(id)) ?? { id }
    const next = { source: transcript.source === 'imported' ? 'imported' : 'auto', blocks: transcript.blocks }
    await writeJson(view.transcriptJson, next)
    await writeFile(view.transcriptMd, renderTranscriptMd({ ...meta, transcriptSource: next.source }, next), 'utf8')
    return next
  }

  async function appendBlock(id, block) {
    const transcript = await readTranscript(id)
    transcript.blocks.push(block)
    return saveTranscript(id, transcript)
  }

  async function readMinutes(id) {
    try {
      return await readFile(paths(id).minutes, 'utf8')
    } catch {
      return ''
    }
  }

  async function writeMinutes(id, markdown) {
    const view = await ensureRecordDirs(id)
    await writeFile(view.minutes, markdown, 'utf8')
  }

  async function hasAudio(id) {
    const view = paths(id)
    return (await exists(view.m4a)) || (await exists(view.wav))
  }

  async function summaryOf(id) {
    const meta = await readMeta(id)
    if (meta === null) return null
    const wavPath = paths(id).wav
    const m4aPath = paths(id).m4a
    const audio = (await exists(m4aPath)) ? paths(id).m4a : (await exists(wavPath)) ? wavPath : null
    if (audio !== null && audio.endsWith('audio.wav')) {
      try {
        const { framesOfFile } = await import('./wav.js')
        const { size } = await stat(audio)
        meta.durationMs = Math.max(meta.durationMs ?? 0, Math.round((framesOfFile(size) * 1000) / 16000))
      } catch {
        // 文件可能刚好被归档删掉，忽略。
      }
    }
    const transcript = await readTranscript(id)
    return {
      id,
      title: meta.title,
      startedAt: meta.startedAt,
      endedAt: meta.endedAt,
      durationMs: meta.durationMs ?? 0,
      status: meta.status,
      summary: meta.summary ?? '',
      transcriptSource: meta.transcriptSource === 'imported' ? 'imported' : 'auto',
      hasAudio: audio !== null,
      error: meta.error ?? null,
      keywords: keywordsOf(meta, transcript),
    }
  }

  async function listRecords() {
    let names = []
    try {
      names = (await readdir(recordsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      return []
    }
    const records = []
    for (const name of names.sort().reverse()) {
      const summary = await summaryOf(name)
      if (summary !== null) records.push(summary)
    }
    records.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
    return records
  }

  async function detail(id) {
    const meta = await readMeta(id)
    if (meta === null) return null
    const [transcript, minutes, autoRaw] = await Promise.all([readTranscript(id), readMinutes(id), readJson(paths(id).autoJson, null)])
    const autoTranscript = autoRaw !== null && Array.isArray(autoRaw.blocks)
      ? { source: 'auto', blocks: autoRaw.blocks }
      : null
    return {
      meta,
      minutes,
      transcript,
      autoTranscript,
      autoTranscriptAvailable: autoTranscript !== null,
    }
  }

  async function importTranscript(id, text) {
    const view = await ensureRecordDirs(id)
    const current = await readTranscript(id)
    // 本机自动版留底，导入不覆盖掉原始证据。
    if (current.blocks.length > 0 && !(await exists(view.autoJson))) {
      await writeJson(view.autoJson, current)
      const meta = (await readMeta(id)) ?? { id }
      await writeFile(view.autoMd, renderTranscriptMd({ ...meta, transcriptSource: 'auto' }, current), 'utf8')
    }
    const imported = buildImportedTranscript(text)
    await saveTranscript(id, imported)
    await patchMeta(id, { transcriptSource: 'imported' })
    return imported
  }

  async function exportMarkdown(id, kind) {
    const meta = await readMeta(id)
    if (meta === null) return null
    if (kind === 'transcript') {
      const transcript = await readTranscript(id)
      return { filename: `${safeFilename(meta.title)}-原文.md`, markdown: renderTranscriptMd(meta, transcript) }
    }
    const minutes = await readMinutes(id)
    const header = `# ${meta.title}\n\n- 时间：${localMinute(new Date(meta.startedAt))}\n- 时长：${formatClock(meta.durationMs ?? 0)}\n- 档案：${paths(id).dir}\n\n`
    return { filename: `${safeFilename(meta.title)}-纪要.md`, markdown: minutes === '' ? `${header}（还没有生成纪要）\n` : minutes }
  }

  async function removeRecord(id) {
    await rm(paths(id).dir, { recursive: true, force: true })
  }

  /** 没做完的档案（DSH 被强杀会留下 recording）。 */
  async function recoverable() {
    const records = await listRecords()
    return records.filter((record) => UNFINISHED.includes(record.status))
  }

  async function logLine(message) {
    await mkdir(root, { recursive: true })
    const line = `[${new Date().toISOString()}] ${message}\n`
    try {
      await appendFile(join(root, 'dsh-meeting-notes.log'), line, 'utf8')
    } catch {
      // 日志写不进去也不影响主流程。
    }
  }

  return {
    root,
    recordsRoot,
    paths,
    ensureRecordDirs,
    readMeta,
    writeMeta,
    patchMeta,
    createRecord,
    readTranscript,
    saveTranscript,
    appendBlock,
    readMinutes,
    writeMinutes,
    hasAudio,
    listRecords,
    detail,
    importTranscript,
    exportMarkdown,
    removeRecord,
    recoverable,
    logLine,
  }
}

/** 文件名里不能出现的字符换成下划线。 */
export function safeFilename(name) {
  return String(name ?? '未命名会议').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名会议'
}
