/**
 * The extraction protocol.
 *
 * This is the part a model has to get right, so it is written as instructions
 * rather than as prose about the design: what to read, what to produce, what
 * gets rejected, and in which order. `book_state(action:'protocol')` returns it
 * verbatim, which keeps it versioned with the tools instead of living in a
 * prompt somewhere.
 */

export const PROTOCOL_VERSION = 1

export const PROTOCOL = `# 速读抽取协议 v${PROTOCOL_VERSION}

## 目标
把一本书拆成一组可回溯的知识节点：每个节点、每条关系都带原文出处。
宁可少抽，也不要抽一条对不上原文的内容。

## 步骤

1. \`book_import\`：给出书籍路径或文本。返回 bookId 与章节表。
   - 返回里的 \`estimate\` 是这本书预计的模型调用次数，先看一眼再决定跑不跑。
2. 对每一章按顺序：
   a. \`book_read({ bookId, chapter, offset })\` 取正文窗口（默认 8000 字；返回 nextOffset 就继续读）。
   b. 抽取：5–12 个概念、5–15 条关系、1 句章节摘要。
   c. \`book_record({ bookId, kind: 'nodes', payload: [...] })\` 写入节点。
   d. \`book_record({ bookId, kind: 'edges', payload: [...] })\` 写入关系。
   e. \`book_record({ bookId, kind: 'chapter-summary', payload: { chapter, summary } })\` 记进度。
3. 所有章节完成后：
   - \`book_record({ bookId, kind: 'guide', payload: '<Markdown>' })\` 写导读。
   - \`book_record({ bookId, kind: 'mindmap', payload: { root: {...} } })\` 写脑图。
4. \`book_state({ bookId })\` 检查进度，nextSteps 会告诉你下一步。

## 节点格式

payload 一律是对象：节点用 { "nodes": [ … ] }，关系用 { "edges": [ … ] }。

\`\`\`json
{
  "name": "系统 1",
  "type": "concept",
  "summary": "一两句话说明它是什么、为什么重要。",
  "weight": 4,
  "evidence": [{ "chapter": 1, "quote": "系统1是自动运行的。" }]
}
\`\`\`

- \`type\`: concept | claim | mechanism | example | person | term | method
- \`weight\`: 1–5，5 = 全书核心命题，3 = 重要支撑，1 = 边角术语
- \`evidence[].quote\`：必须从 \`book_read\` 返回的正文里**原样复制**一行（8–200 字），不要改写、不要拼接两处。
- 同一个概念在不同章节重复出现时，用相同的 \`name\` 再提交一次即可，服务端会合并并累加出处。

## 关系格式

\`\`\`json
{
  "source": "系统 1",
  "target": "锚定效应",
  "type": "causes",
  "label": "导致",
  "evidence": { "chapter": 2, "quote": "锚定效应是系统1的一个直接后果。" }
}
\`\`\`

- \`type\`: causes | supports | contradicts | evolves | part_of | example_of | depends_on | same_as
- source/target 可以用节点 id，也可以用节点名。
- 每条关系同样必须有出处。

## 导读要求

Markdown，包含六段：这本书在回答什么 / 作者的核心主张 / 全书结构地图 / 建议阅读顺序（按依赖，不按页码）/ 每章一句话 / 读完后你能做什么。

## 脑图格式

\`\`\`json
{ "root": { "name": "书名", "children": [
  { "name": "第一部分", "children": [ { "name": "系统 1", "nodeId": "n-xxxxxxxx" } ] }
] } }
\`\`\`

最多 5 层、400 个条目；叶子用 \`nodeId\` 指向已有节点。

## 会被拒收的情况

- 引用的句子在对应章节里找不到 → 返回 \`nearest\`（最接近的原文），照它改正后重提。
- 节点没有出处、名字超过 40 字、关系指向不存在的节点。
- 章节号不存在。

## 省时间的原则

- 一章一次抽取，不要把整本书塞进一次请求。
- 先跑「共 15 章」的骨架（每章节点+摘要），再按 TODO 补关系与导读。
- 用户随时可以停；\`book_state\` 会从断点继续。
`
