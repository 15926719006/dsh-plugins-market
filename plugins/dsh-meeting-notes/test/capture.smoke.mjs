/**
 * 采集器真机冒烟（手动跑，不在 `node --test` 里）：
 *
 *   node test/capture.smoke.mjs
 *
 * 会真实编译 helper/capture.swift、录 6 秒（其间播一段 440Hz 测试音），然后检查：
 * 文件是 16kHz 双声道 WAV、时长对得上、系统声声道确实抓到了播放的声音。
 *
 * 放成独立脚本的原因：`node --test` 在本机环境下拿不到被 spawn 子进程的 pipe 数据，
 * 这类「真的起进程」的断言只能普通 `node` 跑。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { compileCapture, startCapture } from '../src/host/capture.js'
import { CHANNELS, FRAME_BYTES, SAMPLE_RATE } from '../src/host/wav.js'

const here = dirname(fileURLToPath(import.meta.url))
const srcPath = join(here, '..', 'helper', 'capture.swift')
const dir = await mkdtemp(join(tmpdir(), 'mn-capture-smoke-'))
const outPath = join(dir, 'audio.wav')

console.log('编译采集器…')
const binPath = await compileCapture({ srcPath, cacheDir: join(dir, 'bin'), log: (line) => console.log(`[compile] ${line}`) })

const events = []
const { stop } = startCapture({
  binPath,
  outPath,
  onEvent: (event) => events.push(event),
  onStderr: (line) => console.log(`[stderr] ${line.slice(0, 160)}`),
})
console.log('开始录 6 秒，同时播测试音…')

execFile('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ar', '48000', '-ac', '2', join(dir, 'tone.wav')], (error) => {
  if (error === null) execFile('afplay', [join(dir, 'tone.wav')])
})
await new Promise((resolve) => setTimeout(resolve, 6000))
const code = await stop()

const raw = await readFile(outPath)
const rate = raw.readUInt32LE(24)
const channels = raw.readUInt16LE(22)
const bits = raw.readUInt16LE(34)
const frames = Math.floor((raw.length - 44) / FRAME_BYTES)
let micPeak = 0
let systemPeak = 0
for (let i = 0; i < frames; i += 1) {
  const left = Math.abs(raw.readInt16LE(44 + i * 4))
  const right = Math.abs(raw.readInt16LE(44 + i * 4 + 2))
  if (left > micPeak) micPeak = left
  if (right > systemPeak) systemPeak = right
}

let failed = 0
const check = (ok, label) => {
  console.log(ok ? `✅ ${label}` : `❌ ${label}`)
  if (!ok) failed += 1
}
check(code === 0, `采集器正常退出（code=${code}）`)
check(raw.subarray(0, 4).toString() === 'RIFF', 'WAV 头合法')
check(rate === SAMPLE_RATE, `采样率 ${rate}Hz`)
check(channels === CHANNELS, `声道数 ${channels}`)
check(bits === 16, `位深 ${bits}`)
check(frames > SAMPLE_RATE * 5, `录到 ${(frames / SAMPLE_RATE).toFixed(2)} 秒（>5 秒）`)
check(systemPeak / 32768 > 0.001, `系统声轨抓到了测试音（peak=${(systemPeak / 32768).toFixed(4)}）`)
check(events.some((event) => event.event === 'started'), '收到 started 事件')
check(events.some((event) => event.event === 'stopped'), '收到 stopped 事件')
check(events.some((event) => event.event === 'level' && Number(event.system) > 0), '收到带系统声音量的 level 事件')

console.log(failed === 0 ? `\nSMOKE_OK（录音文件：${outPath}）` : `\nSMOKE_FAIL(${failed})`)
process.exit(failed === 0 ? 0 : 1)
