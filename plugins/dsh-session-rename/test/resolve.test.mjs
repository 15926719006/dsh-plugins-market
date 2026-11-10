/**
 * The resolver tests: no network. Every answer here is a mock shaped exactly
 * like the platform's real one (captured 2026-11-10 — an unknown demand really
 * does answer HTTP 500 with an empty body, and an unknown issue really does
 * answer `respCode: "ISSUE_NOT_FOUND"`).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveDevopsTitle, resolveFirstDevopsTitle, formatDevopsPrefix } from '../lib/devops/devops-resolve.mjs'
import { findDevopsRefs } from '../lib/devops/devops-refs.mjs'

const CREDENTIALS = { baseUrl: 'https://devops.ronhan.com', token: 'rhk_test_token_value', source: 'test' }

/**
 * A fetch that answers from a table and records every call.
 * @param {(call: { url: string, method: string, body?: string }) => Promise<{ status?: number, body: string }>|{ status?: number, body: string }} handler - the answers.
 * @returns {typeof fetch & { calls: Array<{ url: string, method: string, headers: Record<string,string>, body?: string }> }} the fetch.
 */
function mockFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method,
      headers: init.headers ?? {},
      body: init.body,
      signal: init.signal,
    }
    calls.push(call)
    const answer = await handler(call)
    const status = answer.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => answer.body,
    }
  }
  impl.calls = calls
  return impl
}

/**
 * The platform's success envelope.
 * @param {unknown} data - the payload.
 * @returns {{ status: number, body: string }} the answer.
 */
function ok(data) {
  return { status: 200, body: JSON.stringify({ respCode: '20000', respMsg: 'Success', data }) }
}

/**
 * The platform's refusal envelope.
 * @param {string} respCode - the platform's own code (sometimes a word).
 * @param {string} respMsg - the platform's own message.
 * @param {number} status - the HTTP status it came with.
 * @returns {{ status: number, body: string }} the answer.
 */
function refused(respCode, respMsg, status) {
  return { status, body: JSON.stringify({ respCode, respMsg, data: null }) }
}

test('a demand link resolves to the platform number and title', async () => {
  const fetchImpl = mockFetch(() =>
    ok({
      order: { id: '373292020174819328', orderId: 'RO-20261027-008', title: '收银台支付结果倒计时不跳转修复及 returnUrl 兜底' },
      demand: { id: '373292020174819329' },
    }),
  )
  const result = await resolveDevopsTitle({ kind: 'demand', ref: 'RO-20261027-008' }, CREDENTIALS, fetchImpl)
  assert.deepEqual(result, {
    number: 'RO-20261027-008',
    title: '收银台支付结果倒计时不跳转修复及 returnUrl 兜底',
  })
  assert.equal(fetchImpl.calls.length, 1)
  assert.equal(fetchImpl.calls[0].method, 'GET')
  assert.equal(fetchImpl.calls[0].url, 'https://devops.ronhan.com/api/devops/demand/detail/RO-20261027-008')
  assert.equal(fetchImpl.calls[0].headers.authorization, 'Bearer rhk_test_token_value')
})

test('an unknown demand answers 500 with an empty body, so demand/query is used instead', async () => {
  const fetchImpl = mockFetch((call) => {
    if (call.url.includes('/demand/detail/')) return { status: 500, body: '' }
    if (call.url.includes('/demand/query')) {
      return ok({ list: [{ orderId: 'RO-20261030-001', title: '退款单列表导出' }], total: 1 })
    }
    throw new Error(`unexpected ${call.url}`)
  })
  const result = await resolveDevopsTitle('RO-20261030-001', CREDENTIALS, fetchImpl)
  assert.deepEqual(result, { number: 'RO-20261030-001', title: '退款单列表导出' })
  assert.deepEqual(
    fetchImpl.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`),
    ['GET /api/devops/demand/detail/RO-20261030-001', 'POST /api/devops/demand/query'],
  )
  assert.deepEqual(JSON.parse(fetchImpl.calls[1].body), {
    pageNum: 1,
    pageSize: 5,
    orderId: 'RO-20261030-001',
  })
})

test('a task resolves by taskNo and by its 19-digit id', async () => {
  const answers = (taskNo) => () =>
    ok({
      id: '373000146054680576',
      taskNo,
      name: '前端组 AI 工具使用规范落地：AI 工作链路与记忆 Skill 体系建设',
      status: 'COMPLETED',
    })

  const byNumber = await resolveDevopsTitle(
    { kind: 'task', ref: 'T-20261026-016' },
    CREDENTIALS,
    mockFetch(answers('T-20261026-016')),
  )
  assert.deepEqual(byNumber, {
    number: 'T-20261026-016',
    title: '前端组 AI 工具使用规范落地：AI 工作链路与记忆 Skill 体系建设',
  })

  const byId = await resolveDevopsTitle(
    { kind: 'task', ref: '373000146054680576' },
    CREDENTIALS,
    mockFetch(answers('T-20261026-016')),
  )
  assert.equal(byId.number, 'T-20261026-016')
})

test('a bare 19-digit id is read as a task', async () => {
  const fetchImpl = mockFetch(() => ok({ id: '373000146054680576', taskNo: 'T-20261026-016', name: '任务名' }))
  const result = await resolveDevopsTitle('373000146054680576', CREDENTIALS, fetchImpl)
  assert.deepEqual(result, { number: 'T-20261026-016', title: '任务名' })
  assert.equal(fetchImpl.calls[0].url, 'https://devops.ronhan.com/api/devops/task/detail/373000146054680576')
})

test('an issue resolves through the Jira mirror route', async () => {
  const fetchImpl = mockFetch(() =>
    ok({
      key: 'ON3-66776',
      summary: 'googlepay 收银台支付出现两次 fistname和lastname',
      type: '缺陷',
      status: '关闭',
    }),
  )
  const result = await resolveDevopsTitle({ kind: 'issue', ref: 'ON3-66776' }, CREDENTIALS, fetchImpl)
  assert.deepEqual(result, { number: 'ON3-66776', title: 'googlepay 收银台支付出现两次 fistname和lastname' })
  assert.equal(fetchImpl.calls[0].url, 'https://devops.ronhan.com/api/devops/issue/query?key=ON3-66776')
})

test('a release order resolves as a release order, not as its demand', async () => {
  const fetchImpl = mockFetch((call) => {
    if (call.url.endsWith('/release/order/detail')) {
      return ok({ id: '370757127452626944', orderId: 'RO-20261020-018', title: 'PAYPRO - PayPal能力接入' })
    }
    throw new Error(`unexpected ${call.url}`)
  })
  const result = await resolveDevopsTitle({ kind: 'release', ref: 'RO-20261020-018' }, CREDENTIALS, fetchImpl)
  assert.deepEqual(result, { number: 'RO-20261020-018', title: 'PAYPRO - PayPal能力接入' })
  assert.equal(fetchImpl.calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].body), { orderId: 'RO-20261020-018' })
})

test('project, defect and subtask resolve through their detail routes', async () => {
  const cases = [
    ['project', 'P-20260908-001', { projectNo: 'P-20260908-001', name: 'PPOW整合一期' }, '/api/devops/project/detail/P-20260908-001'],
    ['defect', 'BUG-20261022-006', { defectNo: 'BUG-20261022-006', name: 'paymentlink订阅页面金额错误' }, '/api/devops/defect/detail/BUG-20261022-006'],
    [
      'subtask',
      'RO-20260911-026-S04',
      { subtaskNo: 'RO-20260911-026-S04', name: '前后端联调与自测' },
      '/api/devops/subtask/detail/RO-20260911-026-S04',
    ],
  ]
  for (const [kind, ref, data, path] of cases) {
    const fetchImpl = mockFetch(() => ok(data))
    const result = await resolveDevopsTitle({ kind, ref }, CREDENTIALS, fetchImpl)
    assert.equal(result.number, data.projectNo ?? data.defectNo ?? data.subtaskNo)
    assert.equal(result.title, data.name)
    assert.equal(new URL(fetchImpl.calls[0].url).pathname, path)
  }
})

test('every "no" from the platform becomes null, and nothing throws', async () => {
  const answers = [
    refused('40100', 'API Key 不存在', 401),
    refused('40400', '任务不存在：taskNo=T-20200101-001', 404),
    refused('40004', '发布单 RO-20200101-001 不存在', 404),
    refused('ISSUE_NOT_FOUND', 'Issue ON3-99999999 不存在', 404),
    { status: 500, body: '' },
    { status: 502, body: '<html>bad gateway</html>' },
    { status: 200, body: '' },
    { status: 200, body: '{}' },
    ok(null),
  ]
  for (const answer of answers) {
    const result = await resolveDevopsTitle(
      { kind: 'task', ref: 'T-20200101-001' },
      CREDENTIALS,
      mockFetch(() => answer),
    )
    assert.equal(result, null, `expected null for ${JSON.stringify(answer)}`)
  }
})

test('a network failure is silent', async () => {
  const fetchImpl = mockFetch(() => {
    throw new Error('ECONNREFUSED')
  })
  assert.equal(await resolveDevopsTitle('RO-20261027-008', CREDENTIALS, fetchImpl), null)
})

test('a slow platform is abandoned at the timeout, in under a second', async () => {
  const fetchImpl = (url, init = {}) =>
    new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted.')
        error.name = 'AbortError'
        reject(error)
      })
    })
  const started = Date.now()
  const result = await resolveDevopsTitle('RO-20261027-008', CREDENTIALS, fetchImpl, { timeoutMs: 50 })
  const elapsed = Date.now() - started
  assert.equal(result, null)
  assert.ok(elapsed < 2000, `expected to give up quickly, took ${elapsed} ms`)
})

test('without a token nothing is requested at all', async () => {
  for (const credentials of [null, undefined, {}, { baseUrl: 'https://devops.ronhan.com', token: '' }]) {
    const fetchImpl = mockFetch(() => ok({ order: { orderId: 'RO-1', title: 'x' } }))
    assert.equal(await resolveDevopsTitle('RO-20261027-008', credentials, fetchImpl), null)
    assert.equal(fetchImpl.calls.length, 0, 'no request should be made without a token')
  }
})

test('a defect id that is numeric is not requested, because detail would only answer 40400', async () => {
  const fetchImpl = mockFetch(() => ok({ defectNo: 'BUG-20261022-006', name: 'x' }))
  const result = await resolveDevopsTitle({ kind: 'defect', ref: '371623419097255936' }, CREDENTIALS, fetchImpl)
  assert.equal(result, null)
  assert.equal(fetchImpl.calls.length, 0)
})

test('a missing fetch implementation and a hopeless ref are both null', async () => {
  // `null` and a non-function are both refused before any request is made;
  // an omitted fetch impl deliberately falls back to the global one.
  assert.equal(await resolveDevopsTitle('RO-20261027-008', CREDENTIALS, null), null)
  assert.equal(await resolveDevopsTitle('RO-20261027-008', CREDENTIALS, 'not-a-fetch'), null)
  assert.equal(await resolveDevopsTitle('', CREDENTIALS, mockFetch(() => ok({}))), null)
  assert.equal(await resolveDevopsTitle({ kind: 'nonsense', ref: 'X-1' }, CREDENTIALS, mockFetch(() => ok({}))), null)
})

test('the base URL may carry a trailing slash without doubling it', async () => {
  const fetchImpl = mockFetch(() => ok({ taskNo: 'T-20261026-016', name: '任务名' }))
  await resolveDevopsTitle('T-20261026-016', { baseUrl: 'https://devops.ronhan.com/', token: 'k' }, fetchImpl)
  assert.equal(fetchImpl.calls[0].url, 'https://devops.ronhan.com/api/devops/task/detail/T-20261026-016')
})

test('the first reference that answers is the one used', async () => {
  const fetchImpl = mockFetch((call) => {
    if (call.url.includes('/demand/detail/')) return refused('40400', '需求不存在', 404)
    if (call.url.includes('/demand/query')) return ok({ list: [] })
    if (call.url.includes('/task/detail/')) return ok({ taskNo: 'T-20261026-016', name: '任务名' })
    throw new Error(`unexpected ${call.url}`)
  })
  const refs = findDevopsRefs(
    '先看 https://devops.ronhan.com/#demand/RO-20200101-001 ，再看 https://devops.ronhan.com/#task/T-20261026-016',
  )
  const result = await resolveFirstDevopsTitle(refs, CREDENTIALS, fetchImpl)
  assert.equal(result.kind, 'task')
  assert.equal(result.number, 'T-20261026-016')
  assert.equal(result.title, '任务名')
  assert.equal(result.url, 'https://devops.ronhan.com/#task/T-20261026-016')

  // Three references, none resolvable: still null, never a throw.
  const hopeless = mockFetch(() => refused('40400', '不存在', 404))
  assert.equal(await resolveFirstDevopsTitle(refs, CREDENTIALS, hopeless), null)
  assert.equal(await resolveFirstDevopsTitle([], CREDENTIALS, hopeless), null)
})

test('the prefix is the number and the title, on one line', async () => {
  assert.equal(
    formatDevopsPrefix({ number: 'RO-20261027-008', title: '收银台支付结果倒计时不跳转修复' }),
    'RO-20261027-008 收银台支付结果倒计时不跳转修复',
  )
  assert.equal(formatDevopsPrefix({ number: 'RO-1', title: 'a\nb' }), 'RO-1 a b')
  assert.equal(formatDevopsPrefix(null), '')
})

test('a title with newlines is collapsed before it becomes a prefix', async () => {
  const fetchImpl = mockFetch(() => ok({ order: { orderId: 'RO-1', title: ' 第一行\n第二行  ' } }))
  const result = await resolveDevopsTitle('RO-1', CREDENTIALS, fetchImpl)
  assert.equal(result.title, '第一行 第二行')
})
