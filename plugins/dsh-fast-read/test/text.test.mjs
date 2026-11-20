import assert from 'node:assert/strict'
import test from 'node:test'

import { bookIdOf, lineOfOffset, normalizeForMatch, stripHtml } from '../src/host/lib/text.js'

test('stripHtml keeps paragraph boundaries and drops markup', () => {
  const text = stripHtml('<h1>第一章</h1><p>他  说&nbsp;话。</p><script>x()</script>')
  assert.equal(text, '第一章\n他 说 话。')
})

test('normalizeForMatch ignores whitespace, width and case', () => {
  assert.equal(normalizeForMatch('第 一 章　A“引”'), '第一章a"引"')
})

test('bookIdOf keeps ascii titles and always carries a hash', () => {
  assert.match(bookIdOf('Hillbilly Elegy', 'seed'), /^hillbilly-elegy-[0-9a-f]{8}$/)
  assert.match(bookIdOf('乡下人的悲歌', 'seed'), /^book-[0-9a-f]{8}$/)
})

test('lineOfOffset counts from one', () => {
  assert.equal(lineOfOffset('a\nb\nc', 0), 1)
  assert.equal(lineOfOffset('a\nb\nc', 3), 2)
  assert.equal(lineOfOffset('a\nb\nc', 4), 3)
  assert.equal(lineOfOffset('a\nb\nc', 999), 3)
})
