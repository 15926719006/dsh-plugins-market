import assert from 'node:assert/strict'
import test from 'node:test'

import { createTool } from '../src/host/tool.js'

const ctx = {
  get: () => ({ get: () => '/tmp/workspace' }),
}

test('book_read renders the chapter text, not only its summary', () => {
  const tool = createTool('book_read', {}, ctx)
  const blocks = tool.output.render(
    { bookId: 'b1', chapter: 2 },
    {
      ok: true,
      summary: '第 2 章「转折」（共 900 字），本次 400 字；接着从 offset 400 读。',
      data: { bookId: 'b1', chapter: 2, text: '这是正文第一行。\n这是第二行。', nextOffset: 400 },
    },
  )
  const joined = blocks.map((block) => block.text ?? '').join('\n')
  assert.match(joined, /这是正文第一行/)
  assert.match(joined, /offset: 400/)
})

test('book_read omits the continue hint on the last window', () => {
  const tool = createTool('book_read', {}, ctx)
  const blocks = tool.output.render(
    { bookId: 'b1', chapter: 1 },
    { ok: true, summary: '读完', data: { bookId: 'b1', chapter: 1, text: '正文', nextOffset: null } },
  )
  assert.equal(blocks.some((block) => String(block.text).includes('[续读]')), false)
})

test('other tools render only their summary', () => {
  const tool = createTool('book_state', {}, ctx)
  const blocks = tool.output.render({}, { ok: true, summary: '书架为空', data: {} })
  assert.deepEqual(blocks, [{ type: 'text', text: '书架为空' }])
})
