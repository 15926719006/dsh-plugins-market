import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { FastRead } from '../src/host/service.js'
import { bookPaths } from '../src/host/lib/store.js'

const service = new FastRead({})

/**
 * Build a three-chapter text long enough to survive chapter merging.
 * @returns {string} the book text.
 */
function sample() {
  const body = (word) => Array.from({ length: 40 }, (_, index) => `${word}第${index + 1}段：人们总是高估自己的判断，这就是${word}的核心。`).join('\n')
  return ['第一章', body('系统1'), '第二章', body('锚定效应'), '第三章', body('损失厌恶')].join('\n')
}

test('importBook writes chapters and metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-read-'))
  const result = await service.importBook(root, { text: sample(), title: '测试书' })
  assert.equal(result.title, '测试书')
  assert.equal(result.chapters.length, 3)
  const paths = bookPaths(root, result.bookId)
  const meta = JSON.parse(readFileSync(paths.meta, 'utf8'))
  assert.equal(meta.chapters.length, 3)
  assert.equal(meta.source.kind, 'paste')
  assert.ok(meta.estimate === undefined)
  assert.match(result.estimate.note, /次模型调用/)
  const first = readFileSync(paths.chapter(1), 'utf8')
  assert.match(first, /系统1第1段/)
})

test('importBook reuses an identical import', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-read-'))
  const first = await service.importBook(root, { text: sample(), title: '测试书' })
  const second = await service.importBook(root, { text: sample(), title: '测试书' })
  assert.equal(first.bookId, second.bookId)
  assert.equal(second.reused, true)
})

test('readChapter pages and stops at the end', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-read-'))
  const { bookId, chapters } = await service.importBook(root, { text: sample(), title: '测试书' })
  const first = await service.readChapter(root, bookId, 1, 0, 200)
  assert.equal(first.chapter, 1)
  assert.equal(first.text.length, 200)
  assert.equal(first.nextOffset, 200)
  const last = await service.readChapter(root, bookId, 1, 100000, 200)
  assert.equal(last.text, '')
  assert.equal(last.nextOffset, null)
  assert.ok(chapters[0].chars > 200)
})

test('record validates quotes, merges nodes and advances progress', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-read-'))
  const { bookId } = await service.importBook(root, { text: sample(), title: '测试书' })
  const chapter = await service.readChapter(root, bookId, 1, 0, 4000)

  const bad = await service.record(root, bookId, 'nodes', [{
    name: '系统 1', type: 'concept', summary: '自动', weight: 4,
    evidence: [{ chapter: 1, quote: '这句话不在这本书里，是我编的。' }],
  }])
  assert.equal(bad.accepted, 0)
  assert.equal(bad.issues[0].code, 'quote-not-found')
  assert.ok(bad.issues[0].nearest.includes('系统1'))

  const good = await service.record(root, bookId, 'nodes', [{
    name: '系统 1', type: 'concept', summary: '自动、快速的判断系统', weight: 4,
    evidence: [{ chapter: 1, quote: '人们总是高估自己的判断，这就是系统1的核心。' }],
  }])
  assert.equal(good.accepted, 1)
  assert.equal(good.counts.nodes, 1)

  const merged = await service.record(root, bookId, 'nodes', [{
    name: '系统1', type: 'concept', summary: '自动、快速、直觉', weight: 5,
    evidence: [{ chapter: 1, quote: chapter.text.split('\n')[1] }],
  }])
  assert.equal(merged.counts.nodes, 1)
  assert.equal(merged.counts.edges, 0)

  const summary = await service.record(root, bookId, 'chapter-summary', { chapter: 1, summary: '系统 1 是自动系统。' })
  assert.equal(summary.progress.extractedChapters[0], 1)

  const graph = JSON.parse(readFileSync(bookPaths(root, bookId).graph, 'utf8'))
  assert.equal(graph.nodes[0].weight, 5)
  assert.equal(graph.nodes[0].evidence.length, 2)
})

test('record refuses a guide that ignores the book', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-read-'))
  const { bookId } = await service.importBook(root, { text: sample(), title: '测试书' })
  const result = await service.record(root, bookId, 'guide', { markdown: '泛泛而谈的导读，没有任何书里的概念。'.repeat(12) })
  assert.equal(result.accepted, 0)
  assert.equal(result.issues[0].code, 'guide-detached')
})

test('state reports progress and the next chapter', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-read-'))
  const { bookId } = await service.importBook(root, { text: sample(), title: '测试书' })
  await service.record(root, bookId, 'chapter-summary', { chapter: 1, summary: '第一章讲的是系统 1 会不自觉地自动运行。' })
  const state = await service.state(root)
  assert.equal(state.books.length, 1)
  assert.equal(state.books[0].done, 1)
  assert.match(state.nextSteps[0], /第 2 章/)
})

test('state returns the protocol when asked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-read-'))
  const state = await service.state(root, undefined, 'protocol')
  assert.match(state.protocol, /抽取协议/)
  assert.equal(state.books.length, 0)
})

test('two record calls for one book run one after the other', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-read-'))
  const { bookId } = await service.importBook(root, { text: sample(), title: '并发书' })
  const quote = (await service.readChapter(root, bookId, 1, 0, 4000)).text.split('\n')[1]
  const [first, second] = await Promise.all([
    service.record(root, bookId, 'nodes', [{ name: '并发甲', type: 'concept', summary: '甲', weight: 3, evidence: [{ chapter: 1, quote }] }]),
    service.record(root, bookId, 'nodes', [{ name: '并发乙', type: 'concept', summary: '乙', weight: 3, evidence: [{ chapter: 1, quote }] }]),
  ])
  assert.equal(first.accepted, 1)
  assert.equal(second.accepted, 1)
  const graph = JSON.parse(readFileSync(bookPaths(root, bookId).graph, 'utf8'))
  assert.equal(graph.nodes.length, 2)
})

test('an invalid mind map is refused and never written', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fast-read-'))
  const { bookId } = await service.importBook(root, { text: sample(), title: '脑图书' })
  const result = await service.record(root, bookId, 'mindmap', {
    root: { name: '全书', children: [{ name: '不存在的节点', nodeId: 'n-deadbeef' }] },
  })
  assert.equal(result.accepted, 0)
  assert.equal(result.issues[0].code, 'unknown-node')
  assert.equal(result.progress.mindmap, false)
  assert.equal(existsSync(bookPaths(root, bookId).mindmap), false)
})
