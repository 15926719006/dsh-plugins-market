import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildImportedTranscript,
  createStore,
  flattenEntries,
  keywordsOf,
  localMinute,
  recordIdOf,
  renderTranscriptMd,
  safeFilename,
} from '../src/host/store.js'

const sampleTranscript = {
  source: 'auto',
  blocks: [
    { index: 0, startMs: 0, endMs: 20000, entries: [
      { speaker: 'them', startMs: 1200, text: '今天先过一下上周的进度。' },
      { speaker: 'me', startMs: 6400, text: '我这边先说一下收银台那条线。' },
    ] },
    { index: 1, startMs: 20000, endMs: 40000, entries: [
      { speaker: 'them', startMs: 500, text: '下周给一版时间点。' },
    ] },
  ],
}

test('档案 id 与时间格式', () => {
  const date = new Date(2026, 10, 26, 10, 42, 30)
  assert.equal(recordIdOf(date), '20261126-104230')
  assert.equal(localMinute(date), '2026-11-26 10:42')
})

test('摊平条目时累加块起点', () => {
  const entries = flattenEntries(sampleTranscript)
  assert.equal(entries.length, 3)
  assert.equal(entries[0].startMs, 1200)
  assert.equal(entries[1].startMs, 6400)
  assert.equal(entries[2].startMs, 20500)
  assert.equal(entries[2].speaker, 'them')
})

test('原文 Markdown 带时间轴与说话人', () => {
  const md = renderTranscriptMd({ title: '产品周会', startedAt: '2026-11-26T02:42:30.000Z', durationMs: 40_000, whisperModel: 'ggml-large-v3-turbo.bin' }, sampleTranscript)
  assert.match(md, /^# 原文 · 产品周会/u)
  assert.match(md, /- 时长：00:40/u)
  assert.match(md, /\[00:01\] 对方：今天先过一下上周的进度。/u)
  assert.match(md, /\[00:06\] 我：我这边先说一下收银台那条线。/u)
  assert.match(md, /\[00:20\] 对方：下周给一版时间点。/u)
})

test('空原文有兜底文案', () => {
  const md = renderTranscriptMd({ title: '空会' }, { source: 'auto', blocks: [] })
  assert.match(md, /没有识别到语音/u)
})

test('导入文本按行变成 note，不猜说话人', () => {
  const transcript = buildImportedTranscript('00:01 张三：先说需求\n\n00:20 李四：我排一下\n')
  assert.equal(transcript.source, 'imported')
  assert.equal(transcript.blocks[0].entries.length, 2)
  assert.equal(transcript.blocks[0].entries[0].speaker, 'note')
  assert.equal(flattenEntries(transcript)[1].text, '00:20 李四：我排一下')
})

test('关键词串包含标题、摘要与原文', () => {
  const keywords = keywordsOf({ title: '周会', summary: '排期' }, sampleTranscript)
  assert.match(keywords, /周会/u)
  assert.match(keywords, /排期/u)
  assert.match(keywords, /收银台/u)
})

test('文件名清洗', () => {
  assert.equal(safeFilename('收银台/退款:讨论'), '收银台_退款_讨论')
  assert.equal(safeFilename(''), '未命名会议')
})

test('档案库完整读写一轮', async () => {
  const root = await mkdtemp(join(tmpdir(), 'meeting-store-'))
  const store = createStore({ root })
  const id = recordIdOf(new Date(2026, 10, 26, 10, 42, 30))
  const meta = await store.createRecord({ id, title: '产品周会', startedAt: new Date(), whisperModel: 'm.bin' })
  assert.equal(meta.status, 'recording')

  await store.appendBlock(id, sampleTranscript.blocks[0])
  await store.appendBlock(id, sampleTranscript.blocks[1])
  const transcript = await store.readTranscript(id)
  assert.equal(transcript.blocks.length, 2)

  await store.writeMinutes(id, '# 周会\n\n> 摘要：聊了排期。\n')
  await store.patchMeta(id, { status: 'ready', durationMs: 40_000, summary: '聊了排期。' })

  const records = await store.listRecords()
  assert.equal(records.length, 1)
  assert.equal(records[0].title, '产品周会')
  assert.equal(records[0].status, 'ready')
  assert.match(records[0].keywords, /收银台/u)

  const detail = await store.detail(id)
  assert.equal(detail.minutes, '# 周会\n\n> 摘要：聊了排期。\n')
  assert.equal(detail.autoTranscriptAvailable, false)

  const exported = await store.exportMarkdown(id, 'transcript')
  assert.equal(exported.filename, '产品周会-原文.md')
  assert.match(exported.markdown, /时间轴/u)

  // 导入官方转写：自动版必须留底。
  await store.importTranscript(id, '张三：先说需求\n李四：我排一下')
  const after = await store.readTranscript(id)
  assert.equal(after.source, 'imported')
  assert.equal((await store.detail(id)).autoTranscriptAvailable, true)
  assert.equal((await store.readMeta(id)).transcriptSource, 'imported')

  await store.removeRecord(id)
  assert.equal((await store.listRecords()).length, 0)
})
