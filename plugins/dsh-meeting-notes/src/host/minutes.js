/**
 * 纪要生成：把这场会的原文交给 DSH 当前模型，产出一份给自己看的中文纪要。
 *
 * 只用 `ctx.llm.stream`（Host 侧唯一受支持的模型调用入口），不建会话、不写会话日志。
 * 输出契约：Markdown；第一行 `# 标题`，第二行 `> 摘要：...`，其余按模板分节。
 */
import { flattenEntries, localMinute } from './store.js'
import { formatClock } from './wav.js'

/** 原文太长时按这个长度截断（正常 1 小时会议约 1.5 万字，远够用）。 */
const MAX_TRANSCRIPT_CHARS = 200_000

export const MINUTES_SYSTEM = [
  '你是一名严谨的中文会议记录员。你只依据用户给出的会议原文写纪要，不编造任何事实。',
  '原文里说话人只有两种标签：「我」是用户本人，「对方」是会议里的其他人。',
  '不要写客套话，不要复述全文，不要输出与模板无关的内容。',
].join('\n')

/** 组装提示词。 */
export function buildMinutesPrompt({ meta, transcript }) {
  const entries = flattenEntries(transcript)
  const lines = []
  for (const entry of entries) {
    const label = entry.speaker === 'me' ? '我' : entry.speaker === 'them' ? '对方' : ''
    const prefix = entry.startMs === null || entry.startMs === undefined ? '' : `[${formatClock(entry.startMs)}] `
    lines.push(`${prefix}${label === '' ? '' : `${label}：`}${entry.text}`)
  }
  let body = lines.join('\n')
  let truncated = false
  if (body.length > MAX_TRANSCRIPT_CHARS) {
    body = body.slice(0, MAX_TRANSCRIPT_CHARS)
    truncated = true
  }
  const startedAt = meta?.startedAt === undefined ? '未知' : localMinute(new Date(meta.startedAt))
  const duration = formatClock(meta?.durationMs ?? 0)
  const prompt = [
    `下面是会议「${meta?.title ?? '未命名会议'}」的逐字原文。`,
    '',
    `- 时间：${startedAt}`,
    `- 时长：${duration}`,
    truncated ? '- 注意：原文过长，后面被截断了，没出现的内容不要猜。' : '',
    '',
    '请按下面的结构输出 Markdown（严格用这些标题，不要加额外的开场白）：',
    '',
    '# <会议标题：10-20 字，概括这场会谈了什么，不要照抄我给的名字>',
    '> 摘要：<两三句话：讨论了什么、达成了什么、下一步是什么>',
    '',
    '## 会议信息',
    '- 时间：' + startedAt,
    '- 时长：' + duration,
    '',
    '## 议题与讨论要点',
    '<按议题分小节写要点；有分歧、有取舍、有数字的地方要写清楚；每个小节 3-6 句>',
    '',
    '## 结论与决定',
    '<只写会上明确拍板/确认的事项；一条都没有就写「本次没有明确拍板的事项」>',
    '',
    '## 待办',
    '| 事项 | 负责人 | 期限 |',
    '| --- | --- | --- |',
    '<从原文里找「我/某某跟进」「下周给」「回去确认」这类；负责人和期限原文没说的写「未明确」>',
    '',
    '## 风险与未决',
    '<还没定、有风险、需要外部输入的事；没有就写「无」>',
    '',
    '## 关键原话',
    '<3-6 条最能代表这场会的原话，保留说话人和时间戳，格式：`[00:12] 对方：...`>',
    '',
    '会议原文：',
    '"""',
    body,
    '"""',
  ]
    .filter((line) => line !== '')
    .join('\n')
  return prompt
}

/**
 * 从模型输出里拆出标题与摘要，顺便做兜底。
 * @returns {{ markdown: string, title: string, summary: string }}
 */
export function parseMinutes(markdown, fallbackTitle = '未命名会议') {
  const text = String(markdown ?? '').replace(/\r\n/gu, '\n').trim()
  let title = ''
  let summary = ''
  const lines = text.split('\n')
  for (const line of lines) {
    const heading = /^#{1,3}\s+(.+)$/u.exec(line.trim())
    if (heading !== null && title === '') {
      title = heading[1].trim()
      continue
    }
    const quote = /^>\s*(?:摘要[:：])?\s*(.+)$/u.exec(line.trim())
    if (quote !== null && summary === '' && title !== '') {
      summary = quote[1].trim()
      continue
    }
    if (title !== '' && summary !== '') break
  }
  if (title === '') title = fallbackTitle
  if (summary === '') {
    const paragraph = text.split(/\n{2,}/u).map((block) => block.trim()).find((block) => block !== '' && !block.startsWith('#'))
    summary = paragraph === undefined ? '' : paragraph.replace(/\n/gu, ' ').slice(0, 120)
  }
  return { markdown: text === '' ? '' : `${text}\n`, title: title.slice(0, 60), summary: summary.slice(0, 200) }
}

/** 从 stream 块里取出正文。 */
export function textOfChunk(chunk) {
  if (chunk === null || typeof chunk !== 'object') return ''
  if (chunk.type === 'text-delta' && typeof chunk.text === 'string') return chunk.text
  return ''
}

/**
 * 调模型生成纪要。
 * @param {{ ctx: any, meta: object, transcript: object, config?: object, signal?: AbortSignal }} options
 */
export async function generateMinutes({ ctx, meta, transcript, config = {}, signal }) {
  const llm = ctx?.llm
  if (llm === undefined || llm === null) throw new Error('当前环境没有可用的模型服务（ctx.llm）')
  let provider = typeof config.minutesProvider === 'string' && config.minutesProvider !== '' ? config.minutesProvider : null
  let model = typeof config.minutesModel === 'string' && config.minutesModel !== '' ? config.minutesModel : null
  if (provider === null || model === null) {
    let selection = null
    try {
      selection = ctx.agentDefaultModel?.currentSelection?.() ?? null
    } catch {
      selection = null
    }
    if (selection === null || typeof selection.provider !== 'string') throw new Error('拿不到默认模型选择（agentDefaultModel）')
    provider = provider ?? selection.provider
    model = model ?? selection.model
  }
  const prompt = buildMinutesPrompt({ meta, transcript })
  const parts = []
  const stream = llm.stream({
    provider,
    model,
    system: MINUTES_SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    maxTokens: 4096,
    temperature: 0.2,
    signal,
  })
  for await (const chunk of stream) {
    const text = textOfChunk(chunk)
    if (text !== '') parts.push(text)
  }
  const raw = parts.join('')
  if (raw.trim() === '') throw new Error('模型没有返回内容')
  const parsed = parseMinutes(raw, meta?.title ?? '未命名会议')
  return { ...parsed, provider, model }
}
