// 采集器 Node 包装层：把 helper/capture.swift 编译成可执行文件，并按行解析它的 NDJSON 事件。
//
// 只依赖 Node 内置模块（fs / path / child_process / crypto），不引第三方包。
// 编译器统一走 `xcrun --sdk macosx swiftc`，由 Xcode 命令行工具决定实际路径。

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 编译产物文件名前缀。 */
const BINARY_PREFIX = 'dsh-meeting-capture'

/** 停止采集时等 SIGTERM 生效的时长，超时就 SIGKILL。 */
const STOP_GRACE_MS = 3000
/** 单次编译的超时时间：首次编译 Swift + ScreenCaptureKit 一般 2~10 秒，给足余量。 */
const COMPILE_TIMEOUT_MS = 300_000

/**
 * 计算 Swift 源码的 sha256，用作编译缓存键。
 * @param {string | Buffer} source - 源码内容。
 * @returns {string} 64 位十六进制 sha256。
 */
export function sourceHash(source) {
  return createHash('sha256').update(source).digest('hex')
}

/**
 * 拼出采集器的命令行参数。
 * @param {{ outPath: string, noMic?: boolean, noSystem?: boolean }} options - 采集选项。
 * @returns {string[]} 传给可执行文件的参数数组。
 */
export function buildArgs({ outPath, noMic = false, noSystem = false } = {}) {
  if (typeof outPath !== 'string' || outPath.length === 0) {
    throw new TypeError('buildArgs 需要 outPath')
  }
  const args = ['--out', outPath]
  if (noMic) args.push('--no-mic')
  if (noSystem) args.push('--no-system')
  return args
}

/**
 * 源码 hash 对应的可执行文件路径。
 * @param {string} cacheDir - 缓存目录。
 * @param {string} hash - sourceHash 的返回值（只用前 12 位做文件名）。
 * @returns {string} 可执行文件路径。
 */
export function binaryPathFor(cacheDir, hash) {
  return join(cacheDir, `${BINARY_PREFIX}-${hash.slice(0, 12)}`)
}

/** 正在编译中的 promise，按目标路径复用，避免并发重复编译。 */
const inFlight = new Map()

/**
 * 用 `xcrun swiftc` 把采集器编译到缓存目录；源码没变就直接复用已有文件。
 *
 * 产物名只跟源码内容有关（sha256 前 12 位），所以改源码会自动换新文件名，不需要额外判新旧。
 * 同一个目标路径上的并发调用共用一个编译 promise。
 *
 * @param {{ srcPath: string, cacheDir: string, log?: (message: string) => void }} options - 源码路径、缓存目录、可选日志回调。
 * @returns {Promise<string>} 可执行文件路径。
 * @throws {Error} 源码读不到、编译失败或产物没生成时抛出，消息里带 swiftc stderr 末尾片段。
 */
export function compileCapture({ srcPath, cacheDir, log } = {}) {
  if (typeof srcPath !== 'string' || typeof cacheDir !== 'string') {
    throw new TypeError('compileCapture 需要 srcPath 与 cacheDir')
  }
  let source
  try {
    source = readFileSync(srcPath, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`读不到采集器源码 ${srcPath}：${detail}`)
  }
  const target = binaryPathFor(cacheDir, sourceHash(source))

  // 源码没变：之前已经编译过，直接复用。
  if (existsSync(target)) return Promise.resolve(target)
  // 同一个产物正在编译：复用同一个 promise，别并发起两次 swiftc。
  const pending = inFlight.get(target)
  if (pending) return pending

  const compiling = compileToFile({ srcPath, cacheDir, target, log })
  inFlight.set(target, compiling)
  const cleanup = () => {
    if (inFlight.get(target) === compiling) inFlight.delete(target)
  }
  compiling.then(cleanup, cleanup)
  return compiling
}

/**
 * 真正执行编译：先编到临时文件，成功 chmod 后再改名，避免中断留下半截可执行文件。
 * @param {{ srcPath: string, cacheDir: string, target: string, log?: (message: string) => void }} options - 编译参数。
 * @returns {Promise<string>} 可执行文件路径。
 */
async function compileToFile({ srcPath, cacheDir, target, log }) {
  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`建不了采集器缓存目录 ${cacheDir}：${detail}`)
  }

  const staging = `${target}.tmp-${process.pid}`
  log?.(`编译采集器 ${target}`)
  const args = [
    '--sdk',
    'macosx',
    'swiftc',
    '-O',
    '-parse-as-library',
    srcPath,
    '-o',
    staging,
    '-framework',
    'ScreenCaptureKit',
    '-framework',
    'AVFoundation',
    '-framework',
    'CoreMedia',
    '-framework',
    'CoreAudio',
  ]
  await new Promise((resolve, reject) => {
    execFile('xcrun', args, { timeout: COMPILE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        const tail = String(stderr ?? '').trim().split('\n').filter(Boolean).slice(-12).join('\n')
        reject(new Error(`采集器编译失败：${tail || error.message}`))
        return
      }
      resolve()
    })
  })
  if (!existsSync(staging)) throw new Error('采集器编译完成但没生成产物')
  chmodSync(staging, 0o755)
  if (existsSync(target)) {
    // 并发下别的调用已经落地了同一份产物，删掉临时文件即可。
    rmSync(staging, { force: true })
  } else {
    renameSync(staging, target)
  }
  log?.(`采集器已就绪 ${target}`)
  return target
}

/**
 * 把一个可读流按行切开；一行可能被拆到多个 chunk，也可能一个 chunk 里有多行。
 * @param {import('node:stream').Readable} stream - 子进程的 stdout / stderr。
 * @param {(line: string) => void} onLine - 读到完整一行时回调（不含换行符）。
 * @returns {void}
 */
export function readEventLines(stream, onLine) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (line.length > 0) onLine(line)
      index = buffer.indexOf('\n')
    }
  })
  stream.on('end', () => {
    const rest = buffer.replace(/\r$/, '')
    buffer = ''
    if (rest.length > 0) onLine(rest)
  })
}

/**
 * 启动采集器。
 *
 * stdout 的 NDJSON 逐行解析后交给 onEvent；解析不了的行（比如 Swift 混进 stdout 的 NSLog）直接忽略，
 * 采集器不能因为一行脏数据挂掉。stderr 逐行交给 onStderr（可选，默认丢弃）。
 *
 * @param {{
 *   binPath: string,
 *   outPath: string,
 *   noMic?: boolean,
 *   noSystem?: boolean,
 *   onEvent?: (event: Record<string, unknown>) => void,
 *   onStderr?: (line: string) => void,
 *   onExit?: (info: { code: number | null, signal: NodeJS.Signals | null }) => void,
 * }} options - 启动选项。
 * @returns {{ child: import('node:child_process').ChildProcess, stop: () => Promise<number> }} 子进程与停止函数。
 */
export function startCapture({ binPath, outPath, noMic, noSystem, onEvent, onStderr, onExit } = {}) {
  if (typeof binPath !== 'string' || binPath.length === 0) {
    throw new TypeError('startCapture 需要 binPath')
  }
  const child = spawn(binPath, buildArgs({ outPath, noMic, noSystem }), {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  /** @type {{ code: number | null, signal: NodeJS.Signals | null } | null} */
  let exitInfo = null
  /** @type {(info: { code: number | null, signal: NodeJS.Signals | null }) => void} */
  let resolveClosed = () => {}
  const closed = new Promise((resolve) => {
    resolveClosed = resolve
  })
  /**
   * 进程结束时落定：记退出信息、叫醒 stop()、回调 onExit。重复调用无副作用。
   * @param {number | null} code - 退出码。
   * @param {NodeJS.Signals | null} signal - 结束进程的信号。
   */
  const settle = (code, signal) => {
    if (exitInfo !== null) return
    exitInfo = { code, signal }
    resolveClosed(exitInfo)
    try {
      onExit?.(exitInfo)
    } catch {
      /* 回调抛错不影响采集器状态 */
    }
  }

  child.once('close', (code, signal) => settle(code, signal))
  // spawn 失败（比如二进制不存在）不会有 close，这里兜底落定。
  child.once('error', () => settle(null, null))

  readEventLines(child.stdout, (line) => {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      return // 非 JSON 行忽略
    }
    if (event === null || typeof event !== 'object') return
    try {
      onEvent?.(event)
    } catch {
      /* 回调抛错不影响采集器 */
    }
  })
  if (child.stderr) readEventLines(child.stderr, (line) => onStderr?.(line))

  /** @type {Promise<number> | null} */
  let stopping = null
  /**
   * 停止采集：先 SIGTERM，3 秒还不退就 SIGKILL，最后返回退出码。
   * 进程自己已经退出也能安全调用，直接返回退出码。
   * @returns {Promise<number>} 退出码；被信号杀死时为 0。
   */
  const stop = () => {
    if (stopping) return stopping
    stopping = (async () => {
      if (exitInfo === null) {
        try {
          child.kill('SIGTERM')
        } catch {
          /* 已经退了 */
        }
        const outcome = await Promise.race([
          closed.then(() => 'closed'),
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve('timeout'), STOP_GRACE_MS)
            timer.unref?.()
            closed.then(() => clearTimeout(timer))
          }),
        ])
        if (outcome === 'timeout') {
          try {
            child.kill('SIGKILL')
          } catch {
            /* 已经退了 */
          }
          await closed
        }
      }
      return exitInfo?.code ?? 0
    })()
    return stopping
  }

  return { child, stop }
}
