// 采集器包装层的纯逻辑单测：编译缓存、参数拼接、NDJSON 解析、停止语义。
// 不真录音：所有可执行文件都是临时目录里的假脚本；编译用假 `xcrun` + PATH 注入。

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { binaryPathFor, buildArgs, compileCapture, readEventLines, sourceHash, startCapture } from '../src/host/capture.js'
import { PassThrough } from 'node:stream'

/**
 * 造一个临时目录。
 * @param {string} prefix - 目录名前缀，便于排障。
 * @returns {string} 目录路径。
 */
function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * 写一个可执行脚本。
 * @param {string} path - 目标路径。
 * @param {string} body - 脚本内容（含 shebang）。
 * @returns {void}
 */
function writeExecutable(path, body) {
  writeFileSync(path, body, 'utf8')
  chmodSync(path, 0o755)
}

/**
 * 短暂等待，用于等子进程输出/退出。
 * @param {number} ms - 毫秒。
 * @returns {Promise<void>} 等待完成的 promise。
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}


/**
 * 轮询等一个条件成立。本机首次执行一个新建的脚本文件会慢到 ~350ms（每次新路径首次 exec 都要走一遍校验），
 * 所以「等事件到齐」必须轮询，不能写死一个很短的 sleep。
 * @param {() => boolean} predicate - 条件。
 * @param {number} timeoutMs - 最长等待毫秒数。
 * @returns {Promise<boolean>} 超时后返回最后一次判断结果。
 */
async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(25)
  }
  return predicate()
}

/**
 * 假 `xcrun`：记录被调用的次数，并把 `-o` 指定路径写成假可执行文件。
 * @param {string} countFile - 调用记录文件。
 * @returns {string} 脚本内容。
 */
function fakeXcrunSuccess(countFile) {
  return `#!/bin/sh
echo run >> '${countFile}'
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
if [ -z "$out" ]; then
  echo "fake xcrun: 没有 -o 参数" >&2
  exit 1
fi
printf '#!/bin/sh\\nexit 0\\n' > "$out"
chmod 755 "$out"
exit 0
`
}

/**
 * 假 `xcrun`：模拟 swiftc 类型检查失败。
 * @returns {string} 脚本内容。
 */
function fakeXcrunFailure() {
  return `#!/bin/sh
echo "helper/capture.swift:12:5: error: cannot find 'SCShareableContent' in scope" >&2
echo "error: failed to typecheck" >&2
exit 1
`
}

/**
 * 在 PATH 最前面插入目录，跑完自动还原。
 * @param {string} dir - 要插入 PATH 的目录。
 * @param {() => Promise<void>} body - 测试主体。
 * @returns {Promise<void>} 测试完成的 promise。
 */
async function withPath(dir, body) {
  const original = process.env.PATH
  process.env.PATH = `${dir}:${original ?? ''}`
  try {
    await body()
  } finally {
    process.env.PATH = original
  }
}

test('sourceHash 稳定、定长，并且能区分不同源码', () => {
  const first = sourceHash('import Foundation\nlet sampleRate = 16000\n')
  const second = sourceHash('import Foundation\nlet sampleRate = 16000\n')
  assert.equal(first, second)
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.notEqual(sourceHash('let sampleRate = 8000\n'), first)
  // 字符串和 Buffer 等价
  assert.equal(sourceHash(Buffer.from('abc')), sourceHash('abc'))
})

test('binaryPathFor 只用 hash 前 12 位命名', () => {
  const dir = '/tmp/cache'
  const hash = 'a'.repeat(64)
  assert.equal(binaryPathFor(dir, hash), '/tmp/cache/dsh-meeting-capture-aaaaaaaaaaaa')
})

test('buildArgs 按 --no-mic / --no-system 拼参数', () => {
  assert.deepEqual(buildArgs({ outPath: '/tmp/audio.wav' }), ['--out', '/tmp/audio.wav'])
  assert.deepEqual(buildArgs({ outPath: '/tmp/audio.wav', noMic: true }), ['--out', '/tmp/audio.wav', '--no-mic'])
  assert.deepEqual(buildArgs({ outPath: '/tmp/audio.wav', noSystem: true }), ['--out', '/tmp/audio.wav', '--no-system'])
  assert.deepEqual(buildArgs({ outPath: '/tmp/audio.wav', noMic: true, noSystem: true }), [
    '--out',
    '/tmp/audio.wav',
    '--no-mic',
    '--no-system',
  ])
  assert.throws(() => buildArgs({}), TypeError)
})

test('compileCapture 并发调用只编译一次，源码没变直接复用产物', async () => {
  const dir = tempDir('mn-compile-')
  const fakeBinDir = join(dir, 'fakebin')
  mkdirSync(fakeBinDir)
  const countFile = join(dir, 'xcrun-calls.txt')
  writeExecutable(join(fakeBinDir, 'xcrun'), fakeXcrunSuccess(countFile))

  const cacheDir = join(dir, 'cache')
  const source = 'import Foundation\nprint("capture helper")\n'
  const srcA = join(dir, 'a.swift')
  const srcB = join(dir, 'b.swift')
  writeFileSync(srcA, source, 'utf8')
  writeFileSync(srcB, source, 'utf8')

  await withPath(fakeBinDir, async () => {
    const logs = []
    const [first, second] = await Promise.all([
      compileCapture({ srcPath: srcA, cacheDir, log: (line) => logs.push(line) }),
      compileCapture({ srcPath: srcB, cacheDir, log: (line) => logs.push(line) }),
    ])

    // 两份内容相同的源码 → 同一个产物路径，只真正编译一次
    assert.equal(first, second)
    assert.equal(first, binaryPathFor(cacheDir, sourceHash(source)))
    assert.equal(readFileSync(countFile, 'utf8').trim().split('\n').length, 1)
    assert.ok(existsSync(first))
    assert.equal(statSync(first).mode & 0o777, 0o755)
    assert.ok(logs.some((line) => line.includes('编译')))

    // 再调一次：源码没变，命中已有产物，不再编
    const third = await compileCapture({ srcPath: srcA, cacheDir })
    assert.equal(third, first)
    assert.equal(readFileSync(countFile, 'utf8').trim().split('\n').length, 1)

    // 源码变了：换新的缓存键和新产物，重新编一次
    const changedSource = 'import Foundation\nprint("capture helper v2")\n'
    const srcC = join(dir, 'c.swift')
    writeFileSync(srcC, changedSource, 'utf8')
    const fourth = await compileCapture({ srcPath: srcC, cacheDir })
    assert.notEqual(fourth, first)
    assert.equal(fourth, binaryPathFor(cacheDir, sourceHash(changedSource)))
    assert.equal(readFileSync(countFile, 'utf8').trim().split('\n').length, 2)
  })
})

test('compileCapture 编译失败时抛出带 swiftc stderr 末尾片段的错误', async () => {
  const dir = tempDir('mn-compile-fail-')
  const fakeBinDir = join(dir, 'fakebin')
  mkdirSync(fakeBinDir)
  writeExecutable(join(fakeBinDir, 'xcrun'), fakeXcrunFailure())
  const cacheDir = join(dir, 'cache')
  const srcPath = join(dir, 'capture.swift')
  writeFileSync(srcPath, 'this is not swift\n', 'utf8')

  await withPath(fakeBinDir, async () => {
    await assert.rejects(compileCapture({ srcPath, cacheDir }), (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /采集器编译失败/)
      assert.match(error.message, /cannot find 'SCShareableContent' in scope/)
      return true
    })
    // 失败后目录里不该留下半截产物
    assert.equal(existsSync(binaryPathFor(cacheDir, sourceHash('this is not swift\n'))), false)
  })
})

// 说明：真的起进程的断言也放在这里跑。本机第一次执行一个新建的脚本路径会有 ~350ms 的启动
// 延迟（每次新路径首次 exec 都要过一遍系统校验），所以等事件必须轮询，不能写死一个很短的 sleep。

test('readEventLines 按行切分、容忍半行与脏行', async () => {
  const stream = new PassThrough()
  const lines = []
  readEventLines(stream, (line) => lines.push(line))
  stream.write('{"event":"started"')
  stream.write(',"sampleRate":16000}\nnot json\n')
  stream.write('{"event":"stopped","durationMs":5}\n')
  stream.end()
  await waitFor(() => lines.length >= 3)
  assert.deepEqual(lines, ['{"event":"started","sampleRate":16000}', 'not json', '{"event":"stopped","durationMs":5}'])
})

test('startCapture 解析 NDJSON、忽略非 JSON 行，stop() 返回 0 且幂等', async () => {
  const dir = tempDir('mn-capture-')
  const argsFile = join(dir, 'args.txt')
  const outPath = join(dir, 'audio.wav')
  const binPath = join(dir, 'fake-capture')
  writeExecutable(
    binPath,
    `#!/bin/sh
printf '%s\\n' "$@" > '${argsFile}'
printf '%s\\n' '{"event":"started","sampleRate":16000,"channels":2}'
printf '%s\\n' '2026-11-26 10:00:00.000 fake-capture[1:2] NSLog 混进 stdout 的一行'
printf '%s\\n' '{"event":"stopped","durationMs":5}'
trap 'exit 0' TERM INT
while true; do sleep 0.05; done
`,
  )
  const events = []
  const exitInfos = []
  const { stop } = startCapture({
    binPath,
    outPath,
    noMic: true,
    onEvent: (event) => events.push(event),
    onExit: (info) => exitInfos.push(info),
  })

  try {
    // 非 JSON 行不能让进程崩，也不能挡住后面的 JSON 事件
    const arrived = await waitFor(() => events.length >= 2)
    assert.equal(arrived, true, `只收到 ${events.length} 个事件`)
    assert.deepEqual(events.map((event) => event.event), ['started', 'stopped'])
    assert.equal(events[0].sampleRate, 16000)
    // 参数确实传给了子进程
    assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), ['--out', outPath, '--no-mic'])

    assert.equal(await stop(), 0)
    assert.equal(await stop(), 0) // 幂等，不会重复等
    assert.equal(exitInfos.length, 1)
    assert.equal(exitInfos[0].code, 0)
  } finally {
    await stop() // 断言失败也别留下常驻假采集器，否则 node --test 会等它
  }
})

test('startCapture 能拼回被拆到多个 chunk 的事件行', async () => {
  const dir = tempDir('mn-capture-split-')
  const binPath = join(dir, 'fake-capture')
  writeExecutable(
    binPath,
    `#!/bin/sh
printf '{"event":"started"'
sleep 0.1
printf ',"sampleRate":16000,"channels":2}\\n'
trap 'exit 0' TERM INT
while true; do sleep 0.05; done
`,
  )
  const events = []
  const { stop } = startCapture({
    binPath,
    outPath: join(dir, 'audio.wav'),
    onEvent: (event) => events.push(event),
  })
  try {
    assert.equal(await waitFor(() => events.length >= 1), true, '被拆开的事件行没拼回来')
    assert.deepEqual(events[0], { event: 'started', sampleRate: 16000, channels: 2 })
    assert.equal(await stop(), 0)
  } finally {
    await stop()
  }
})

test('startCapture 进程自己退出也 resolve，并带回退出码', async () => {
  const dir = tempDir('mn-capture-exit-')
  const binPath = join(dir, 'fake-capture')
  writeExecutable(
    binPath,
    `#!/bin/sh
printf '%s\\n' '{"event":"error","message":"系统声音采集失败"}'
exit 3
`,
  )
  const events = []
  const exitInfos = []
  const { stop } = startCapture({
    binPath,
    outPath: join(dir, 'audio.wav'),
    onEvent: (event) => events.push(event),
    onExit: (info) => exitInfos.push(info),
  })

  // 让子进程自己跑完退出，再调 stop()：应该直接带回它的退出码，而不是发信号
  assert.equal(await waitFor(() => exitInfos.length >= 1), true, '子进程没有自己退出')
  assert.equal(await stop(), 3)
  assert.equal(await waitFor(() => events.length >= 1), true, '没等到 error 事件')
  assert.deepEqual(events.map((event) => event.event), ['error'])
  assert.equal(exitInfos.length, 1)
  assert.equal(exitInfos[0].code, 3)
})

test('startCapture 缺参数时抛 TypeError', () => {
  assert.throws(() => startCapture({ outPath: '/tmp/a.wav' }), /binPath/)
  assert.throws(() => startCapture({ binPath: '/bin/true' }), /outPath/)
})
