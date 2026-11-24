window.__ModuleLoader__.load({
	id: "@local/dsh-fast-read",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

/* 速读 · 右侧栏页面
 *
 * Host 半已经把书切成章节、把抽取结果校验落盘；这里只做一件事：
 * 读工作区里的 .dsh-books/ 文件，画出导读、脑图、图谱、关系图和出处。
 *
 * 不 require 任何 @deepseek-ai/dsh-client-* 模块（inject 只负责激活顺序），
 * 只用 --dsw-alias-* 主题变量，因此换主题不会坏。
 */
const React = require("react")
const e = React.createElement
const { useState, useEffect, useMemo, useRef, useCallback } = React

const NS = "fastRead"
const TAB_ID = "@local/dsh-fast-read"
const TAB_KIND = "fastRead"
const LIBRARY = ".dsh-books"

const zh = {
  "tab.title": "速读",
  "guide.title": "速读",
  "guide.description": "导入一本书，得到导读、脑图与带出处的知识图谱",
  "empty.title": "还没有导入书",
  "empty.body": "在会话里对 Agent 说一句：",
  "empty.sample": "读一下这本书 /Users/你/Downloads/书名.epub",
  "empty.formats": "支持 EPUB、PDF（含扫描版）、TXT、Markdown、HTML、DOCX。",
  "status.progress": "{done}/{total} 章",
  "status.nodes": "{nodes} 节点",
  "status.edges": "{edges} 关系",
  "view.guide": "导读",
  "view.mindmap": "脑图",
  "view.graph": "图谱",
  "view.ego": "关系图",
  "view.evidence": "出处",
  "action.refresh": "刷新",
  "action.fullscreen": "全屏",
  "action.continue": "让 Agent 继续",
  "action.jump": "跳到原文",
  "action.close": "关闭",
  "loading": "正在读取…",
  "error.load": "读不到书的数据：{message}",
  "no.guide": "还没有导读。章节抽完后，Agent 会用 book_record(kind:'guide') 写出来。",
  "no.mindmap": "还没有脑图。",
  "no.graph": "还没有节点。先让 Agent 抽第一章。",
  "no.evidence": "还没有出处。",
  "no.ego": "先在「图谱」里点一个节点，这里会显示它和周围概念的关系。",
  "drawer.summary": "说明",
  "drawer.evidence": "原文出处",
  "drawer.chapter": "第 {chapter} 章",
  "drawer.weight": "重要性 {weight}",
  "filter.hint": "{hidden} 个低权重节点已折叠，点这里展开",
  "filter.expand": "展开全部",
  "filter.collapse": "收起",
  "type.concept": "概念",
  "type.claim": "主张",
  "type.mechanism": "机制",
  "type.example": "例证",
  "type.person": "人物",
  "type.term": "术语",
  "type.method": "方法",
  "edge.causes": "导致",
  "edge.supports": "支撑",
  "edge.contradicts": "对立",
  "edge.evolves": "演进",
  "edge.part_of": "属于",
  "edge.example_of": "例证于",
  "edge.depends_on": "依赖",
  "edge.same_as": "同义",
  "zoom.fit": "适应",
  "jump.failed": "打不开原文，请到文件里搜索这句话",
}

const en = {
  "tab.title": "Fast Read",
  "guide.title": "Fast Read",
  "guide.description": "Import a book, get a guide, a mind map and a sourced knowledge graph",
  "empty.title": "No book yet",
  "empty.body": "Tell the agent in a session:",
  "empty.sample": "read this book /Users/you/Downloads/title.epub",
  "empty.formats": "EPUB, PDF (scanned too), TXT, Markdown, HTML and DOCX are supported.",
  "status.progress": "{done}/{total} chapters",
  "status.nodes": "{nodes} nodes",
  "status.edges": "{edges} edges",
  "view.guide": "Guide",
  "view.mindmap": "Mind map",
  "view.graph": "Graph",
  "view.ego": "Relations",
  "view.evidence": "Sources",
  "action.refresh": "Refresh",
  "action.fullscreen": "Full screen",
  "action.continue": "Ask the agent to continue",
  "action.jump": "Open in book",
  "action.close": "Close",
  "loading": "Loading…",
  "error.load": "Could not read the book: {message}",
  "no.guide": "No guide yet.",
  "no.mindmap": "No mind map yet.",
  "no.graph": "No nodes yet.",
  "no.evidence": "No sources yet.",
  "no.ego": "Pick a node in the graph first.",
  "drawer.summary": "Summary",
  "drawer.evidence": "Sources",
  "drawer.chapter": "Chapter {chapter}",
  "drawer.weight": "Weight {weight}",
  "filter.hint": "{hidden} low-weight nodes hidden, click to show",
  "filter.expand": "Show all",
  "filter.collapse": "Collapse",
  "type.concept": "Concept",
  "type.claim": "Claim",
  "type.mechanism": "Mechanism",
  "type.example": "Example",
  "type.person": "Person",
  "type.term": "Term",
  "type.method": "Method",
  "edge.causes": "causes",
  "edge.supports": "supports",
  "edge.contradicts": "contradicts",
  "edge.evolves": "evolves",
  "edge.part_of": "part of",
  "edge.example_of": "example of",
  "edge.depends_on": "depends on",
  "edge.same_as": "same as",
  "zoom.fit": "Fit",
  "jump.failed": "Could not open the book file",
}

const TYPE_COLOR = {
  concept: "#4c8dff",
  claim: "#f0a04b",
  mechanism: "#57b894",
  example: "#9b7ede",
  person: "#e0697a",
  term: "#7c8ba1",
  method: "#3fa7c4",
}

const EDGE_COLOR = {
  causes: "#e0697a",
  supports: "#57b894",
  contradicts: "#d8863b",
  evolves: "#4c8dff",
  part_of: "#7c8ba1",
  example_of: "#9b7ede",
  depends_on: "#3fa7c4",
  same_as: "#a3b1c2",
}

const CSS = `
.fr-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#222);font-family:var(--dsw-font,inherit);font-size:13px}
.fr-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e5e5)}
.fr-select{max-width:210px;min-width:120px;border:.5px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:12.5px;padding:4px 6px}
.fr-meta{display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.fr-spacer{flex:1}
.fr-btn{display:inline-flex;align-items:center;gap:4px;border:.5px solid var(--dsw-alias-border-l2,#ddd);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:4px 9px;cursor:pointer;white-space:nowrap}
.fr-btn:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.fr-btn[disabled]{opacity:.45;cursor:default}
.fr-tabs{display:flex;gap:2px;padding:6px 10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,#e5e5e5);overflow-x:auto}
.fr-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#777);font:inherit;font-size:12.5px;padding:5px 9px 7px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap}
.fr-tab.active{color:var(--dsw-alias-label-primary,#222);border-bottom-color:#4c8dff}
.fr-body{position:relative;flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.fr-scroll{flex:1;min-height:0;overflow:auto;padding:12px 14px 18px}
.fr-empty{display:flex;flex-direction:column;gap:10px;align-items:flex-start;padding:26px 18px;color:var(--dsw-alias-label-secondary,#777)}
.fr-empty code{display:block;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary,#222);font-family:var(--ds-font-family-code,monospace);font-size:12px;white-space:pre-wrap;word-break:break-all}
.fr-md{line-height:1.7;font-size:13.5px}
.fr-md h1{font-size:17px;margin:6px 0 10px}
.fr-md h2{font-size:15px;margin:18px 0 8px}
.fr-md h3{font-size:13.5px;margin:14px 0 6px;color:var(--dsw-alias-label-secondary,#666)}
.fr-md p{margin:8px 0}
.fr-md ul,.fr-md ol{margin:8px 0;padding-left:20px}
.fr-md li{margin:4px 0}
.fr-md blockquote{margin:10px 0;padding:6px 12px;border-left:2px solid #4c8dff;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));color:var(--dsw-alias-label-secondary,#666)}
.fr-md code{padding:1px 4px;border-radius:4px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12));font-family:var(--ds-font-family-code,monospace);font-size:12px}
.fr-md pre{padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1));overflow:auto}
.fr-md hr{border:0;border-top:.5px solid var(--dsw-alias-border-l2,#e0e0e0);margin:16px 0}
.fr-tree{list-style:none;margin:0;padding:0}
.fr-tree li{margin:2px 0}
.fr-tnode{display:flex;align-items:center;gap:6px;width:100%;padding:3px 6px;border:0;background:transparent;border-radius:6px;cursor:pointer;line-height:1.5;font:inherit;color:inherit;text-align:left}
.fr-tnode:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.1))}
.fr-tnode.selected{background:rgba(76,141,255,.14);color:#2f6fd0}
.fr-chevron{width:12px;display:inline-flex;justify-content:center;color:var(--dsw-alias-label-tertiary,#999);font-size:10px}
.fr-dot{width:7px;height:7px;border-radius:50%;flex:none}
.fr-muted{color:var(--dsw-alias-label-secondary,#888);font-size:12px}
.fr-graphwrap{position:relative;flex:1;min-height:180px;max-height:min(58vh,560px);overflow:hidden}
.fr-svg{display:block;width:100%;height:100%;touch-action:none;cursor:grab}
.fr-svg.dragging{cursor:grabbing}
.fr-node{cursor:pointer;outline:none}
.fr-node:focus-visible circle:first-of-type{stroke:#4c8dff;stroke-width:2}
.fr-node text{font-size:10.5px;fill:var(--dsw-alias-label-primary,#333);pointer-events:none}
.fr-node.dim{opacity:.22}
.fr-edge{stroke-width:1.3;opacity:.75}
.fr-edge.dim{opacity:.08}
.fr-hint{position:absolute;left:10px;bottom:10px;padding:4px 9px;border-radius:99px;background:var(--dsw-alias-bg-layer-1,rgba(255,255,255,.9));border:.5px solid var(--dsw-alias-border-l2,#ddd);font-size:11.5px;color:var(--dsw-alias-label-secondary,#777);cursor:pointer}
.fr-drawer{flex:none;max-height:min(46%,380px);overflow:auto;border-top:.5px solid var(--dsw-alias-border-l2,#e0e0e0);background:var(--dsw-alias-bg-layer-1,transparent);padding:10px 13px 14px}
.fr-drawer-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.fr-drawer-title{font-size:14px;font-weight:600}
.fr-badge{font-size:10.5px;padding:1px 7px;border-radius:99px;border:.5px solid var(--dsw-alias-border-l2,#ddd);color:var(--dsw-alias-label-secondary,#777)}
.fr-ev{margin:7px 0;padding:7px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08));font-size:12.5px;line-height:1.6}
.fr-ev-chapter{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);margin-bottom:3px}
.fr-link{border:0;background:transparent;color:#3d7de0;font:inherit;font-size:12px;cursor:pointer;padding:0}
.fr-link:hover{text-decoration:underline}
.fr-ego-list{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.fr-ego-row{display:flex;align-items:center;gap:6px;font-size:12.5px}
`

/**
 * Read one workspace file through the workspace-files service.
 *
 * The service returns text one line window at a time (5000 lines by default),
 * and a knowledge graph for a long book easily exceeds that. Reading a single
 * page would hand JSON.parse a truncated string, which used to leave the graph
 * empty with no visible reason. Pages are joined until the file reports its end.
 */
async function readWorkspaceFile(ctx, sessionId, path) {
  const chunks = []
  let offset = 1
  for (let page = 0; page < 60; page += 1) {
    let result
    try {
      result = await ctx.remote.workspaceFiles.read(sessionId, path, { offset, limit: 4000 }, undefined)
    } catch (error) {
      return undefined
    }
    if (!result || result.ok !== true) return undefined
    const value = result.value ?? {}
    if (typeof value.text !== "string") return undefined
    chunks.push(value.text)
    if (value.eof !== false) return chunks.join("\n")
    const lines = Number(value.lines) || 0
    if (lines <= 0) return chunks.join("\n")
    offset += lines
  }
  return chunks.join("\n")
}

function parseJson(text, fallback) {
  if (typeof text !== "string") return fallback
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Normalise a graph read from disk: hand-edited or older files must not blank the tab. */
function normalizeGraph(value) {
  const rawNodes = Array.isArray(value?.nodes) ? value.nodes : []
  const nodes = rawNodes
    .filter((node) => node !== null && typeof node === "object" && typeof node.id === "string" && typeof node.name === "string")
    .map((node) => ({
      ...node,
      weight: Number.isFinite(Number(node.weight)) ? Number(node.weight) : 3,
      chapter: Number.isFinite(Number(node.chapter)) ? Number(node.chapter) : 0,
      summary: typeof node.summary === "string" ? node.summary : "",
      evidence: (Array.isArray(node.evidence) ? node.evidence : [])
        .filter((item) => item !== null && typeof item === "object" && typeof item.quote === "string")
        .map((item) => ({
          chapter: Number.isFinite(Number(item.chapter)) ? Number(item.chapter) : 0,
          quote: item.quote,
          offset: Number.isFinite(Number(item.offset)) ? Number(item.offset) : 0,
          line: Number.isFinite(Number(item.line)) ? Number(item.line) : undefined,
        })),
    }))
  const ids = new Set(nodes.map((node) => node.id))
  const edges = (Array.isArray(value?.edges) ? value.edges : [])
    .filter((edge) => edge !== null && typeof edge === "object"
      && ids.has(edge.source) && ids.has(edge.target) && typeof edge.type === "string")
  return { nodes, edges }
}

/**
 * Read the library for one session and keep it current.
 *
 * Two rules keep this cheap and honest: a poll whose four files did not change
 * does not touch state (so the graph never re-lays itself out on a timer), and
 * only the newest request may write (so switching books cannot land the old
 * book's data under the new title).
 */
function useLibrary(ctx, sessionId) {
  const [books, setBooks] = useState([])
  const [book, setBook] = useState(null)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [gen, setGen] = useState(0)
  const [wantedId, setWantedId] = useState(null)
  const lastFingerprint = useRef("")
  const requestSeq = useRef(0)

  const refresh = useCallback(() => setGen((value) => value + 1), [])

  useEffect(() => {
    if (!sessionId) {
      setLoading(false)
      return undefined
    }
    let cancelled = false
    const seq = ++requestSeq.current
    const current = () => !cancelled && seq === requestSeq.current

    const load = async () => {
      const indexText = await readWorkspaceFile(ctx, sessionId, `${LIBRARY}/index.json`)
      if (!current()) return
      const parsed = parseJson(indexText, null)
      const list = (Array.isArray(parsed?.books) ? parsed.books : [])
        .filter((item) => item !== null && typeof item === "object" && typeof item.bookId === "string")
      setBooks(list)
      if (list.length === 0) {
        lastFingerprint.current = ""
        setBook(null)
        setLoading(false)
        return
      }
      const pick = wantedId !== null && list.some((item) => item.bookId === wantedId) ? wantedId : list[0].bookId
      const [metaText, graphText, guideText, mindmapText] = await Promise.all([
        readWorkspaceFile(ctx, sessionId, `${LIBRARY}/${pick}/meta.json`),
        readWorkspaceFile(ctx, sessionId, `${LIBRARY}/${pick}/graph.json`),
        readWorkspaceFile(ctx, sessionId, `${LIBRARY}/${pick}/guide.md`),
        readWorkspaceFile(ctx, sessionId, `${LIBRARY}/${pick}/mindmap.json`),
      ])
      if (!current()) return
      if (typeof graphText === "string" && graphText.length > 0 && parseJson(graphText, null) === null) {
        console.warn("[fast-read] graph.json 无法解析，已按空图谱显示", graphText.length)
      }
      const meta = parseJson(metaText, null)
      const fingerprint = [
        pick,
        meta?.progress?.updatedAt ?? "",
        metaText?.length ?? 0,
        graphText?.length ?? 0,
        guideText?.length ?? 0,
        mindmapText?.length ?? 0,
      ].join("|")
      setLoading(false)
      if (fingerprint === lastFingerprint.current) return
      lastFingerprint.current = fingerprint
      setError("")
      setBook({
        bookId: pick,
        meta,
        graph: normalizeGraph(parseJson(graphText, null)),
        guide: guideText ?? "",
        mindmap: parseJson(mindmapText, null),
      })
    }

    load().catch((failure) => {
      if (!current()) return
      setLoading(false)
      setError(failure instanceof Error ? failure.message : String(failure))
    })
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return
      load().catch(() => {})
    }, 2500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [ctx, sessionId, gen, wantedId])

  const select = useCallback((bookId) => {
    setWantedId(bookId)
  }, [])

  return { books, book, loading, error, refresh, select }
}

/** Small markdown renderer: headings, lists, quotes, code, bold and links. */
function renderInline(text, keyPrefix) {
  const parts = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g
  let last = 0
  let match
  let index = 0
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    const key = `${keyPrefix}-i${index++}`
    if (token.startsWith("**")) parts.push(e("strong", { key }, token.slice(2, -2)))
    else if (token.startsWith("`")) parts.push(e("code", { key }, token.slice(1, -1)))
    else if (token.startsWith("*")) parts.push(e("em", { key }, token.slice(1, -1)))
    else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      parts.push(linkMatch ? e("a", { key, href: linkMatch[2], target: "_blank", rel: "noreferrer" }, linkMatch[1]) : token)
    }
    last = match.index + token.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function Markdown({ text }) {
  const lines = useMemo(() => String(text ?? "").replace(/\r\n?/g, "\n").split("\n"), [text])
  const blocks = []
  let list = null
  let listType = ""
  let paragraph = []

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push(e("p", { key: `p${blocks.length}` }, renderInline(paragraph.join(" "), `p${blocks.length}`)))
    paragraph = []
  }
  const flushList = () => {
    if (list === null) return
    blocks.push(e(listType === "ol" ? "ol" : "ul", { key: `l${blocks.length}` }, list))
    list = null
  }

  for (let cursor = 0; cursor < lines.length; cursor += 1) {
    const raw = lines[cursor]
    const line = raw.trimEnd()
    if (line.trim() === "") {
      flushParagraph()
      flushList()
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      flushList()
      const level = Math.min(4, heading[1].length)
      blocks.push(e(`h${level}`, { key: `h${blocks.length}` }, renderInline(heading[2], `h${blocks.length}`)))
      continue
    }
    if (/^([-*_])\1{2,}$/.test(line.trim())) {
      flushParagraph()
      flushList()
      blocks.push(e("hr", { key: `hr${blocks.length}` }))
      continue
    }
    if (line.startsWith("> ")) {
      flushParagraph()
      flushList()
      blocks.push(e("blockquote", { key: `q${blocks.length}` }, renderInline(line.slice(2), `q${blocks.length}`)))
      continue
    }
    if (/^```/.test(line.trim())) {
      flushParagraph()
      flushList()
      const code = []
      cursor += 1
      while (cursor < lines.length && !/^```/.test(lines[cursor].trim())) {
        code.push(lines[cursor])
        cursor += 1
      }
      blocks.push(e("pre", { key: `c${blocks.length}` }, e("code", null, code.join("\n"))))
      continue
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || ordered) {
      flushParagraph()
      const type = bullet ? "ul" : "ol"
      if (listType !== type) flushList()
      listType = type
      if (list === null) list = []
      const content = (bullet || ordered)[1]
      list.push(e("li", { key: `li${blocks.length}-${list.length}` }, renderInline(content, `li${blocks.length}-${list.length}`)))
      continue
    }
    flushList()
    paragraph.push(line)
  }
  flushParagraph()
  flushList()
  return e("div", { className: "fr-md" }, blocks)
}

/** Tree view for the mind map. */
function MindmapNode({ node, depth, selectedId, onSelect, collapsed, toggle }) {
  if (!node) return null
  const children = Array.isArray(node.children) ? node.children : []
  const hasChildren = children.length > 0
  const open = collapsed[keyOf(node, depth)] !== true
  const nodeLink = typeof node.nodeId === "string" ? node.nodeId : null
  return e("li", null, [
    e("button", {
      key: "row",
      type: "button",
      className: nodeLink !== null && nodeLink === selectedId ? "fr-tnode selected" : "fr-tnode",
      style: { paddingLeft: `${depth * 14}px` },
      "aria-expanded": hasChildren ? open : undefined,
      onClick: () => {
        if (hasChildren) toggle(keyOf(node, depth))
        if (nodeLink !== null) onSelect(nodeLink)
      },
    }, [
      e("span", { key: "chev", className: "fr-chevron" }, hasChildren ? (open ? "▾" : "▸") : ""),
      nodeLink !== null ? e("span", { key: "dot", className: "fr-dot", style: { background: "#4c8dff" } }) : null,
      e("span", { key: "name" }, node.name ?? ""),
    ]),
    hasChildren && open
      ? e("ul", { key: "kids", className: "fr-tree", style: { marginLeft: 0 } },
        children.map((child, index) => e(MindmapNode, {
          key: `${depth}-${index}-${child.name ?? ""}`,
          node: child,
          depth: depth + 1,
          selectedId,
          onSelect,
          collapsed,
          toggle,
        })))
      : null,
  ])
}

function keyOf(node, depth) {
  return `${depth}:${node?.name ?? ""}:${node?.nodeId ?? ""}`
}

/** Force layout, small and dependency-free: settle, then fit the drawing to its content. */
function layoutGraph(nodes, edges, canvasWidth, canvasHeight) {
  const width = Math.max(520, canvasWidth)
  const height = Math.max(360, canvasHeight)
  const positions = new Map()
  const count = Math.max(1, nodes.length)
  nodes.forEach((node, index) => {
    const angle = (index / count) * Math.PI * 2
    const radius = Math.min(width, height) * 0.3
    positions.set(node.id, {
      x: width / 2 + Math.cos(angle) * radius,
      y: height / 2 + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    })
  })
  const ids = nodes.map((node) => node.id)
  const links = edges
    .filter((edge) => positions.has(edge.source) && positions.has(edge.target))
    .map((edge) => ({ source: edge.source, target: edge.target }))
  const ideal = Math.max(90, Math.min(160, Math.sqrt((width * height) / (count + 2)) * 0.75))
  const chapterIds = [...new Set(nodes.map((node) => node.chapter ?? 0))].sort((a, b) => a - b)
  const anchored = chapterIds.length > 1 && chapterIds.length <= 6
  const anchors = new Map()
  chapterIds.forEach((chapter, index) => {
    const angle = chapterIds.length === 1 ? 0 : (index / chapterIds.length) * Math.PI * 2 - Math.PI / 2
    anchors.set(chapter, anchored
      ? {
        x: width / 2 + Math.cos(angle) * width * 0.2,
        y: height / 2 + Math.sin(angle) * height * 0.22,
      }
      : { x: width / 2, y: height / 2 })
  })
  const steps = count > 100 ? 520 : 320

  for (let step = 0; step < steps; step += 1) {
    const alpha = 1 - step / steps
    for (let i = 0; i < ids.length; i += 1) {
      const a = positions.get(ids[i])
      for (let j = i + 1; j < ids.length; j += 1) {
        const b = positions.get(ids[j])
        let dx = a.x - b.x
        let dy = a.y - b.y
        let distance = Math.hypot(dx, dy)
        if (distance < 0.5) {
          dx = (Math.random() - 0.5) * 4
          dy = (Math.random() - 0.5) * 4
          distance = 2
        }
        const push = Math.min((ideal * ideal) / distance, ideal * 1.6)
        const fx = (dx / distance) * push * 0.06 * alpha
        const fy = (dy / distance) * push * 0.06 * alpha
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }
    }
    for (const link of links) {
      const a = positions.get(link.source)
      const b = positions.get(link.target)
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distance = Math.max(0.01, Math.hypot(dx, dy))
      const pull = (distance - ideal) * 0.1 * alpha
      const fx = (dx / distance) * pull
      const fy = (dy / distance) * pull
      a.vx += fx
      a.vy += fy
      b.vx -= fx
      b.vy -= fy
    }
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index]
      const point = positions.get(id)
      const anchor = anchors.get(nodes[index].chapter ?? 0) ?? { x: width / 2, y: height / 2 }
      point.vx += (anchor.x - point.x) * (anchored ? 0.04 : 0.015) * alpha
      point.vy += (anchor.y - point.y) * (anchored ? 0.04 : 0.015) * alpha
      point.x += point.vx * 0.5
      point.y += point.vy * 0.5
      point.vx *= 0.55
      point.vy *= 0.55
    }
  }

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const id of ids) {
    const point = positions.get(id)
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  // Rescale into the canvas so a sparse graph and a dense one both read well.
  // Positions are stretched independently on each axis: the canvas of a full
  // page is far wider than tall, and fitting by the smaller ratio would leave
  // most of it empty.
  const targetWidth = Math.max(320, width - 120)
  const targetHeight = Math.max(240, height - 120)
  const scaleX = targetWidth / Math.max(1, maxX - minX)
  const scaleY = targetHeight / Math.max(1, maxY - minY)
  for (const id of ids) {
    const point = positions.get(id)
    point.x = (point.x - minX) * scaleX
    point.y = (point.y - minY) * scaleY
  }
  return {
    positions,
    bounds: { x: -60, y: -60, width: targetWidth + 120, height: targetHeight + 120 },
  }
}

function radiusOf(weight) {
  const value = Math.min(5, Math.max(1, Number(weight) || 3))
  return 5 + (value - 1) * 2.9
}

function GraphCanvas({ nodes, edges, selectedId, onSelect, t, height }) {
  const wrapRef = useRef(null)
  const [canvas, setCanvas] = useState({ width: 880, height: 560 })
  useEffect(() => {
    const node = wrapRef.current
    if (node === null || typeof ResizeObserver === "undefined") return undefined
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      if (rect === undefined || rect.width < 40) return
      setCanvas((current) => {
        const next = { width: Math.round(rect.width), height: Math.round(rect.height) }
        return next.width === current.width && next.height === current.height ? current : next
      })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const layout = useMemo(() => layoutGraph(nodes, edges, canvas.width, canvas.height), [nodes, edges, canvas.width, canvas.height])
  const positions = layout.positions
  const bounds = layout.bounds
  const [hover, setHover] = useState(null)
  const [view, setView] = useState({ k: 1, x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const drag = useRef(null)
  const svgRef = useRef(null)

  const neighbours = useMemo(() => {
    const focus = hover ?? selectedId
    if (focus === null || focus === undefined) return null
    const set = new Set([focus])
    for (const edge of edges) {
      if (edge.source === focus) set.add(edge.target)
      if (edge.target === focus) set.add(edge.source)
    }
    return set
  }, [hover, selectedId, edges])

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes])
  const labelBudget = nodes.length <= 40 ? nodes.length : 15
  const labelled = useMemo(() => {
    const ranked = [...nodes].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0)).slice(0, labelBudget)
    return new Set(ranked.map((node) => node.id))
  }, [nodes, labelBudget])

  useEffect(() => {
    const node = svgRef.current
    if (node === null) return undefined
    const onWheel = (event) => {
      event.preventDefault()
      const factor = event.deltaY > 0 ? 0.9 : 1.1
      setView((current) => ({ ...current, k: Math.min(3, Math.max(0.35, current.k * factor)) }))
    }
    node.addEventListener("wheel", onWheel, { passive: false })
    return () => node.removeEventListener("wheel", onWheel)
  }, [])
  const onPointerDown = (event) => {
    if (event.target.closest && event.target.closest(".fr-node")) return
    drag.current = { x: event.clientX, y: event.clientY, ox: view.x, oy: view.y }
    setDragging(true)
  }
  const onPointerMove = (event) => {
    if (drag.current === null) return
    setView((current) => ({
      ...current,
      x: drag.current.ox + (event.clientX - drag.current.x),
      y: drag.current.oy + (event.clientY - drag.current.y),
    }))
  }
  const onPointerUp = () => {
    drag.current = null
    setDragging(false)
  }

  return e("div", { className: "fr-graphwrap", ref: wrapRef }, [
    e("svg", {
      key: "svg",
      ref: svgRef,
      className: dragging ? "fr-svg dragging" : "fr-svg",
      viewBox: `${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`,
      preserveAspectRatio: "xMidYMid meet",
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerLeave: onPointerUp,
    }, [
      e("g", { key: "viewport", transform: `translate(${view.x} ${view.y}) scale(${view.k})` }, [
        ...edges.map((edge, index) => {
          const a = positions.get(edge.source)
          const b = positions.get(edge.target)
          if (!a || !b) return null
          const dim = neighbours !== null && !(neighbours.has(edge.source) && neighbours.has(edge.target))
          return e("line", {
            key: `e${index}`,
            className: dim ? "fr-edge dim" : "fr-edge",
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            stroke: EDGE_COLOR[edge.type] ?? "#9aa6b5",
          })
        }),
        ...nodes.map((node) => {
          const point = positions.get(node.id)
          if (!point) return null
          const dim = neighbours !== null && !neighbours.has(node.id)
          const selected = node.id === selectedId
          return e("g", {
            key: node.id,
            className: dim ? "fr-node dim" : "fr-node",
            transform: `translate(${point.x} ${point.y})`,
            tabIndex: 0,
            role: "button",
            "aria-label": node.name,
            "aria-pressed": selected,
            "data-node": node.name,
            onMouseEnter: () => setHover(node.id),
            onMouseLeave: () => setHover(null),
            onFocus: () => setHover(node.id),
            onBlur: () => setHover(null),
            onClick: (event) => {
              event.stopPropagation()
              onSelect(node.id)
            },
            onKeyDown: (event) => {
              if (event.key !== "Enter" && event.key !== " ") return
              event.preventDefault()
              onSelect(node.id)
            },
          }, [
            selected
              ? e("circle", { key: "ring", r: radiusOf(node.weight) + 5, fill: "none", stroke: "#4c8dff", strokeWidth: 1.4, opacity: 0.85 })
              : null,
            e("circle", {
              key: "dot",
              r: radiusOf(node.weight),
              fill: TYPE_COLOR[node.type] ?? "#7c8ba1",
              opacity: 0.9,
            }),
            labelled.has(node.id) || selected || (hover !== null && hover === node.id)
              ? e("text", {
                key: "label",
                x: radiusOf(node.weight) + 4,
                y: 3.5,
                style: { paintOrder: "stroke", stroke: "var(--dsw-alias-bg-layer-1, #fff)", strokeWidth: 3, strokeLinejoin: "round" },
              }, node.name)
              : null,
          ])
        }),
      ]),
    ]),
    e("button", {
      key: "fit",
      className: "fr-hint",
      onClick: () => setView({ k: 1, x: 0, y: 0 }),
    }, `${t("zoom.fit")} · ${Math.round(view.k * 100)}%`),
  ])
}

function Drawer({ node, graph, t, onClose, onJump }) {
  if (!node) return null
  const outgoing = graph.edges.filter((edge) => edge.source === node.id)
  const incoming = graph.edges.filter((edge) => edge.target === node.id)
  const nameOf = (id) => graph.nodes.find((item) => item.id === id)?.name ?? id
  return e("div", { className: "fr-drawer" }, [
    e("div", { key: "head", className: "fr-drawer-head" }, [
      e("span", { key: "title", className: "fr-drawer-title" }, node.name),
      e("span", { key: "type", className: "fr-badge" }, t(`type.${node.type}`)),
      e("span", { key: "weight", className: "fr-badge" }, t("drawer.weight", { weight: node.weight })),
      e("span", { key: "spacer", className: "fr-spacer" }),
      e("button", { key: "close", className: "fr-btn", onClick: onClose }, t("action.close")),
    ]),
    node.summary ? e("div", { key: "summary", style: { fontSize: 13, lineHeight: 1.65 } }, node.summary) : null,
    e("div", { key: "evtitle", className: "fr-muted", style: { marginTop: 8 } }, t("drawer.evidence")),
    ...(node.evidence ?? []).map((item, index) => e("div", { key: `ev${index}`, className: "fr-ev" }, [
      e("div", { key: "ch", className: "fr-ev-chapter" }, t("drawer.chapter", { chapter: item.chapter })),
      e("div", { key: "q" }, `「${item.quote}」`),
      e("button", {
        key: "jump",
        className: "fr-link",
        onClick: () => onJump(item.chapter, item.line),
      }, t("action.jump")),
    ])),
    (outgoing.length > 0 || incoming.length > 0)
      ? e("div", { key: "rel", className: "fr-ego-list" }, [
        ...outgoing.map((edge, index) => e("div", { key: `o${index}`, className: "fr-ego-row" }, [
          e("span", { key: "d", className: "fr-dot", style: { background: TYPE_COLOR[node.type] ?? "#7c8ba1" } }),
          e("span", { key: "s" }, node.name),
          e("span", { key: "rel", className: "fr-muted" }, ` —${edge.label || t(`edge.${edge.type}`)}→ `),
          e("span", { key: "t" }, nameOf(edge.target)),
        ])),
        ...incoming.map((edge, index) => e("div", { key: `i${index}`, className: "fr-ego-row" }, [
          e("span", { key: "d", className: "fr-dot", style: { background: TYPE_COLOR[node.type] ?? "#7c8ba1" } }),
          e("span", { key: "s" }, nameOf(edge.source)),
          e("span", { key: "rel", className: "fr-muted" }, ` —${edge.label || t(`edge.${edge.type}`)}→ `),
          e("span", { key: "t" }, node.name),
        ])),
      ])
      : null,
  ])
}

function EgoView({ graph, selected, t, onSelect, onJump }) {
  const node = graph.nodes.find((item) => item.id === selected) ?? null
  if (node === null) {
    return e("div", { className: "fr-empty" }, t("no.ego"))
  }
  const related = graph.edges
    .filter((edge) => edge.source === node.id || edge.target === node.id)
    .map((edge) => {
      const otherId = edge.source === node.id ? edge.target : edge.source
      const other = graph.nodes.find((item) => item.id === otherId)
      return { edge, other, direction: edge.source === node.id ? "out" : "in" }
    })
    .filter((row) => row.other !== undefined)
  return e("div", { className: "fr-scroll" }, [
    e("div", { key: "head", className: "fr-drawer-head" }, [
      e("span", { key: "title", className: "fr-drawer-title" }, node.name),
      e("span", { key: "type", className: "fr-badge" }, t(`type.${node.type}`)),
      e("button", { key: "back", className: "fr-btn", onClick: () => onSelect(null) }, t("action.close")),
    ]),
    node.summary ? e("p", { key: "summary", style: { lineHeight: 1.7 } }, node.summary) : null,
    e("div", { key: "list", className: "fr-ego-list" },
      related.map(({ edge, other, direction }, index) => e("div", { key: index, className: "fr-ego-row" }, [
        e("span", { key: "dot", className: "fr-dot", style: { background: EDGE_COLOR[edge.type] ?? "#9aa6b5" } }),
        e("span", { key: "a" }, direction === "out" ? node.name : other.name),
        e("span", { key: "rel", className: "fr-muted" }, ` —${edge.label || t(`edge.${edge.type}`)}→ `),
        e("button", {
          key: "b",
          className: "fr-link",
          onClick: () => onSelect(other.id),
        }, direction === "out" ? other.name : node.name),
      ]))),
    e("div", { key: "ev", style: { marginTop: 14 } },
      (node.evidence ?? []).map((item, index) => e("div", { key: index, className: "fr-ev" }, [
        e("div", { key: "ch", className: "fr-ev-chapter" }, t("drawer.chapter", { chapter: item.chapter })),
        e("div", { key: "q" }, `「${item.quote}」`),
        e("button", { key: "jump", className: "fr-link", onClick: () => onJump(item.chapter, item.line) }, t("action.jump")),
      ]))),
  ])
}

function EvidenceView({ graph, t, onJump, onSelect }) {
  const byChapter = new Map()
  for (const node of graph.nodes) {
    for (const item of node.evidence ?? []) {
      const list = byChapter.get(item.chapter) ?? []
      list.push({ node, item })
      byChapter.set(item.chapter, list)
    }
  }
  const chapters = [...byChapter.keys()].sort((a, b) => a - b)
  if (chapters.length === 0) return e("div", { className: "fr-empty" }, t("no.evidence"))
  return e("div", { className: "fr-scroll" }, chapters.map((chapter) => e("div", { key: chapter, style: { marginBottom: 14 } }, [
    e("div", { key: "title", className: "fr-muted", style: { marginBottom: 4 } }, t("drawer.chapter", { chapter })),
    ...byChapter.get(chapter).map(({ node, item }, index) => e("div", { key: index, className: "fr-ev" }, [
      e("button", {
        key: "name",
        className: "fr-link",
        style: { fontWeight: 600 },
        onClick: () => onSelect(node.id),
      }, node.name),
      e("div", { key: "q", style: { marginTop: 2 } }, `「${item.quote}」`),
      e("button", { key: "jump", className: "fr-link", onClick: () => onJump(item.chapter, item.line) }, t("action.jump")),
    ])),
  ])))
}

function EmptyState({ t }) {
  return e("div", { className: "fr-empty" }, [
    e("div", { key: "title", style: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary,#222)" } }, t("empty.title")),
    e("div", { key: "body" }, t("empty.body")),
    e("code", { key: "sample" }, t("empty.sample")),
    e("div", { key: "formats", className: "fr-muted" }, t("empty.formats")),
  ])
}

/** Left-sidebar entry id; the same value is the key of the full-page panel. */
const PANEL_ID = "fast-read"

/**
 * The last Session seen while the conversation filled the main column.
 *
 * `ctx.sidebarRight.mounted` goes undefined as soon as a global page replaces
 * the main column, which is exactly when the left page needs to know which
 * workspace to read. Keeping the last real value bridges that moment.
 */
let lastSessionId = null

/**
 * The session whose workspace the left page should read.
 *
 * A global page has no session of its own, so it follows the session on screen;
 * with none selected it still renders the empty state instead of failing.
 */
function useScreenSession(ctx, props) {
  const direct = props.sessionId ?? props.tab?.sessionId
  const [observed, setObserved] = useState(() => readMounted(ctx))
  useEffect(() => {
    if (direct !== undefined && direct !== null) return undefined
    const observer = ctx.sidebarRight?.mounted
    if (observer === undefined || observer === null) return undefined
    setObserved(readMounted(ctx))
    if (typeof observer.subscribe !== "function") return undefined
    return observer.subscribe(() => setObserved(readMounted(ctx)))
  }, [ctx, direct])
  return direct ?? observed ?? lastSessionId ?? null
}

/**
 * Read the current Session from the sidebar controller, tolerating both shapes
 * the observable may take (a snapshot getter or an observable value).
 * @param {object} ctx - the client context.
 * @returns {string | null} the session id.
 */
function readMounted(ctx) {
  const observer = ctx.sidebarRight?.mounted
  if (observer === undefined || observer === null) return null
  try {
    if (typeof observer.get === "function") return observer.get() ?? null
    if (typeof observer.getSnapshot === "function") return observer.getSnapshot() ?? null
    if (typeof observer === "string") return observer
  } catch (error) {
    return null
  }
  return null
}

/** Full-page mount of the same view, on the left sidebar. */
function FastReadPanel(props) {
  const { ctx, t } = props
  const sessionId = useScreenSession(ctx, props)
  return e(FastReadBody, { ...props, ctx, t, sessionId, mode: "page" })
}

function FastReadBody(props) {
  const { ctx, t } = props
  const sessionId = props.sessionId ?? props.tab?.sessionId
  const mode = props.mode ?? "tab"
  const { books, book, loading, error, refresh, select } = useLibrary(ctx, sessionId)
  const [view, setView] = useState("guide")
  const [selected, setSelected] = useState(null)
  const [collapsed, setCollapsed] = useState({})
  const [showAll, setShowAll] = useState(false)
  const bookKey = book?.bookId ?? null
  useEffect(() => {
    setSelected(null)
    setCollapsed({})
    setShowAll(false)
  }, [bookKey])

  const meta = book?.meta ?? null
  const graph = book?.graph ?? { nodes: [], edges: [] }
  const done = meta?.progress?.extractedChapters?.length ?? 0
  const total = meta?.chapters?.length ?? 0

  const toggleCollapse = (key) => setCollapsed((current) => ({ ...current, [key]: current[key] !== true }))

  const jump = (chapter, line) => {
    if (!sessionId || !book) return
    try {
      const rel = `${LIBRARY}/${book.bookId}/chapters/${String(chapter).padStart(4, "0")}.txt`
      const address = `dsh-resource://file/session/${encodeURIComponent(sessionId)}/${rel.split("/").map(encodeURIComponent).join("/")}`
      ctx.sidebarRight.openResource(address, line == null ? undefined : { params: { line } })
    } catch (failure) {
      console.warn("[fast-read] jump failed", failure)
    }
  }

  const visibleNodes = useMemo(() => {
    if (showAll || graph.nodes.length <= 60) return graph.nodes
    const floor = graph.nodes.length > 150 ? 5 : 4
    const core = graph.nodes.filter((node) => (node.weight ?? 3) >= floor)
    // Pull in the core's neighbours: a star chart with no edges shows nothing.
    const keep = new Set(core.map((node) => node.id))
    for (const edge of graph.edges) {
      if (keep.has(edge.source)) keep.add(edge.target)
      else if (keep.has(edge.target)) keep.add(edge.source)
    }
    const picked = graph.nodes.filter((node) => keep.has(node.id))
    return picked.length > 220 ? core : picked
  }, [graph.nodes, graph.edges, showAll])
  const hiddenCount = graph.nodes.length - visibleNodes.length
  const visibleIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes])
  const visibleEdges = useMemo(() => graph.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target)), [graph.edges, visibleIds])
  const selectedNode = selected === null ? null : graph.nodes.find((node) => node.id === selected) ?? null

  const tabs = [
    ["guide", t("view.guide")],
    ["mindmap", t("view.mindmap")],
    ["graph", t("view.graph")],
    ["ego", t("view.ego")],
    ["evidence", t("view.evidence")],
  ]

  const head = e("div", { key: "head", className: "fr-head" }, [
    books.length > 1
      ? e("select", {
        key: "select",
        className: "fr-select",
        value: book?.bookId ?? "",
        onChange: (event) => {
          setSelected(null)
          select(event.target.value)
        },
      }, books.map((item) => e("option", { key: item.bookId, value: item.bookId }, item.title)))
      : e("span", { key: "title", style: { fontWeight: 600, fontSize: 13.5 } }, meta?.title ?? t("tab.title")),
    total > 0
      ? e("span", { key: "progress", className: "fr-meta" }, [
        e("span", { key: "p" }, t("status.progress", { done, total })),
        e("span", { key: "n" }, t("status.nodes", { nodes: graph.nodes.length })),
        e("span", { key: "e" }, t("status.edges", { edges: graph.edges.length })),
      ])
      : null,
    e("span", { key: "spacer", className: "fr-spacer" }),
    e("button", { key: "refresh", className: "fr-btn", onClick: refresh }, t("action.refresh")),
    mode === "tab"
      ? e("button", {
        key: "full",
        className: "fr-btn",
        onClick: () => {
          try {
            ctx.layout.openRightbar(true, true)
          } catch (failure) {
            console.warn("[fast-read] fullscreen failed", failure)
          }
        },
      }, t("action.fullscreen"))
      : null,
  ])

  const shell = (content) => e("div", { className: "fr-root" }, [e("style", { key: "css" }, CSS), head, content])
  if (loading) return shell(e("div", { key: "b", className: "fr-empty" }, t("loading")))
  if (error) return shell(e("div", { key: "b", className: "fr-empty" }, t("error.load", { message: error })))
  if (books.length === 0 || meta === null) return shell(e("div", { key: "b", className: "fr-body" }, e(EmptyState, { t })))

  const body = (() => {
    if (view === "guide") {
      if (!book.guide || book.guide.trim().length === 0) return e("div", { className: "fr-empty" }, t("no.guide"))
      return e("div", { key: "guide", className: "fr-scroll" }, e(Markdown, { text: book.guide }))
    }
    if (view === "mindmap") {
      if (!book.mindmap?.root) return e("div", { className: "fr-empty" }, t("no.mindmap"))
      return e("div", { key: "mind", className: "fr-scroll" }, [
        e("ul", { key: "tree", className: "fr-tree" }, e(MindmapNode, {
          node: book.mindmap.root,
          depth: 0,
          selectedId: selected,
          onSelect: setSelected,
          collapsed,
          toggle: toggleCollapse,
        })),
      ])
    }
    if (view === "graph") {
      if (graph.nodes.length === 0) return e("div", { className: "fr-empty" }, t("no.graph"))
      return e("div", { key: "graph", className: "fr-body" }, [
        e(GraphCanvas, {
          key: `canvas-${book.bookId}`,
          nodes: visibleNodes,
          edges: visibleEdges,
          selectedId: selected,
          onSelect: setSelected,
          t,
          height: 520,
        }),
        hiddenCount > 0
          ? e("button", {
            key: "expand",
            className: "fr-hint",
            style: { left: "auto", right: 10 },
            onClick: () => setShowAll(true),
          }, t("filter.hint", { hidden: hiddenCount }))
          : null,
        selectedNode !== null
          ? e(Drawer, { key: "drawer", node: selectedNode, graph, t, onClose: () => setSelected(null), onJump: jump })
          : null,
      ])
    }
    if (view === "ego") {
      if (graph.nodes.length === 0) return e("div", { className: "fr-empty" }, t("no.graph"))
      return e(EgoView, { key: "ego", graph, selected, t, onSelect: setSelected, onJump: jump })
    }
    return e(EvidenceView, { key: "ev", graph, t, onJump: jump, onSelect: setSelected })
  })()

  return shell([
    e("div", { key: "tabs", className: "fr-tabs" }, tabs.map(([id, label]) => e("button", {
      key: id,
      className: view === id ? "fr-tab active" : "fr-tab",
      onClick: () => setView(id),
    }, label))),
    e("div", { key: "body", className: "fr-body" }, body),
  ])
}

function PanelIcon() {
  return e("svg", { viewBox: "0 0 16 16", width: 16, height: 16, "aria-hidden": true }, [
    e("path", {
      key: "book",
      d: "M2.4 3.2c1.7-.9 3.6-.9 5.6 0 2-.9 3.9-.9 5.6 0v9.4c-1.7-.9-3.6-.9-5.6 0-2-.9-3.9-.9-5.6 0V3.2z",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.3,
      strokeLinejoin: "round",
    }),
    e("path", { key: "nodes", d: "M6 6.4h1.6M9.6 8.2H8M6.2 9.6l1.2-.7", stroke: "currentColor", strokeWidth: 1, strokeLinecap: "round" }),
    e("circle", { key: "a", cx: 5.2, cy: 6.4, r: 1.1, fill: "currentColor" }),
    e("circle", { key: "b", cx: 10.6, cy: 8.2, r: 1.1, fill: "currentColor" }),
    e("circle", { key: "c", cx: 5.4, cy: 9.9, r: 1, fill: "currentColor" }),
  ])
}

function BookIcon() {
  return e("svg", { viewBox: "0 0 16 16", width: 22, height: 22, "aria-hidden": true }, [
    e("path", {
      key: "book",
      d: "M2.4 3.2c1.7-.9 3.6-.9 5.6 0 2-.9 3.9-.9 5.6 0v9.4c-1.7-.9-3.6-.9-5.6 0-2-.9-3.9-.9-5.6 0V3.2z",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.2,
      strokeLinejoin: "round",
    }),
    e("path", { key: "spine", d: "M8 3.2v9.4", fill: "none", stroke: "currentColor", strokeWidth: 1.1 }),
  ])
}

function apply(ctx) {
  const t = ctx.locale.bind(NS)
  const effect = (run, label) => ctx.effect(() => {
    try {
      return run()
    } catch (error) {
      console.warn(`[fast-read] ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }, label)

  effect(() => ctx.locale.register(NS, { zh, en }), "fast-read: dictionaries")

  effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => t("tab.title"),
    guide: [{
      id: "books",
      title: () => t("guide.title"),
      description: () => t("guide.description"),
      icon: BookIcon,
    }],
  }), "fast-read: tab type")

  effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: TAB_ID,
    locale: NS,
  }, (props) => e(FastReadBody, { ctx, t, ...props }))), "fast-read: body")

  effect(() => {
    const observer = ctx.sidebarRight?.mounted
    if (observer === undefined || observer === null || typeof observer.subscribe !== "function") return undefined
    const remember = () => {
      const current = readMounted(ctx)
      if (typeof current === "string" && current.length > 0) lastSessionId = current
    }
    remember()
    return observer.subscribe(remember)
  }, "fast-read: remember the session on screen")

  effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
    name: "sidebar.panellist",
    id: PANEL_ID,
    order: 7,
    label: t("tab.title"),
  }, PanelIcon)), "fast-read: sidebar entry")

  effect(() => ctx.slots.inject("main", () => ctx.slots.register({
    name: "main",
    key: PANEL_ID,
    id: PANEL_ID,
  }, (props) => e(FastReadPanel, { ctx, t, ...props }))), "fast-read: page")

  effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
    name: "sidebar.right.pane.tab.title",
    key: TAB_ID,
    priority: -1,
  }, () => e("span", null, t("tab.title")))), "fast-read: title")
}

module.exports = { apply, inject: ["slots", "locale", "sidebarRightTabs", "sidebarRight", "layout", "remote", "remote.workspaceFiles"] }

		return module.exports;
	}
});
