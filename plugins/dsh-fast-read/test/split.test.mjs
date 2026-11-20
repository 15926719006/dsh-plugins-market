import assert from 'node:assert/strict'
import test from 'node:test'

import { charCount } from '../src/host/lib/text.js'
import { isHeading, splitChapters } from '../src/host/formats/split.js'

test('isHeading recognises chapter openers and rejects sentences', () => {
  assert.equal(isHeading('第一章 一张愤怒的脸'), true)
  assert.equal(isHeading('Chapter 3'), true)
  assert.equal(isHeading('结语'), true)
  assert.equal(isHeading('第一章的内容非常长，长到不像标题。'), false)
})

test('splitChapters starts a chapter at a heading', () => {
  const text = ['第一章', '甲段。', '乙段。', '第二章', '丙段。'].join('\n')
  const chapters = splitChapters(text, { minChars: 1 })
  assert.equal(chapters.length, 2)
  assert.equal(chapters[0].title, '第一章')
  assert.equal(chapters[0].text, '甲段。\n乙段。')
  assert.equal(chapters[1].title, '第二章')
})

test('splitChapters never leaves a chapter above the target', () => {
  const long = Array.from({ length: 20 }, () => '字'.repeat(800)).join('\n')
  const chapters = splitChapters(`引言\n${long}`, { targetMax: 6000 })
  assert.ok(chapters.length >= 3)
  for (const chapter of chapters) {
    assert.ok(charCount(chapter.text) <= 6000, `${chapter.title} is too long`)
  }
})

test('splitChapters merges tiny chapters without losing words', () => {
  const text = ['第一章', '甲'.repeat(500), '第二章', '乙'.repeat(500), '第三章', '丙'.repeat(3000)].join('\n')
  const chapters = splitChapters(text, { minChars: 800 })
  assert.equal(chapters.length, 2)
  assert.ok(chapters[0].text.includes('乙'))
})
