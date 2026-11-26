import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CHANNELS,
  FRAME_BYTES,
  HEADER_BYTES,
  SAMPLE_RATE,
  buildHeader,
  channelOf,
  fixHeader,
  formatClock,
  framesOfFile,
  framesToMs,
  parseHeader,
  peakOf,
  wrapMonoWav,
} from '../src/host/wav.js'

test('头部组装与解析能对上', () => {
  const header = buildHeader({ dataBytes: 3200 })
  assert.equal(header.length, HEADER_BYTES)
  const parsed = parseHeader(header)
  assert.equal(parsed.sampleRate, SAMPLE_RATE)
  assert.equal(parsed.channels, CHANNELS)
  assert.equal(parsed.bits, 16)
  assert.equal(parsed.dataOffset, HEADER_BYTES)
  assert.equal(parsed.dataBytes, 3200)
})

test('非 WAV 头返回 null', () => {
  assert.equal(parseHeader(Buffer.from('not a wav file at all', 'utf8')), null)
  assert.equal(parseHeader(Buffer.alloc(10)), null)
})

test('帧数按 4 字节一帧算', () => {
  assert.equal(FRAME_BYTES, 4)
  assert.equal(framesOfFile(HEADER_BYTES + 16000 * 4), 16000)
  assert.equal(framesOfFile(HEADER_BYTES), 0)
})

test('拆声道与峰值', () => {
  // 两帧：左 1000/右 -1000，左 2000/右 0
  const pcm = Buffer.alloc(FRAME_BYTES * 2)
  pcm.writeInt16LE(1000, 0)
  pcm.writeInt16LE(-1000, 2)
  pcm.writeInt16LE(2000, 4)
  pcm.writeInt16LE(0, 6)
  const left = channelOf(pcm, 0)
  const right = channelOf(pcm, 1)
  assert.equal(left.readInt16LE(0), 1000)
  assert.equal(left.readInt16LE(2), 2000)
  assert.equal(right.readInt16LE(0), -1000)
  assert.equal(right.readInt16LE(2), 0)
  assert.ok(peakOf(left) > peakOf(right))
  assert.equal(peakOf(Buffer.alloc(8)), 0)
})

test('单声道封装后能再解析', () => {
  const mono = Buffer.alloc(16000 * 2)
  const wav = wrapMonoWav(mono)
  const parsed = parseHeader(wav)
  assert.equal(parsed.channels, 1)
  assert.equal(parsed.sampleRate, SAMPLE_RATE)
  assert.equal(parsed.dataBytes, 32000)
})

test('fixHeader 按文件长度改写两个长度字段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wav-test-'))
  const path = join(dir, 'audio.wav')
  // 头部先写占位大小，后面追加 2 秒数据（采集器就是这个行为）。
  const header = buildHeader({ dataBytes: 0 })
  await writeFile(path, Buffer.concat([header, Buffer.alloc(SAMPLE_RATE * FRAME_BYTES * 2)]))
  const fixed = await fixHeader(path)
  assert.equal(fixed.frames, SAMPLE_RATE * 2)
  const raw = await readFile(path)
  assert.equal(raw.readUInt32LE(4), 36 + SAMPLE_RATE * 2 * FRAME_BYTES)
  assert.equal(raw.readUInt32LE(40), SAMPLE_RATE * 2 * FRAME_BYTES)
})

test('时钟格式', () => {
  assert.equal(formatClock(0), '00:00')
  assert.equal(formatClock(65_000), '01:05')
  assert.equal(formatClock(3_723_000), '1:02:03')
  assert.equal(framesToMs(SAMPLE_RATE), 1000)
})

test('speechWindow 掐掉首尾静音并留出补白', async () => {
  const { speechWindow, SAMPLE_RATE } = await import('../src/host/wav.js')
  const frames = SAMPLE_RATE * 4
  const pcm = Buffer.alloc(frames * 2)
  // 1.0s ~ 2.0s 放一段「声音」
  for (let i = SAMPLE_RATE; i < SAMPLE_RATE * 2; i += 1) pcm.writeInt16LE(8000, i * 2)
  const window = speechWindow(pcm)
  assert.ok(window !== null)
  // 补白 200ms：起点落在 0.8s 附近，终点在 2.2s 附近
  assert.ok(window.startFrame >= SAMPLE_RATE * 0.7 && window.startFrame <= SAMPLE_RATE * 0.9)
  assert.ok(window.endFrame >= SAMPLE_RATE * 2.1 && window.endFrame <= SAMPLE_RATE * 2.3)
  assert.equal(speechWindow(Buffer.alloc(SAMPLE_RATE * 2)), null)
})
