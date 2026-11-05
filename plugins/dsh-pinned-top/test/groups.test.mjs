/**
 * Behaviour checks for the patched group derivation this bundle forked out of the
 * shipped Sidebar browser: the synthetic 置顶 section, the Workspace groups it
 * leaves behind, and the membership rule behind one-click archive.
 *
 * The bundle is a compiled artifact, so the module is executed in a sandbox with
 * stubbed framework modules and one extra export that exposes `deriveGroups`,
 * `archiveAllTargets` and `archiveableCountsByWorkspace`.
 *
 * Run with `node test/groups.test.mjs`.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const exprValue = (value) => JSON.parse(JSON.stringify(value))
const eq = (actual, expected) => assert.deepStrictEqual(exprValue(actual), expected)

// The artifact path is overridable so a fork can be rebuilt to a scratch file and
// verified before the live profile's `lib/client.js` is rewritten.
const clientPath = process.env.PINNED_TOP_CLIENT ?? new URL('../lib/client.js', import.meta.url)
const source = readFileSync(clientPath, 'utf8')
const instrumented = source.replace(
  '\t\treturn module.exports;',
  [
    '\t\tmodule.exports.__test = {',
    '\t\t\tderiveGroups,',
    '\t\t\tPINNED_GROUP_KEY,',
    '\t\t\tarchiveAllTargets,',
    '\t\t\t...(typeof archiveableCountsByWorkspace === "function" ? { archiveableCountsByWorkspace } : {}),',
    '\t\t\tProjectRowItem',
    '\t\t};',
    '\t\treturn module.exports;',
  ].join('\n'),
)
if (instrumented === source) throw new Error('instrumentation anchor missing: cannot expose deriveGroups')

let registration = null
const fakeElement = () => ({ dataset: {}, setAttribute() {}, textContent: '' })
const documentStub = {
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => fakeElement(),
  head: { appendChild() {} },
  body: { dataset: {}, setAttribute() {} },
  documentElement: { dataset: {} },
}
const proxy = (name) => new Proxy(function () {}, {
  get: (_t, property) => (property === Symbol.toPrimitive ? () => name : proxy(`${name}.${String(property)}`)),
  apply: () => proxy(`${name}()`),
  construct: () => proxy(`new ${name}`),
})
const react = {
  createElement: () => null,
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useMemo: (callback) => callback(),
  useRef: () => ({ current: null }),
  useEffect: () => {},
  useCallback: (callback) => callback,
  createContext: () => ({}),
  useContext: () => ({}),
  memo: (callback) => callback,
  forwardRef: (callback) => callback,
  startTransition: (callback) => callback(),
  Component: class { constructor(props) { this.props = props } setState() {} },
  PureComponent: class { constructor(props) { this.props = props } setState() {} },
}
const modules = {
  react,
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: Symbol('Fragment') },
  '@deepseek-ai/dsh-client-ui-primitives': proxy('primitives'),
  '@deepseek-ai/dsh-client-store': proxy('store'),
  '@deepseek-ai/cordis': proxy('cordis'),
}
const sandbox = {
  window: { __ModuleLoader__: { load: (value) => { registration = value } } },
  document: documentStub,
  console,
  setTimeout,
  clearTimeout,
}
vm.createContext(sandbox)
vm.runInContext(instrumented, sandbox, { filename: 'client.js' })
const moduleExports = registration.factory((specifier) => {
  if (!(specifier in modules)) throw new Error(`unexpected require: ${specifier}`)
  return modules[specifier]
})
const { deriveGroups, PINNED_GROUP_KEY, archiveAllTargets, archiveableCountsByWorkspace, ProjectRowItem } = moduleExports.__test

const session = (id, extra = {}) => ({
  id,
  title: id.toUpperCase(),
  blank: false,
  running: false,
  updatedAt: 1000,
  retainedBy: {},
  origin: 'user',
  ...extra,
})
const workspace = (workspaceId, sessionIds, path = `/tmp/${workspaceId}`) => ({
  workspaceId,
  path,
  createdAt: '2026-01-01T00:00:00Z',
  title: workspaceId,
  sessionIds,
})
const baseView = {
  expandedGroups: ['w1', 'w2', ''],
  ungroupedOrder: [],
  pinnedLabel: '置顶',
  pinnedExpanded: true,
}

/**
 * Derive the render groups for one fixture.
 * @param options - pins, archived ids, filter, sessions and view overrides.
 * @returns the derived group list.
 */
function build(options = {}) {
  const pinned = options.pinned ?? []
  const archived = options.archived ?? []
  const filter = options.filter ?? 'default'
  const ws = options.ws ?? [workspace('w1', ['a', 'b']), workspace('w2', ['c', 'd'])]
  const extraSessions = options.sessions ?? []
  const all = [...ws.flatMap((entry) => entry.sessionIds), ...extraSessions]
  const byId = Object.fromEntries(all.map((id) => [id, session(id, options.sessionExtra?.[id] ?? {})]))
  const list = { ids: all, byId, projectionsBySession: {}, phase: 'ready' }
  const statuses = new Map(all.map((id) => [id, { running: false }]))
  return deriveGroups(list, ws, { pinnedSessionIds: pinned, archivedSessionIds: archived, archivedFilter: filter }, statuses, { ...baseView, ...(options.view ?? {}) })
}

// 1. Nothing pinned: the shipped grouping shape, no synthetic section.
{
  const groups = build()
  eq(groups.map((group) => group.key), ['w1', 'w2'])
  eq(groups.map((group) => group.sessions.map((entry) => entry.id)), [['a', 'b'], ['c', 'd']])
}

// 2. A pinned row leads the list and leaves its Workspace group.
{
  const groups = build({ pinned: ['c'] })
  assert.equal(groups[0].key, PINNED_GROUP_KEY)
  assert.equal(groups[0].label, '置顶')
  assert.equal(groups[0].expanded, true)
  eq(groups[0].sessions.map((entry) => entry.id), ['c'])
  eq(groups[1].sessions.map((entry) => entry.id), ['a', 'b'])
  eq(groups[2].sessions.map((entry) => entry.id), ['d'])
}

// 3. Pin order follows the Host's most-recently-pinned-first array, not group order.
{
  const groups = build({ pinned: ['d', 'b'] })
  eq(groups[0].sessions.map((entry) => entry.id), ['d', 'b'])
  eq(groups[1].sessions.map((entry) => entry.id), ['a'])
  eq(groups[2].sessions.map((entry) => entry.id), ['c'])
}

// 4. A pinned row from a collapsed Workspace still shows at the top.
{
  const groups = build({ pinned: ['a'], view: { expandedGroups: ['w2'] } })
  eq(groups[0].sessions.map((entry) => entry.id), ['a'])
  assert.equal(groups[1].sessions.length, 0)
  eq(groups[2].sessions.map((entry) => entry.id), ['c', 'd'])
}

// 5. Archived-only hides the synthetic section: pins are never archived.
{
  const groups = build({ pinned: ['a'], filter: 'only' })
  assert.ok(groups.every((group) => group.key !== PINNED_GROUP_KEY))
}

// 6. A collapsed pinned section keeps its rows out of the list.
{
  const groups = build({ pinned: ['a'], view: { pinnedExpanded: false } })
  assert.equal(groups[0].key, PINNED_GROUP_KEY)
  assert.equal(groups[0].expanded, false)
  eq(groups[0].sessions, [])
  eq(groups[1].sessions.map((entry) => entry.id), ['b'])
}

// 7. An unknown pinned id is ignored instead of leaving a hole.
{
  const groups = build({ pinned: ['ghost', 'b'] })
  eq(groups[0].sessions.map((entry) => entry.id), ['b'])
}

// 8. Running state never creates a section of its own: the row stays in its group.
{
  const ws = [workspace('w1', ['a', 'b'])]
  const list = { ids: ['a', 'b'], byId: { a: session('a'), b: session('b') }, projectionsBySession: {}, phase: 'ready' }
  const statuses = new Map([['a', { running: true, state: 'running' }], ['b', { running: false }]])
  const groups = deriveGroups(list, ws, { pinnedSessionIds: [], archivedSessionIds: [], archivedFilter: 'default' }, statuses, baseView)
  eq(groups.map((group) => group.key), ['w1'])
  eq(groups[0].sessions.map((entry) => entry.id), ['a', 'b'])
  assert.equal(groups[0].sessions[0].running, true)
}

// 9. One-click archive covers every ordinary, unarchived, UNPINNED member in
//    Workspace order; archived rows, blank drafts, subagent children, members
//    without a loaded summary and pinned rows stay. Archiving drops a Session's
//    pin on the Host, so a bulk click must never take a pin with it.
{
  const ws = workspace('w1', ['a', 'old', 'draft', 'child', 'ghost', 'b'])
  const list = {
    ids: ['a', 'old', 'draft', 'child'],
    byId: {
      a: session('a'),
      old: session('old'),
      draft: session('draft', { blank: true }),
      child: session('child', { origin: 'subagent' }),
      b: session('b'),
    },
    projectionsBySession: {},
    phase: 'ready',
  }
  eq(archiveAllTargets(list, ws, ['old'], []), ['a', 'b'])
  eq(archiveAllTargets(list, ws, ['old'], ['a']), ['b'], 'a pinned member is not a bulk target')
  eq(archiveAllTargets(list, ws, ['old'], ['a', 'b']), [], 'pinned members alone leave nothing to archive')
}

// 9b. The row's hover button counts exactly what a click would archive, so a
//     Workspace whose only members are pinned shows no button at all.
{
  const ws = [workspace('w1', ['a', 'b']), workspace('w2', ['c'])]
  const list = {
    ids: ['a', 'b', 'c'],
    byId: { a: session('a'), b: session('b'), c: session('c') },
    projectionsBySession: {},
    phase: 'ready',
  }
  eq([...archiveableCountsByWorkspace(list, ws, [], []).entries()], [['w1', 2], ['w2', 1]])
  eq(archiveableCountsByWorkspace(list, ws, ['a'], ['b']).get('w1'), 0)
  eq(archiveableCountsByWorkspace(list, ws, [], ['c']).get('w2'), 0)
}

// 10. An empty Workspace yields no targets, so the row never shows the button.
{
  const ws = workspace('w1', ['a', 'b'])
  const list = { ids: ['a', 'b'], byId: { a: session('a'), b: session('b') }, projectionsBySession: {}, phase: 'ready' }
  eq(archiveAllTargets(list, ws, [], []), ['a', 'b'])
  eq(archiveAllTargets(list, ws, ['a', 'b'], []), [])
}

// 11. The Workspace row renders the archive-all button between its "..." menu and
//     its new-Session button, and only while it has archiveable members.
const collectButtons = (node, found = []) => {
  if (node === null || typeof node !== 'object') return found
  const props = node.props
  if (props !== undefined && typeof props['aria-label'] === 'string') found.push(node)
  const children = props?.children
  if (Array.isArray(children)) for (const child of children) collectButtons(child, found)
  else if (children !== undefined && children !== null) collectButtons(children, found)
  return found
}
const renderRow = (overrides = {}) => {
  const calls = []
  const tree = ProjectRowItem({
    group: {
      key: 'w1',
      workspaceId: 'w1',
      label: '默认工作区',
      cwd: undefined,
      createdAt: undefined,
      expanded: true,
      containsCurrent: false,
      sessionCount: 3,
    },
    onToggle: () => {},
    onCreate: () => calls.push('create'),
    actions: { rename: () => {}, delete: () => {} },
    archiveableCount: 3,
    onArchiveAll: () => {
      calls.push('archiveAll')
      return Promise.resolve()
    },
    drag: undefined,
    home: '/Users/example',
    newShortcut: undefined,
    t: (key) => key,
    ...overrides,
  })
  return { tree, calls }
}
const labelsOf = (tree) => collectButtons(tree).map((node) => node.props['aria-label'])

{
  const { tree } = renderRow()
  const labels = labelsOf(tree)
  assert.ok(labels.includes('actions.archiveAll.aria'), 'archive-all button renders on a Workspace row')
  assert.ok(labels.includes('actions.newSession.aria'), 'new-Session button keeps rendering')
  assert.ok(
    labels.indexOf('actions.archiveAll.aria') < labels.indexOf('actions.newSession.aria'),
    'archive-all sits before new-Session',
  )
}

{
  const labels = labelsOf(renderRow({ archiveableCount: 0 }).tree)
  assert.ok(!labels.includes('actions.archiveAll.aria'), 'no archive-all button without archiveable members')
}

// 12. Clicking the button runs the bulk operation without toggling the row.
{
  let stopped = false
  const { tree, calls } = renderRow()
  const button = collectButtons(tree).find((node) => node.props['aria-label'] === 'actions.archiveAll.aria')
  assert.equal(button.props.disabled, false)
  button.props.onClick({ stopPropagation: () => { stopped = true } })
  assert.equal(stopped, true, 'the click does not reach the row toggle')
  eq(calls, ['archiveAll'])
}

// 13. The synthetic Pinned section carries no archive-all button.
{
  const { tree } = renderRow({
    group: { key: '__pinned__', workspaceId: undefined, label: '置顶', cwd: undefined, createdAt: undefined, expanded: true, containsCurrent: false, sessionCount: 1 },
    actions: undefined,
  })
  assert.ok(!labelsOf(tree).includes('actions.archiveAll.aria'), 'the pinned section has no archive-all button')
}

console.log('groups.test: all checks passed')
