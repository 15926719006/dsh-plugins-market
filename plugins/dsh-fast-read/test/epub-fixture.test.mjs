import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseEpub } from '../src/host/formats/epub.js'

/**
 * Build a real EPUB on disk (calibre-like layout) so the parser meets a book,
 * not a hand-written string.
 * @returns {string} the archive path.
 */
function buildEpub() {
  const dir = mkdtempSync(join(tmpdir(), 'fast-read-epub-'))
  const work = join(dir, 'book')
  mkdirSync(join(work, 'META-INF'), { recursive: true })
  mkdirSync(join(work, 'OEBPS'), { recursive: true })
  writeFileSync(join(work, 'mimetype'), 'application/epub+zip')
  writeFileSync(join(work, 'META-INF/container.xml'), `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`)
  const chapters = ['引言', '第一章 起点', '第二章 转折', '第三章 收束']
  const manifest = []
  const spine = []
  chapters.forEach((title, index) => {
    const id = `ch${index + 1}`
    const file = `${id}.xhtml`
    manifest.push(`<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>`)
    spine.push(`<itemref idref="${id}"/>`)
    const body = Array.from({ length: 40 }, (_, line) =>
      `${title}的第${line + 1}段：这是一段用来验证章节切分、字号上限与出处引用的中文正文。`).join('\n<p>')
    writeFileSync(join(work, 'OEBPS', file), `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head>
<body><h1>${title}</h1><p>${body}</p></body></html>`)
  })
  writeFileSync(join(work, 'OEBPS/content.opf'), `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>结构验证之书</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>${manifest.join('')}</manifest>
  <spine>${spine.join('')}</spine>
</package>`)
  const target = join(dir, 'book.epub')
  execFileSync('/usr/bin/zip', ['-q', '-X', '-r', target, 'mimetype', 'META-INF', 'OEBPS'], { cwd: work })
  return target
}

test('parseEpub reads a calibre-shaped EPUB end to end', () => {
  const path = buildEpub()
  const book = parseEpub(execFileSync('/bin/cat', [path]))
  assert.equal(book.title, '结构验证之书')
  assert.equal(book.author, '测试作者')
  assert.ok(book.chapters.length >= 3, `only ${book.chapters.length} chapters`)
  assert.ok(book.chapters.some((chapter) => chapter.text.includes('第二章')))
  for (const chapter of book.chapters) {
    assert.ok(chapter.text.length <= 6000, `${chapter.title} is longer than the extraction window`)
    assert.ok(!/<[a-z]/i.test(chapter.text), 'markup leaked into chapter text')
  }
})
