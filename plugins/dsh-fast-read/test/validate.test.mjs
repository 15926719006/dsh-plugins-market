import assert from 'node:assert/strict'
import test from 'node:test'

import { applyEdges, applyMindmap, applyNodes, checkQuote, nodeIdFor } from '../src/host/lib/validate.js'

const CHAPTER = {
  index: 1,
  text: '系统1是自动运行的。\n锚定效应是系统1的一个后果。\n我们常常高估自己的判断。',
}
const chapters = [CHAPTER]

test('checkQuote accepts the same sentence with different spacing', () => {
  const result = checkQuote(CHAPTER.text, '  锚定效应 是系统1的 一个后果。 ')
  assert.equal(result.ok, true)
  assert.equal(result.line, 2)
  assert.ok(result.offset > 0)
})

test('checkQuote rejects an invented sentence and returns real text', () => {
  const result = checkQuote(CHAPTER.text, '锚定效应是系统2的后果。')
  assert.equal(result.ok, false)
  assert.match(result.nearest, /锚定效应/)
})

test('checkQuote rejects a quote that is too short to prove anything', () => {
  const result = checkQuote(CHAPTER.text, '系统1')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'quote-too-short')
})

test('applyNodes rejects a node whose evidence is invented', () => {
  const { graph, issues, accepted } = applyNodes({ nodes: [], edges: [] }, chapters, [{
    name: '系统 2',
    type: 'concept',
    summary: '慢思考',
    weight: 4,
    evidence: [{ chapter: 1, quote: '系统2需要努力才能启动。' }],
  }])
  assert.equal(accepted, 0)
  assert.equal(graph.nodes.length, 0)
  assert.equal(issues[0].code, 'quote-not-found')
  assert.match(issues[0].nearest, /系统1/)
})

test('applyNodes merges the same concept from two chapters', () => {
  const first = applyNodes({ nodes: [], edges: [] }, chapters, [{
    name: '系统 1',
    type: 'concept',
    summary: '自动、快速。',
    weight: 2,
    evidence: [{ chapter: 1, quote: '系统1是自动运行的。' }],
  }])
  const second = applyNodes(first.graph, chapters, [{
    name: '系统1',
    type: 'concept',
    summary: '自动、快速、直觉。',
    weight: 5,
    evidence: [{ chapter: 1, quote: '锚定效应是系统1的一个后果。' }],
  }])
  assert.equal(second.graph.nodes.length, 1)
  const node = second.graph.nodes[0]
  assert.equal(node.id, nodeIdFor('系统1'))
  assert.equal(node.weight, 5)
  assert.equal(node.evidence.length, 2)
  assert.equal(node.summary, '自动、快速、直觉。')
})

test('applyEdges refuses a dangling reference', () => {
  const nodes = applyNodes({ nodes: [], edges: [] }, chapters, [{
    name: '系统 1', type: 'concept', summary: '', weight: 3,
    evidence: [{ chapter: 1, quote: '系统1是自动运行的。' }],
  }]).graph
  const { issues, accepted } = applyEdges(nodes, chapters, [{
    source: nodeIdFor('系统1'), target: 'n-nope', type: 'causes',
    evidence: { chapter: 1, quote: '锚定效应是系统1的一个后果。' },
  }])
  assert.equal(accepted, 0)
  assert.equal(issues[0].code, 'unknown-node')
})

test('applyMindmap flags a reference to a node that does not exist', () => {
  const { issues } = applyMindmap({ root: { name: '书', children: [{ name: '系统 1', nodeId: 'n-nope' }] } }, { nodes: [] })
  assert.equal(issues[0].code, 'unknown-node')
})

test('checkQuote folds full-width forms and punctuation runs', () => {
  const text = '本书讨论 ＳＹＳＴＥＭ 与 ΑΒΓ 两个概念——注意是长期——的影响。\n这是长期……的影响。\n“你为什么这样想？”'
  assert.equal(checkQuote(text, '本书讨论 SYSTEM 与 ΑΒΓ 两个概念-注意是长期-的影响。').ok, true)
  assert.equal(checkQuote(text, '"你为什么这样想?"').ok, true)
  assert.equal(checkQuote(text, '这是长期...的影响').ok, true)
})

test('checkQuote refuses a whole-chapter quote', () => {
  const result = checkQuote(CHAPTER.text, '甲'.repeat(300))
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'quote-too-long')
})
