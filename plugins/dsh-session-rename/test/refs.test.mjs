/**
 * The extraction tests, built from real links found in this machine's session
 * logs (233 logs scanned 2026-11-10) rather than invented ones.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  findDevopsRefs,
  parseDevopsUrl,
  isDevopsUrl,
  kindOfRef,
  primaryDevopsRef,
} from '../lib/devops/devops-refs.mjs'

/** One link and what it must be read as. */
const REAL_LINKS = [
  // 需求单 — the hash router, the query the row button adds, and a bare hash route.
  {
    url: 'https://devops.ronhan.com/#demand/RO-20261027-008?mode=edit',
    kind: 'demand',
    ref: 'RO-20261027-008',
  },
  { url: 'https://devops.ronhan.com/#demand/RO-20261020-018', kind: 'demand', ref: 'RO-20261020-018' },
  {
    url: 'https://devops.ronhan.com/#demand/RO-20261020-018?mode=edit&from=%23personal-todo',
    kind: 'demand',
    ref: 'RO-20261020-018',
  },
  { url: 'https://devops.ronhan.com/#/demand/RO-20261023-040', kind: 'demand', ref: 'RO-20261023-040' },
  { url: 'https://devops.ronhan.com/demand/RO-20261027-008', kind: 'demand', ref: 'RO-20261027-008' },

  // 任务 — by taskNo, by number in both routers, and by the 19-digit id.
  { url: 'https://devops.ronhan.com/#task/T-20261026-016', kind: 'task', ref: 'T-20261026-016' },
  { url: 'https://devops.ronhan.com/#/task/T-20261026-016?', kind: 'task', ref: 'T-20261026-016' },
  { url: 'https://devops.ronhan.com/task/T-20261023-012', kind: 'task', ref: 'T-20261023-012' },
  {
    url: 'https://devops.ronhan.com/task/T-20261026-016#task-management',
    kind: 'task',
    ref: 'T-20261026-016',
  },
  { url: 'https://devops.ronhan.com/task/373000146054680576', kind: 'task', ref: '373000146054680576' },
  { url: 'https://devops.ronhan.com/task/detail/373000146054680576', kind: 'task', ref: '373000146054680576' },

  // 发布单 — the orderId query, the hash routes, and the path route.
  {
    url: 'https://devops.ronhan.com/release/order/detail?orderId=RO-20261020-018',
    kind: 'release',
    ref: 'RO-20261020-018',
  },
  { url: 'https://devops.ronhan.com/#release/RO-20260922-001', kind: 'release', ref: 'RO-20260922-001' },
  {
    url: 'https://devops.ronhan.com/#release/order/RO-20261028-007?mode=edit',
    kind: 'release',
    ref: 'RO-20261028-007',
  },
  {
    url: 'https://devops.ronhan.com/release/order/detail/RO-20260922-001',
    kind: 'release',
    ref: 'RO-20260922-001',
  },

  // 专项 and 子任务.
  { url: 'https://devops.ronhan.com/project-management/P-20260908-001', kind: 'project', ref: 'P-20260908-001' },
  {
    url: 'https://devops.ronhan.com/#project-management/P-20260908-001',
    kind: 'project',
    ref: 'P-20260908-001',
  },
  { url: 'https://devops.ronhan.com/subtask/RO-20260911-026-S04', kind: 'subtask', ref: 'RO-20260911-026-S04' },

  // A link that went through the login redirect still names its record.
  {
    url: 'https://devops.ronhan.com/login?redirect=%2Ftask%2Fdetail%2F373000146054680576',
    kind: 'task',
    ref: '373000146054680576',
  },
  {
    url: 'https://devops.ronhan.com/login?redirect=%2Frelease%2Forder%2Fdetail%3ForderId%3DRO-20261020-018',
    kind: 'release',
    ref: 'RO-20261020-018',
  },

  // Never seen as a link in the logs, but the record types exist: read them
  // the way the platform would publish them.
  { url: 'https://devops.ronhan.com/#defect/BUG-20261022-006', kind: 'defect', ref: 'BUG-20261022-006' },
  { url: 'https://devops.ronhan.com/issue/ON3-66776', kind: 'issue', ref: 'ON3-66776' },
]

test('every real link shape is read into its kind and number', () => {
  for (const { url, kind, ref } of REAL_LINKS) {
    const parsed = parseDevopsUrl(url)
    assert.ok(parsed, `expected ${url} to parse`)
    assert.equal(parsed.kind, kind, `${url} → kind`)
    assert.equal(parsed.ref, ref, `${url} → ref`)
    assert.equal(parsed.source, 'url', `${url} → source`)
    assert.equal(parsed.url, url, `${url} → url is kept verbatim`)
  }
})

test('a release order link is read as a release, not as the demand of the same number', () => {
  // The clash that matters: one RO number is both a 需求单 and its 发布单.
  const release = parseDevopsUrl('https://devops.ronhan.com/#release/RO-20261020-018')
  const demand = parseDevopsUrl('https://devops.ronhan.com/#demand/RO-20261020-018')
  assert.equal(release.kind, 'release')
  assert.equal(demand.kind, 'demand')
  assert.equal(release.ref, demand.ref)
})

test('links are found inside prose, markdown and Chinese punctuation', () => {
  const text = [
    '先看 [这个需求](https://devops.ronhan.com/#demand/RO-20261027-008?mode=edit)，',
    '再看 https://devops.ronhan.com/#task/T-20261026-016。',
    '还有（https://devops.ronhan.com/#demand/RO-20260917-099）。',
  ].join('\n')
  const refs = findDevopsRefs(text)
  assert.deepEqual(
    refs.map((ref) => `${ref.kind}:${ref.ref}`),
    ['demand:RO-20261027-008', 'task:T-20261026-016', 'demand:RO-20260917-099'],
  )
  // The closing bracket and the Chinese full stop are not part of the address.
  assert.equal(refs[0].url, 'https://devops.ronhan.com/#demand/RO-20261027-008?mode=edit')
  assert.equal(refs[2].url, 'https://devops.ronhan.com/#demand/RO-20260917-099')
})

test('bare numbers in prose are found too, with the kind their shape implies', () => {
  const text = '进度：RO-20261023-040 已提测，T-20261026-016 收尾，BUG-20261022-006 已修，ON3-66776 关闭，P-20260908-001 在做。'
  const refs = findDevopsRefs(text)
  assert.deepEqual(
    refs.map((ref) => `${ref.kind}:${ref.ref}:${ref.source}`),
    [
      'demand:RO-20261023-040:text',
      'task:T-20261026-016:text',
      'defect:BUG-20261022-006:text',
      'issue:ON3-66776:text',
      'project:P-20260908-001:text',
    ],
  )
  assert.equal(refs[0].url, null)
})

test('a subtask number is not read as its parent demand', () => {
  const refs = findDevopsRefs('子任务 RO-20260911-026-S04 已完成，父需求 RO-20260911-026 还在测')
  assert.deepEqual(
    refs.map((ref) => `${ref.kind}:${ref.ref}`),
    ['subtask:RO-20260911-026-S04', 'demand:RO-20260911-026'],
  )
})

test('references are deduplicated but keep first-appearance order', () => {
  const text = [
    'https://devops.ronhan.com/#task/T-20261026-016',
    'https://devops.ronhan.com/#demand/RO-20261027-008?mode=edit',
    'T-20261026-016',
    'https://devops.ronhan.com/#task/T-20261026-016',
    'RO-20261027-008',
  ].join(' ')
  const refs = findDevopsRefs(text)
  assert.deepEqual(
    refs.map((ref) => `${ref.kind}:${ref.ref}`),
    ['task:T-20261026-016', 'demand:RO-20261027-008'],
  )
})

test('a number inside a link is reported once, from the link', () => {
  // The `RO-…` here must not also appear as a bare demand.
  const refs = findDevopsRefs('https://devops.ronhan.com/#release/RO-20260922-001')
  assert.equal(refs.length, 1)
  assert.equal(refs[0].kind, 'release')
  assert.equal(refs[0].source, 'url')
})

test('API paths and unrelated text yield nothing', () => {
  const cases = [
    'curl https://devops.ronhan.com/api/devops/demand/query',
    'curl https://devops.ronhan.com/api/devops/subtask/list-by-parent',
    'https://devops.ronhan.com/#demand/RO-xxx',
    'https://devops.ronhan.com/#demand/RO-...',
    'https://devops.ronhan.com/login',
    'https://devops.ronhan.com',
    'no devops link in this sentence at all',
    '',
  ]
  for (const text of cases) {
    assert.deepEqual(findDevopsRefs(text), [], `expected nothing from ${JSON.stringify(text)}`)
  }
})

test('a boolean, a number and a null are tolerated as text', () => {
  assert.deepEqual(findDevopsRefs(null), [])
  assert.deepEqual(findDevopsRefs(undefined), [])
  assert.deepEqual(findDevopsRefs(42), [])
})

test('a 19-digit id alone is not read from prose, only from a route', () => {
  assert.deepEqual(findDevopsRefs('订单号 373292020174819328 已支付'), [])
  assert.equal(parseDevopsUrl('https://devops.ronhan.com/task/373292020174819328').ref, '373292020174819328')
})

test('the host test accepts the platform and nothing else', () => {
  assert.equal(isDevopsUrl('https://devops.ronhan.com/#demand/RO-1'), true)
  assert.equal(isDevopsUrl('http://devops.ronhan.com'), true)
  assert.equal(isDevopsUrl('https://devops.ronhan.com.evil.test/#demand/RO-1'), false)
  assert.equal(isDevopsUrl('https://confluence.ronhan.com/x'), false)
  assert.equal(isDevopsUrl(null), false)
})

test('the shape of a bare number decides its kind', () => {
  assert.equal(kindOfRef('RO-20261027-008'), 'demand')
  assert.equal(kindOfRef('RO-20260911-026-S04'), 'subtask')
  assert.equal(kindOfRef('T-20261026-016'), 'task')
  assert.equal(kindOfRef('BUG-20261022-006'), 'defect')
  assert.equal(kindOfRef('ON3-66776'), 'issue')
  assert.equal(kindOfRef('P-20260908-001'), 'project')
  assert.equal(kindOfRef('373000146054680576'), null)
  assert.equal(kindOfRef('nonsense'), null)
})

test('the primary reference prefers a real link over a bare number', () => {
  const refs = findDevopsRefs('RO-20261020-018 见 https://devops.ronhan.com/task/373000146054680576')
  const primary = primaryDevopsRef(refs)
  assert.equal(primary.kind, 'task')
  assert.equal(primary.source, 'url')
  assert.equal(primaryDevopsRef([]), null)
})
