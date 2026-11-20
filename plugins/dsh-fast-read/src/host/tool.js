/**
 * The four model-facing tools.
 *
 * They are deliberately thin: one call does one thing, outputs stay bounded,
 * and every failure explains what to do next. Descriptions name the Chinese
 * trigger words a person actually types, because that is how the model knows
 * when this plugin is the right one.
 */

import { PARSE_CODES } from './lib/errors.js'

/** Tool names, in the order they are mounted. */
export const TOOL_NAMES = ['book_import', 'book_read', 'book_record', 'book_state']

/** Canonical output shape shared by all four tools. */
const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      summary: { type: 'string' },
      data: { type: 'object', additionalProperties: true },
    },
    required: ['ok', 'summary'],
  },
}

/** JSON schema for one evidence item. */
const EVIDENCE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chapter: { type: 'integer', description: '章节号，从 book_import 的 chapters 里取' },
    quote: { type: 'string', description: '从章节正文原样复制的一行（8–200 字），不要改写' },
  },
  required: ['chapter', 'quote'],
}

/** JSON schema for one node. */
const NODE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: '概念名，1–40 字' },
    type: {
      type: 'string',
      enum: ['concept', 'claim', 'mechanism', 'example', 'person', 'term', 'method'],
      description: '节点类型，默认 concept',
    },
    summary: { type: 'string', description: '一两句话说明它是什么、为什么重要' },
    weight: { type: 'integer', minimum: 1, maximum: 5, description: '重要性 1–5，5 = 全书核心' },
    evidence: { type: 'array', items: EVIDENCE, description: '至少一条，且必须能对上原文' },
  },
  required: ['name', 'evidence'],
}

/** JSON schema for one edge. */
const EDGE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    source: { type: 'string', description: '起点节点 id 或名字' },
    target: { type: 'string', description: '终点节点 id 或名字' },
    type: {
      type: 'string',
      enum: ['causes', 'supports', 'contradicts', 'evolves', 'part_of', 'example_of', 'depends_on', 'same_as'],
      description: '关系类型，默认 supports',
    },
    label: { type: 'string', description: '中文短标签，例如「导致」' },
    evidence: EVIDENCE,
  },
  required: ['source', 'target', 'evidence'],
}

/**
 * Build one tool definition.
 * @param {string} name - the tool name.
 * @param {import('./service.js').FastRead} service - the Host service.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @returns {object} a registry-ready tool definition.
 */
export function createTool(name, service, ctx) {
  const definition = DEFINITIONS[name]
  return {
    name,
    description: definition.description,
    parameters: definition.parameters,
    output: {
      schema: OUTPUT.schema,
      render: definition.render ?? ((_args, value) => [{ type: 'text', text: value?.summary ?? '' }]),
    },
    async execute(args, exec) {
      const root = workspaceRoot(ctx, exec)
      try {
        const value = await definition.run(service, root, args ?? {}, ctx)
        return { ok: true, summary: value.summary, data: value.data }
      } catch (error) {
        if (error?.name === 'ParseError') {
          return {
            ok: false,
            summary: `速读：${error.message}`,
            data: { code: error.code, hint: hintFor(error.code) },
          }
        }
        throw error
      }
    },
  }
}

/**
 * Turn a stable failure code into a next step the person can take.
 * @param {string} code - the parse code.
 * @returns {string} a hint.
 */
function hintFor(code) {
  switch (code) {
    case PARSE_CODES.encrypted:
      return '换一份没有 DRM 的 EPUB，或用 TXT/PDF 导入'
    case PARSE_CODES.unsupported:
      return '支持的格式：EPUB、PDF、TXT、Markdown、HTML、DOCX'
    case PARSE_CODES.noSwift:
      return 'PDF 需要 Xcode 命令行工具；也可以先把 PDF 转成 EPUB'
    case PARSE_CODES.empty:
      return '确认文件里有正文，或改用 book_import 的 text 参数直接贴一段'
    default:
      return '确认文件完整、没有加密'
  }
}

/**
 * The workspace root this call happens in.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {any} exec - the tool run context.
 * @returns {string} the absolute workspace root.
 */
function workspaceRoot(ctx, exec) {
  const session = exec?.agent?.session
  if (session === undefined) throw new Error('速读工具必须在会话里调用：它需要一个工作区来存放 .dsh-books/')
  const directoryService = ctx.get?.('workingDirectory') ?? ctx.workingDirectory
  const root = directoryService?.get?.(session)
  if (typeof root === 'string' && root.length > 0) return root
  throw new Error('当前会话没有工作目录，无法存放书籍数据')
}

/** Tool definitions. */
const DEFINITIONS = {
  book_import: {
    description: [
      '导入一本书并切成章节。用户说「读一下这本书」「帮我吃透这本」「导入这本书」时先调这个。',
      '',
      '给 path（EPUB/PDF/TXT/MD/HTML/DOCX 的绝对路径）或 text（直接粘贴的正文）。',
      '返回 bookId、章节表，以及 estimate（预计模型调用次数）。之后用 book_read 逐章读取。',
      '这一步只解析文件、不调用模型理解内容。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: '书籍文件的绝对路径' },
        text: { type: 'string', description: '直接粘贴的正文；给了 text 就不需要 path' },
        title: { type: 'string', description: '书名；文件里没有元数据时用' },
        author: { type: 'string', description: '作者' },
      },
    },
    async run(service, root, args) {
      const data = await service.importBook(root, args)
      return {
        summary: `已导入《${data.title}》：${data.chapters.length} 章，${data.estimate.note}${data.reused ? '（这本书之前导入过，直接复用）' : ''}。下一步：book_read 第 1 章。`,
        data,
      }
    },
  },

  book_read: {
    description: [
      '读一本书某一章的正文窗口。章节正文只从这里进入上下文，窗口默认 8000 字。',
      '',
      '返回 nextOffset 就继续读同一章；返回 null 说明这一章读完了。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bookId: { type: 'string', description: 'book_import 返回的 bookId' },
        chapter: { type: 'integer', description: '章节号' },
        offset: { type: 'integer', description: '从第几个字符开始，默认 0' },
        limit: { type: 'integer', description: '本次最多读多少字，默认 8000' },
      },
      required: ['bookId', 'chapter'],
    },
    render: (_args, value) => {
      const data = value?.data ?? {}
      const blocks = [{ type: 'text', text: value?.summary ?? '' }]
      if (typeof data.text === 'string' && data.text.length > 0) blocks.push({ type: 'text', text: data.text })
      if (data.nextOffset !== null && data.nextOffset !== undefined) {
        blocks.push({ type: 'text', text: `[续读] book_read({ bookId: "${data.bookId}", chapter: ${data.chapter}, offset: ${data.nextOffset} })` })
      }
      return blocks
    },
    async run(service, root, args) {
      const data = await service.readChapter(root, args.bookId, args.chapter, args.offset, args.limit)
      const tail = data.nextOffset === null ? '这一章读完了' : `接着从 offset ${data.nextOffset} 读`
      return {
        summary: `第 ${data.chapter} 章「${data.title}」（共 ${data.total} 字），本次 ${data.text.length} 字；${tail}。`,
        data,
      }
    },
  },

  book_record: {
    description: [
      '把抽取结果写进书里，并逐条对照原文校验出处。对不上原文的条目会被拒收，并回传最接近的原文。',
      '',
      'kind = nodes 写概念节点；edges 写概念间关系；chapter-summary 记章节进度；guide 写导读（Markdown）；mindmap 写脑图树。',
      '同一个概念在别的章节再次提交会自动合并，不用自己查重。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bookId: { type: 'string', description: 'book_import 返回的 bookId' },
        kind: {
          type: 'string',
          enum: ['nodes', 'edges', 'chapter-summary', 'guide', 'mindmap'],
          description: '要写哪类产物',
        },
        payload: {
          type: 'object',
          additionalProperties: true,
          description: 'nodes/edges 给数组；chapter-summary 给 {chapter, summary}；guide 给 {markdown}；mindmap 给 {root}',
        },
      },
      required: ['bookId', 'kind', 'payload'],
    },
    async run(service, root, args) {
      const data = await service.record(root, args.bookId, args.kind, args.payload)
      const rejected = data.issues.length
      const head = rejected === 0
        ? `已写入 ${data.kind}：接受 ${data.accepted} 条。`
        : `已写入 ${data.kind}：接受 ${data.accepted} 条，拒收 ${rejected} 条。`
      const first = rejected > 0 ? ` 第一条问题：${describeIssue(data.issues[0])}` : ''
      return { summary: `${head}${first} 当前 ${data.counts.nodes} 节点 / ${data.counts.edges} 关系。`, data }
    },
  },

  book_state: {
    description: [
      '看书架与抽取进度。用户问「读到哪了」「这本书进展如何」，或不确定下一步时调用。',
      '',
      'action = protocol 时返回完整抽取协议（含节点/关系/导读/脑图的格式与拒收规则），第一次做抽取前先读它。',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        bookId: { type: 'string', description: '只看某一本' },
        action: { type: 'string', enum: ['books', 'protocol'], description: '默认 books' },
      },
    },
    async run(service, root, args) {
      const data = await service.state(root, args.bookId, args.action)
      if (args.action === 'protocol') {
        return { summary: data.protocol, data: { books: data.books, nextSteps: data.nextSteps } }
      }
      const lines = data.books.map((book) =>
        `《${book.title}》 ${book.done}/${book.chapters} 章 · ${book.nodes} 节点 · ${book.edges} 关系${book.guide ? ' · 有导读' : ''}`)
      return {
        summary: lines.length === 0 ? data.nextSteps[0] : `${lines.join('\n')}\n下一步：${data.nextSteps[0]}`,
        data,
      }
    },
  },
}

/**
 * One line that tells the model exactly what was wrong.
 * @param {any} issue - the rejected item.
 * @returns {string} a repair instruction.
 */
function describeIssue(issue) {
  if (issue.code === 'quote-not-found') {
    return `「${issue.name ?? `${issue.source}→${issue.target}`}」的出处对不上原文；最接近的原文是「${issue.nearest}」`
  }
  if (issue.code === 'unknown-node') return issue.message
  if (issue.code === 'no-evidence') return `「${issue.name}」没有一条出处在原文里`
  return issue.message ?? issue.code
}
