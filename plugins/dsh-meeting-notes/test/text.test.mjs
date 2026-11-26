import test from 'node:test'
import assert from 'node:assert/strict'

import { cleanSegment, parseTimestamp, parseWhisperJson } from '../src/host/whisper.js'
import { buildMinutesPrompt, parseMinutes, textOfChunk } from '../src/host/minutes.js'

/** whisper-cli 的 `-oj` 输出（只留用得到的字段）。 */
const whisperJson = JSON.stringify({
  systeminfo: 'whisper.cpp',
  model: { type: 'large-v3-turbo' },
  result: { language: 'zh' },
  transcription: [
    { timestamps: { from: '00:00:00,000', to: '00:00:02,000' }, offsets: { from: 0, to: 2000 }, text: ' 今天先过一下上周的进度。' },
    { timestamps: { from: '00:00:02,000', to: '00:00:04,000' }, offsets: { from: 2000, to: 4000 }, text: ' [BLANK_AUDIO]' },
    { timestamps: { from: '00:00:04,000', to: '00:00:06,000' }, offsets: { from: 4000, to: 6000 }, text: ' 我这边先说一下收银台那条线。' },
    { timestamps: { from: '00:00:06,000', to: '00:00:08,000' }, offsets: { from: 6000, to: 8000 }, text: ' 我这边先说一下收银台那条线。' },
  ],
})

test('时间戳解析', () => {
  assert.equal(parseTimestamp('00:00:12,340'), 12_340)
  assert.equal(parseTimestamp('01:02:03,000'), 3_723_000)
  assert.equal(parseTimestamp('12,5'), null)
})

test('噪声段清空', () => {
  assert.equal(cleanSegment(' 你好 世界 '), '你好 世界')
  assert.equal(cleanSegment('[BLANK_AUDIO]'), '')
  assert.equal(cleanSegment('（音乐）'), '')
  assert.equal(cleanSegment('  ...  '), '')
})

test('whisper JSON 解析：过滤噪声、连续去重、保留时间', () => {
  const entries = parseWhisperJson(whisperJson)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].startMs, 0)
  assert.equal(entries[0].text, '今天先过一下上周的进度。')
  assert.equal(entries[1].startMs, 4000)
})

test('坏 JSON 不抛错', () => {
  assert.deepEqual(parseWhisperJson('{oops'), [])
  assert.deepEqual(parseWhisperJson('{}'), [])
})

test('纪要提示词含模板各节与原文', () => {
  const prompt = buildMinutesPrompt({
    meta: { title: '产品周会', startedAt: '2026-11-26T02:42:30.000Z', durationMs: 40_000 },
    transcript: {
      blocks: [{ index: 0, startMs: 0, endMs: 40_000, entries: [
        { speaker: 'them', startMs: 1200, text: '今天先过一下上周的进度。' },
        { speaker: 'me', startMs: 6400, text: '收银台那条线下周给时间点。' },
      ] }],
    },
  })
  for (const section of ['## 议题与讨论要点', '## 结论与决定', '## 待办', '## 风险与未决', '## 关键原话', '未明确']) {
    assert.ok(prompt.includes(section), `缺少 ${section}`)
  }
  assert.match(prompt, /\[00:01\] 对方：今天先过一下上周的进度。/u)
  assert.match(prompt, /\[00:06\] 我：收银台那条线下周给时间点。/u)
})

test('纪要标题与摘要解析', () => {
  const parsed = parseMinutes('# 收银台线排期会\n> 摘要：确认了退款单的排期，下周给时间点。\n\n## 结论与决定\n- 下周给时间点\n')
  assert.equal(parsed.title, '收银台线排期会')
  assert.equal(parsed.summary, '确认了退款单的排期，下周给时间点。')
  assert.match(parsed.markdown, /^# 收银台线排期会/u)
  assert.ok(parsed.markdown.endsWith('\n'))
})

test('纪要解析兜底：没标题没摘要也能用', () => {
  const parsed = parseMinutes('- 只讨论了一件事\n- 下周继续', '会议 11-26 10:42')
  assert.equal(parsed.title, '会议 11-26 10:42')
  assert.equal(parsed.summary, '- 只讨论了一件事 - 下周继续')
})

test('stream 文本块提取', () => {
  assert.equal(textOfChunk({ type: 'text-delta', index: 0, text: '你好' }), '你好')
  assert.equal(textOfChunk({ type: 'finish' }), '')
  assert.equal(textOfChunk(null), '')
})

test('whisper 在静音上的固定幻觉句被丢掉', () => {
  assert.equal(cleanSegment('请不吝点赞 订阅 转发 打赏支持明镜与点点栏目'), '')
  assert.equal(cleanSegment('字幕由Amara.org社区提供'), '')
  assert.equal(cleanSegment('谢谢大家观看'), '')
  assert.equal(cleanSegment('Thanks for watching!'), '')
  assert.equal(cleanSegment('下周一把时间点发群里'), '下周一把时间点发群里')
})
