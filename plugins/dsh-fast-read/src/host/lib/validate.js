/**
 * The trust boundary.
 *
 * A model can write any sentence it likes; only a sentence that appears in the
 * book survives this file. Every node, every edge, and every mind-map reference
 * is checked here, and a rejected item comes back with the closest real text so
 * the model can correct itself instead of guessing again.
 */

import { createHash } from 'node:crypto'

import { lineOfOffset, normalizeForMatch, tidyText } from './text.js'

/** Node types the graph accepts. */
export const NODE_TYPES = ['concept', 'claim', 'mechanism', 'example', 'person', 'term', 'method']

/** Edge types the graph accepts. */
export const EDGE_TYPES = ['causes', 'supports', 'contradicts', 'evolves', 'part_of', 'example_of', 'depends_on', 'same_as']

/** Shortest quote that may count as evidence. */
export const MIN_QUOTE = 8

/**
 * Find a quote inside one chapter.
 *
 * Matching ignores whitespace, quote style, dash style and ASCII case, so an
 * OCR page break or a curly quote cannot break a legitimate citation. The
 * returned offset and line refer to the book's own untouched text.
 *
 * @param {string} chapterText - the chapter's text.
 * @param {string} quote - the claimed sentence.
 * @returns {{ ok: boolean, offset: number, line: number, nearest: string, reason?: string }}
 *   the match, or the closest real passage when it failed.
 */
export function checkQuote(chapterText, quote) {
  const needle = normalizeForMatch(quote)
  if (needle.length < MIN_QUOTE) {
    return { ok: false, offset: -1, line: 0, nearest: '', reason: 'quote-too-short' }
  }
  const haystack = normalizeWithMap(String(chapterText ?? ''))
  const at = haystack.normalized.indexOf(needle)
  if (at >= 0) {
    const offset = haystack.offsets[at]
    return { ok: true, offset, line: lineOfOffset(chapterText, offset), nearest: '' }
  }
  return { ok: false, offset: -1, line: 0, nearest: nearestPassage(chapterText, quote) }
}

/**
 * Normalise text while remembering where each character came from.
 * @param {string} text - the original text.
 * @returns {{ normalized: string, offsets: number[] }} the key and its offsets.
 */
function normalizeWithMap(text) {
  const parts = []
  const offsets = []
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (/\s/.test(char)) continue
    let mapped = char
    if (char === '“' || char === '”' || char === '„' || char === '‟') mapped = '"'
    else if (char === '‘' || char === '’' || char === '‚' || char === '‛') mapped = "'"
    else if (char === '—' || char === '–' || char === '―') mapped = '-'
    else if (char === '…') {
      parts.push('...')
      offsets.push(index, index, index)
      continue
    } else if (char >= 'A' && char <= 'Z') mapped = char.toLowerCase()
    parts.push(mapped)
    offsets.push(index)
  }
  return { normalized: parts.join(''), offsets }
}

/**
 * The closest real passage to a quote that was not found.
 *
 * It anchors on the quote's first few characters and returns the surrounding
 * window, which is usually enough for a model to fix an OCR typo.
 *
 * @param {string} chapterText - the chapter's text.
 * @param {string} quote - the rejected quote.
 * @returns {string} a short real passage.
 */
function nearestPassage(chapterText, quote) {
  const text = String(chapterText ?? '')
  const anchor = normalizeForMatch(quote).slice(0, 6)
  if (anchor.length === 0) return tidyText(text).slice(0, 80)
  const haystack = normalizeWithMap(text)
  let at = haystack.normalized.indexOf(anchor)
  if (at < 0) {
    for (let size = anchor.length - 1; size >= 3 && at < 0; size -= 1) at = haystack.normalized.indexOf(anchor.slice(0, size))
  }
  if (at < 0) return tidyText(text).slice(0, 80)
  const offset = haystack.offsets[at]
  return tidyText(text.slice(Math.max(0, offset - 20), offset + 80))
}

/**
 * Stable id for a node name, so re-extracting a chapter updates instead of duplicating.
 * @param {string} name - the node name.
 * @returns {string} the node id.
 */
export function nodeIdFor(name) {
  return `n-${createHash('sha1').update(normalizeForMatch(name)).digest('hex').slice(0, 8)}`
}

/**
 * Merge proposed nodes into a graph, rejecting anything untraceable.
 * @param {{ nodes: any[], edges: any[] }} graph - the current graph.
 * @param {{ index: number, text: string }[]} chapters - every chapter's text.
 * @param {any[]} proposed - the model's nodes.
 * @returns {{ graph: { nodes: any[], edges: any[] }, issues: any[], accepted: number }} the new graph and problems.
 */
export function applyNodes(graph, chapters, proposed) {
  const textOf = chapterIndex(chapters)
  const nodes = Array.isArray(graph.nodes) ? [...graph.nodes] : []
  const byName = new Map(nodes.map((node) => [normalizeForMatch(node.name), node]))
  const issues = []
  let accepted = 0

  for (const raw of Array.isArray(proposed) ? proposed : []) {
    const name = tidyText(raw?.name ?? '')
    if (name.length === 0 || name.length > 40) {
      issues.push({ code: 'bad-name', name, message: '节点名必须 1–40 字' })
      continue
    }
    const type = NODE_TYPES.includes(raw?.type) ? raw.type : 'concept'
    const evidence = []
    for (const item of Array.isArray(raw?.evidence) ? raw.evidence : []) {
      const chapter = Number(item?.chapter)
      const text = textOf.get(chapter)
      if (text === undefined) {
        issues.push({ code: 'unknown-chapter', name, chapter, message: `没有第 ${item?.chapter} 章` })
        continue
      }
      const checked = checkQuote(text, item?.quote ?? '')
      if (!checked.ok) {
        issues.push({
          code: checked.reason ?? 'quote-not-found',
          name,
          chapter,
          quote: item?.quote ?? '',
          nearest: checked.nearest,
          message: '引用的句子在原文里找不到',
        })
        continue
      }
      evidence.push({ chapter, quote: tidyText(item.quote), offset: checked.offset, line: checked.line })
    }
    if (evidence.length === 0) {
      issues.push({ code: 'no-evidence', name, message: '没有一条能对上原文的出处' })
      continue
    }
    const weight = clampWeight(raw?.weight)
    const existing = byName.get(normalizeForMatch(name))
    if (existing !== undefined) {
      existing.weight = Math.max(existing.weight ?? weight, weight)
      existing.summary = longerText(existing.summary, raw?.summary)
      existing.chapter = Math.min(existing.chapter ?? evidence[0].chapter, evidence[0].chapter)
      existing.evidence = mergeEvidence(existing.evidence, evidence)
      accepted += 1
      continue
    }
    const node = {
      id: nodeIdFor(name),
      name,
      type,
      summary: tidyText(raw?.summary ?? ''),
      chapter: evidence[0].chapter,
      weight,
      evidence,
    }
    nodes.push(node)
    byName.set(normalizeForMatch(name), node)
    accepted += 1
  }

  return { graph: { ...graph, nodes, edges: graph.edges ?? [] }, issues, accepted }
}

/**
 * Merge proposed edges into a graph, rejecting dangling references.
 * @param {{ nodes: any[], edges: any[] }} graph - the current graph.
 * @param {{ index: number, text: string }[]} chapters - every chapter's text.
 * @param {any[]} proposed - the model's edges.
 * @returns {{ graph: { nodes: any[], edges: any[] }, issues: any[], accepted: number }} the new graph and problems.
 */
export function applyEdges(graph, chapters, proposed) {
  const textOf = chapterIndex(chapters)
  const nodes = graph.nodes ?? []
  const edges = Array.isArray(graph.edges) ? [...graph.edges] : []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const byName = new Map(nodes.map((node) => [normalizeForMatch(node.name), node]))
  const issues = []
  let accepted = 0

  for (const raw of Array.isArray(proposed) ? proposed : []) {
    const source = byId.get(raw?.source) ?? byName.get(normalizeForMatch(raw?.source ?? ''))
    const target = byId.get(raw?.target) ?? byName.get(normalizeForMatch(raw?.target ?? ''))
    if (source === undefined || target === undefined) {
      issues.push({
        code: 'unknown-node',
        source: raw?.source,
        target: raw?.target,
        message: `边引用了不存在的节点：${raw?.source} → ${raw?.target}`,
      })
      continue
    }
    if (source.id === target.id) {
      issues.push({ code: 'self-edge', source: source.name, message: '不能自己连自己' })
      continue
    }
    const type = EDGE_TYPES.includes(raw?.type) ? raw.type : 'supports'
    const chapter = Number(raw?.evidence?.chapter ?? source.chapter)
    const text = textOf.get(chapter)
    if (text === undefined) {
      issues.push({ code: 'unknown-chapter', source: source.name, target: target.name, chapter, message: `没有第 ${chapter} 章` })
      continue
    }
    const checked = checkQuote(text, raw?.evidence?.quote ?? '')
    if (!checked.ok) {
      issues.push({
        code: checked.reason ?? 'quote-not-found',
        source: source.name,
        target: target.name,
        quote: raw?.evidence?.quote ?? '',
        nearest: checked.nearest,
        message: '这条关系没有对得上原文的出处',
      })
      continue
    }
    const key = `${source.id}|${target.id}|${type}`
    if (edges.some((edge) => `${edge.source}|${edge.target}|${edge.type}` === key)) continue
    edges.push({
      id: `e-${createHash('sha1').update(key).digest('hex').slice(0, 8)}`,
      source: source.id,
      target: target.id,
      type,
      label: tidyText(raw?.label ?? ''),
      evidence: { chapter, quote: tidyText(raw.evidence.quote), offset: checked.offset, line: checked.line },
    })
    accepted += 1
  }

  return { graph: { ...graph, nodes, edges }, issues, accepted }
}

/**
 * Check a mind map's references against the graph.
 * @param {any} payload - `{ root: { name, children, nodeId? } }`.
 * @param {{ nodes: any[] }} graph - the current graph.
 * @returns {{ mindmap: any, issues: any[] }} the accepted tree and any dangling references.
 */
export function applyMindmap(payload, graph) {
  const root = payload?.root ?? payload
  const ids = new Set((graph.nodes ?? []).map((node) => node.id))
  const issues = []
  let count = 0
  const walk = (node, depth) => {
    count += 1
    if (depth > 5) issues.push({ code: 'too-deep', message: '脑图超过 5 层' })
    if (typeof node?.nodeId === 'string' && !ids.has(node.nodeId)) {
      issues.push({ code: 'unknown-node', name: node.name, nodeId: node.nodeId, message: `脑图引用了不存在的节点 ${node.nodeId}` })
    }
    for (const child of Array.isArray(node?.children) ? node.children : []) walk(child, depth + 1)
  }
  walk(root, 0)
  if (count > 400) issues.push({ code: 'too-large', message: '脑图超过 400 个条目' })
  return { mindmap: { schemaVersion: 1, root }, issues }
}

/**
 * Index chapter texts by their chapter number.
 * @param {{ index: number, text: string }[]} chapters - the chapters.
 * @returns {Map<number, string>} chapter number to text.
 */
function chapterIndex(chapters) {
  return new Map((chapters ?? []).map((chapter) => [Number(chapter.index), String(chapter.text ?? '')]))
}

/**
 * Clamp a proposed weight into the documented 1–5 range.
 * @param {unknown} value - the proposed weight.
 * @returns {number} a usable weight.
 */
function clampWeight(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 3
  return Math.min(5, Math.max(1, Math.round(number)))
}

/**
 * Keep the longer of two summaries; a later chapter often explains better.
 * @param {string | undefined} current - the existing summary.
 * @param {string | undefined} next - the proposed summary.
 * @returns {string} the longer one.
 */
function longerText(current, next) {
  const a = tidyText(current ?? '')
  const b = tidyText(next ?? '')
  return b.length > a.length ? b : a
}

/**
 * Union two evidence lists by chapter and quote.
 * @param {any[] | undefined} current - existing evidence.
 * @param {any[]} next - new evidence.
 * @returns {any[]} the union.
 */
function mergeEvidence(current, next) {
  const out = Array.isArray(current) ? [...current] : []
  for (const item of next) {
    const duplicate = out.some((entry) => entry.chapter === item.chapter && normalizeForMatch(entry.quote) === normalizeForMatch(item.quote))
    if (!duplicate) out.push(item)
  }
  return out
}
