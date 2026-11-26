/**
 * WAV 读写与切块（16kHz / 16bit / 立体声）
 *
 * 采集器写出来的只有一个文件：`audio.wav`，ch0 = 我的麦克风，ch1 = 对方（系统声音）。
 * 两轨同一个时钟、同一个文件，所以「哪句是我说的」不需要任何对齐算法。
 *
 * 这里只做纯函数与最小的文件读写，方便单测：头部组装/解析、按帧切段、
 * 拆声道、单声道重新封装、峰值统计。
 */

/** 录音固定参数：whisper 只吃 16k，采集器也按这个输出。 */
export const SAMPLE_RATE = 16000
export const CHANNELS = 2
export const BITS_PER_SAMPLE = 16
export const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8
export const FRAME_BYTES = CHANNELS * BYTES_PER_SAMPLE
export const HEADER_BYTES = 44

/** 帧数与毫秒互转。 */
export function framesToMs(frames, sampleRate = SAMPLE_RATE) {
  return Math.round((frames * 1000) / sampleRate)
}

export function msToFrames(ms, sampleRate = SAMPLE_RATE) {
  return Math.max(0, Math.round((ms * sampleRate) / 1000))
}

/** 组装 44 字节标准 WAV 头。 */
export function buildHeader({ dataBytes = 0, sampleRate = SAMPLE_RATE, channels = CHANNELS, bits = BITS_PER_SAMPLE } = {}) {
  const bytesPerSample = bits / 8
  const blockAlign = channels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const header = Buffer.alloc(HEADER_BYTES)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(Math.min(36 + dataBytes, 0xffffffff), 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(bits, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(Math.min(dataBytes, 0xffffffff), 40)
  return header
}

/**
 * 解析 WAV 头。
 * @returns {{ sampleRate: number, channels: number, bits: number, dataOffset: number, dataBytes: number } | null}
 */
export function parseHeader(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bits = 0
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      channels = buffer.readUInt16LE(body + 2)
      sampleRate = buffer.readUInt32LE(body + 4)
      bits = buffer.readUInt16LE(body + 14)
    } else if (id === 'data') {
      // 读到的缓冲区可能只有头部：这时相信声明的长度；真读到数据时按实际可读量截断。
      const available = buffer.length > body ? Math.min(size, buffer.length - body) : size
      return { sampleRate, channels, bits, dataOffset: body, dataBytes: available }
    }
    offset = body + size + (size % 2)
    if (size === 0) break
  }
  return null
}

/** 一个 WAV 文件里有多少帧。 */
export function framesOfFile(fileSize, header = null) {
  const dataOffset = header?.dataOffset ?? HEADER_BYTES
  const dataBytes = Math.max(0, fileSize - dataOffset)
  return Math.floor(dataBytes / FRAME_BYTES)
}

/**
 * 录音还在增长时，把头部的两个长度字段改成当前真实大小。
 * 采集器每 5 秒会自己改一次；Host 侧每次切块前再兜一次，保证文件随时可播放。
 * @returns {{ dataBytes: number, frames: number } | null}
 */
export async function fixHeader(filePath) {
  const { open } = await import('node:fs/promises')
  const handle = await open(filePath, 'r+')
  try {
    const head = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(head, 0, HEADER_BYTES, 0)
    if (bytesRead < HEADER_BYTES) return null
    const parsed = parseHeader(head)
    if (parsed === null || parsed.dataOffset < 8) return null
    const { size } = await handle.stat()
    const dataBytes = Math.max(0, size - parsed.dataOffset)
    const riff = Buffer.alloc(4)
    riff.writeUInt32LE(Math.min(36 + dataBytes, 0xffffffff), 0)
    await handle.write(riff, 0, 4, 4)
    const dataSize = Buffer.alloc(4)
    dataSize.writeUInt32LE(Math.min(dataBytes, 0xffffffff), 0)
    await handle.write(dataSize, 0, 4, parsed.dataOffset - 4)
    return { dataBytes, frames: Math.floor(dataBytes / FRAME_BYTES) }
  } finally {
    await handle.close()
  }
}

/** 读 [fromFrame, toFrame) 的原始交错 PCM。 */
export async function readFrames(filePath, fromFrame, toFrame, dataOffset = HEADER_BYTES) {
  if (toFrame <= fromFrame) return Buffer.alloc(0)
  const { open } = await import('node:fs/promises')
  const handle = await open(filePath, 'r')
  try {
    const length = (toFrame - fromFrame) * FRAME_BYTES
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, dataOffset + fromFrame * FRAME_BYTES)
    return buffer.subarray(0, bytesRead - (bytesRead % FRAME_BYTES))
  } finally {
    await handle.close()
  }
}

/** 从交错 PCM 里拆出一条声道（单声道 16bit）。 */
export function channelOf(pcm, channel) {
  const frames = Math.floor(pcm.length / FRAME_BYTES)
  const mono = Buffer.alloc(frames * BYTES_PER_SAMPLE)
  for (let i = 0; i < frames; i += 1) {
    mono.writeInt16LE(pcm.readInt16LE(i * FRAME_BYTES + channel * BYTES_PER_SAMPLE), i * BYTES_PER_SAMPLE)
  }
  return mono
}

/** 单声道 PCM 包成完整 WAV。 */
export function wrapMonoWav(pcm, sampleRate = SAMPLE_RATE) {
  return Buffer.concat([buildHeader({ dataBytes: pcm.length, sampleRate, channels: 1 }), pcm])
}

/**
 * 找出单声道 PCM 里真正有声音的区间（用于掐掉块首尾的静音）。
 *
 * 为什么要掐：whisper 对「先静音 10 秒再说话」的片段，时间戳经常直接贴到 0，
 * 而且静音段容易被它编出「请不吝点赞订阅」之类的幻觉。掐掉静音、再把偏移加回去，
 * 时间轴和内容都会干净很多。
 *
 * @param {Buffer} pcm 单声道 16bit PCM
 * @param {{ threshold?: number, frameMs?: number, padMs?: number }} options
 * @returns {{ startFrame: number, endFrame: number } | null} 没有声音返回 null
 */
export function speechWindow(pcm, { threshold = 0.006, frameMs = 20, padMs = 200 } = {}) {
  const totalFrames = Math.floor(pcm.length / BYTES_PER_SAMPLE)
  const step = Math.max(1, Math.round((SAMPLE_RATE * frameMs) / 1000))
  const limit = Math.round(threshold * 32768)
  let first = -1
  let last = -1
  for (let frame = 0; frame + step <= totalFrames; frame += step) {
    let peak = 0
    for (let i = 0; i < step; i += 1) {
      const value = Math.abs(pcm.readInt16LE((frame + i) * BYTES_PER_SAMPLE))
      if (value > peak) peak = value
    }
    if (peak >= limit) {
      if (first < 0) first = frame
      last = frame + step
    }
  }
  if (first < 0) return null
  const pad = Math.round((SAMPLE_RATE * padMs) / 1000)
  return { startFrame: Math.max(0, first - pad), endFrame: Math.min(totalFrames, last + pad) }
}

/** 峰值（0..1），用来判断这块到底有没有声音。 */
export function peakOf(pcm) {
  if (pcm.length === 0) return 0
  let max = 0
  const frames = Math.floor(pcm.length / BYTES_PER_SAMPLE)
  for (let i = 0; i < frames; i += 1) {
    const value = Math.abs(pcm.readInt16LE(i * BYTES_PER_SAMPLE))
    if (value > max) max = value
  }
  return max / 32768
}

/** 毫秒 → `mm:ss` 或 `hh:mm:ss`（向下取整，和 whisper 时间戳一致）。 */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}
