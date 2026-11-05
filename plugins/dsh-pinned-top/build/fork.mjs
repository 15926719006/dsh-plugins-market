/**
 * Regenerate `lib/client.js` from the shipped `@deepseek-ai/dsh-client-ui-workspace`
 * bundle and re-apply this fork's patches: the pinned leading section and the
 * one-click archive button on every Workspace row.
 *
 * The desktop app ships its Client packages inside `app.asar`; this script reads
 * that archive directly (Electron's asar format is a JSON header followed by the
 * concatenated file bodies) so the fork can be rebuilt for a new app version:
 *
 *   node build/fork.mjs [--asar /path/to/app.asar] [--out lib/client.js]
 *
 * Every patch anchor must match exactly once, so a changed upstream bundle fails
 * loudly instead of silently shipping a half-patched sidebar.
 */
import { openSync, readSync, closeSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BUNDLE = resolve(HERE, '..')

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const index = args.indexOf(flag)
  return index === -1 ? fallback : args[index + 1]
}

const asarPath = argOf(
  '--asar',
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar',
)
const outClient = resolve(BUNDLE, argOf('--out', 'lib/client.js'))
const PACKAGE_NAME = '@local/dsh-pinned-top'
const SHIPPED = '@deepseek-ai/dsh-client-ui-workspace'

/** Read one file out of an asar archive without Electron. */
function readAsarFile(archive, innerPath) {
  const fd = openSync(archive, 'r')
  try {
    // Layout: [4] = 4, [4] = padded header size, [8] = unused, [12] = JSON size,
    // [16..16+JSON size] = tree JSON, then zero padding; file bodies start at 8 + header size.
    const header = Buffer.alloc(16)
    readSync(fd, header, 0, 16, 0)
    const headerSize = header.readUInt32LE(4)
    const jsonSize = header.readUInt32LE(12)
    const json = Buffer.alloc(jsonSize)
    readSync(fd, json, 0, jsonSize, 16)
    const tree = JSON.parse(json.toString('utf8').replace(/\u0000+$/, ''))
    let node = tree
    for (const segment of innerPath.split('/').filter(Boolean)) {
      node = node.files[segment]
      if (node === undefined) throw new Error(`asar: missing ${innerPath}`)
    }
    if (node.files !== undefined) throw new Error(`asar: ${innerPath} is a directory`)
    if (node.unpacked === true) {
      throw new Error(`asar: ${innerPath} is unpacked; read it from app.asar.unpacked`)
    }
    const body = Buffer.alloc(Number(node.size))
    readSync(fd, body, 0, body.length, 8 + headerSize + Number(node.offset))
    return body
  } finally {
    closeSync(fd)
  }
}

const shippedRoot = `/dsh/node_modules/${SHIPPED}`
let source = readAsarFile(asarPath, `${shippedRoot}/lib/client.js`).toString('utf8')

// 5b. A pinned row is revealed by id alone: it no longer lives in its owning
//     Workspace group, so the group-key guard would leave the reveal request
//     pending forever after navigating to a pinned Session from search.
source = replaceOnce(
  source,
  [
    '\t\t\t\t\t\t\t\tonReveal: node.id === revealSessionId && group.key === revealGroup ? () => {',
    '\t\t\t\t\t\t\t\t\tonSessionRevealed(node.id);',
    '\t\t\t\t\t\t\t\t} : void 0,',
  ].join('\n'),
  [
    '\t\t\t\t\t\t\t\tonReveal: node.id === revealSessionId ? () => {',
    '\t\t\t\t\t\t\t\t\tonSessionRevealed(node.id);',
    '\t\t\t\t\t\t\t\t} : void 0,',
  ].join('\n'),
  'renderGroup onReveal',
)

/** Apply one exact patch anchor. */
function replaceOnce(text, from, to, label) {
  const first = text.indexOf(from)
  if (first === -1) throw new Error(`patch anchor missing: ${label}`)
  if (text.indexOf(from, first + 1) !== -1) throw new Error(`patch anchor not unique: ${label}`)
  return text.slice(0, first) + to + text.slice(first + from.length)
}

// 1. The identity of this fork replaces the shipped package name (module id and
//    the four CSS ownership tags).
source = source.split(SHIPPED).join(PACKAGE_NAME)

// 2. Synthetic group key constant.
source = replaceOnce(
  source,
  '\t\tconst SESSION_WATERMARK_BASE = 5;',
  [
    '\t\tconst SESSION_WATERMARK_BASE = 5;',
    '\t\t/** Synthetic leading section that lifts pinned Sessions above every Workspace group. */',
    '\t\tconst PINNED_GROUP_KEY = "__pinned__";',
  ].join('\n'),
  'watermark constant',
)

// 3. Derive the pinned section and keep pinned rows out of their Workspace group.
source = replaceOnce(
  source,
  [
    '\t\t\tconst currentGroup = current === void 0 ? void 0 : owningGroupKey(workspaces, current);',
    '\t\t\tconst groups = [];',
    '\t\t\tfor (const g of groupByWorkspace(',
  ].join('\n'),
  [
    '\t\t\tconst currentGroup = current === void 0 ? void 0 : owningGroupKey(workspaces, current);',
    '\t\t\tconst groups = [];',
    '\t\t\tconst pinnedSection = [];',
    '\t\t\tfor (const id of rowState.pinnedSessionIds) {',
    '\t\t\t\tconst session = list.byId[id];',
    '\t\t\t\tif (session === void 0 || archived.has(id) || !sessionVisible(session, current, archived, rowState.archivedFilter)) continue;',
    '\t\t\t\tpinnedSection.push(session);',
    '\t\t\t}',
    '\t\t\tconst pinnedShown = new Set(pinnedSection.map((session) => session.id));',
    '\t\t\tif (pinnedSection.length > 0) groups.push({',
    '\t\t\t\tkey: PINNED_GROUP_KEY,',
    '\t\t\t\tworkspaceId: void 0,',
    '\t\t\t\tcwd: void 0,',
    '\t\t\t\tcreatedAt: void 0,',
    '\t\t\t\tlabel: view.pinnedLabel ?? "Pinned",',
    '\t\t\t\tsessionCount: pinnedSection.length,',
    '\t\t\t\texpanded: view.pinnedExpanded !== false,',
    '\t\t\t\tcontainsCurrent: false,',
    '\t\t\t\tsessions: view.pinnedExpanded !== false ? pinnedSection.map((session) => sessionNode(session, list, statuses, pinned, archived)) : []',
    '\t\t\t});',
    '\t\t\tfor (const g of groupByWorkspace(',
  ].join('\n'),
  'deriveGroups header',
)

source = replaceOnce(
  source,
  '\t\t\t\t\tsessions: expanded ? sectionMembers(g.sessions, pinned, archived).map((session) => sessionNode(session, list, statuses, pinned, archived)) : []',
  '\t\t\t\t\tsessions: expanded ? sectionMembers(g.sessions, pinned, archived).filter((session) => !pinnedShown.has(session.id)).map((session) => sessionNode(session, list, statuses, pinned, archived)) : []',
  'deriveGroups group sessions',
)

// 4. SessionTree: locale label + default expansion, and no watermark inside the
//    pinned section (every pinned row stays visible).
source = replaceOnce(
  source,
  [
    '\t\t\tconst groups = (0, react.useMemo)(() => deriveGroups(list, workspaces, rowState, statuses, {',
    '\t\t\t\texpandedGroups,',
    '\t\t\t\tungroupedOrder: ungroupedSessionIds',
    '\t\t\t}), [',
    '\t\t\t\tlist,',
    '\t\t\t\tworkspaces,',
    '\t\t\t\trowState,',
    '\t\t\t\tstatuses,',
    '\t\t\t\texpandedGroups,',
    '\t\t\t\tungroupedSessionIds',
    '\t\t\t]);',
  ].join('\n'),
  [
    '\t\t\tconst groups = (0, react.useMemo)(() => deriveGroups(list, workspaces, rowState, statuses, {',
    '\t\t\t\texpandedGroups,',
    '\t\t\t\tungroupedOrder: ungroupedSessionIds,',
    '\t\t\t\tpinnedLabel: t("group.pinned"),',
    '\t\t\t\tpinnedExpanded: groupExpansion[PINNED_GROUP_KEY] !== false',
    '\t\t\t}), [',
    '\t\t\t\tlist,',
    '\t\t\t\tworkspaces,',
    '\t\t\t\trowState,',
    '\t\t\t\tstatuses,',
    '\t\t\t\texpandedGroups,',
    '\t\t\t\tungroupedSessionIds,',
    '\t\t\t\tgroupExpansion,',
    '\t\t\t\tt',
    '\t\t\t]);',
  ].join('\n'),
  'SessionTree deriveGroups call',
)

source = replaceOnce(
  source,
  '\t\t\tconst baselines = new Map(groups.map((group) => [group.key, Math.max(SESSION_WATERMARK_BASE, requiredWatermark(group.sessions, current, group.key === revealGroup ? revealSessionId : void 0))]));',
  '\t\t\tconst baselines = new Map(groups.map((group) => [group.key, group.key === PINNED_GROUP_KEY ? Infinity : Math.max(SESSION_WATERMARK_BASE, requiredWatermark(group.sessions, current, group.key === revealGroup ? revealSessionId : void 0))]));',
  'SessionTree baselines',
)

// 5. Pinned rows are not reorderable: their position follows the Host pin order.
source = replaceOnce(
  source,
  '\t\t\t\t\t\t\tconst dragProps = {',
  '\t\t\t\t\t\t\tconst dragProps = group.key === PINNED_GROUP_KEY ? void 0 : {',
  'renderGroup dragProps',
)

// 6. The section header: its own title, a pin glyph, and no Workspace row
//    actions (rename / delete / new session do not belong to a pin list).
source = replaceOnce(
  source,
  '\t\t\tconst label = row.workspaceId === void 0 ? t("group.ungrouped") : row.label;',
  '\t\t\tconst label = row.key === PINNED_GROUP_KEY ? row.label : row.workspaceId === void 0 ? t("group.ungrouped") : row.label;',
  'ProjectRowItem label',
)

source = replaceOnce(
  source,
  '\t\t\t\t\t\tchildren: row.expanded ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenRegular, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderCloseRegular, {})',
  '\t\t\t\t\t\tchildren: row.key === PINNED_GROUP_KEY ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPinFillRegular, {}) : row.expanded ? (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenRegular, {}) : (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderCloseRegular, {})',
  'ProjectRowItem folder icon',
)

source = replaceOnce(
  source,
  [
    '\t\t\t\t\t\tclassName: Rows_module_css_default.rowActions,',
    '\t\t\t\t\t\tchildren: [actions !== void 0 &&',
  ].join('\n'),
  [
    '\t\t\t\t\t\tclassName: Rows_module_css_default.rowActions,',
    '\t\t\t\t\t\tchildren: row.key === PINNED_GROUP_KEY ? [] : [actions !== void 0 &&',
  ].join('\n'),
  'ProjectRowItem row actions',
)

// 7. Locale entry for the section title.
source = replaceOnce(
  source,
  '\t\t\t"group.ungrouped": "未分组",',
  '\t\t\t"group.ungrouped": "未分组",\n\t\t\t"group.pinned": "置顶",',
  'zh dictionary',
)
source = replaceOnce(
  source,
  '\t\t\t"group.ungrouped": "Ungrouped",',
  '\t\t\t"group.ungrouped": "Ungrouped",\n\t\t\t"group.pinned": "Pinned",',
  'en dictionary',
)

// 9. One-click archive: every Workspace row gains a hover button that archives
//    the Workspace's ordinary, unarchived, unpinned Sessions through the shared
//    archive action. Pinned Sessions stay pinned (the Host drops a pin when a
//    Session is archived). Running Sessions refuse the plain archive, so the
//    click counts and reports them instead of stopping a run.
source = replaceOnce(
  source,
  'function ProjectRowItem({ group, containsCurrentDescendant = false, onToggle, onCreate, actions, drag, home, newShortcut, t }) {',
  'function ProjectRowItem({ group, containsCurrentDescendant = false, onToggle, onCreate, actions, archiveableCount = 0, onArchiveAll, drag, home, newShortcut, t }) {',
  'ProjectRowItem signature',
)

source = replaceOnce(
  source,
  [
    '\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);',
    '\t\t\tconst workspaceMenuItems = [{',
  ].join('\n'),
  [
    '\t\t\tconst [menuOpen, setMenuOpen] = (0, react.useState)(false);',
    '\t\t\tconst [archiving, setArchiving] = (0, react.useState)(false);',
    '\t\t\tconst workspaceMenuItems = [{',
  ].join('\n'),
  'ProjectRowItem archive-all state',
)

// 10. The row's hover actions: archive-all sits between the "..." menu and the
//     new-Session button, so the primary create action keeps its position.
source = replaceOnce(
  source,
  [
    '\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {',
    '\t\t\t\t\t\t\tlabel: t("actions.newSession"),',
  ].join('\n'),
  [
    '\t\t\t\t\t\t}), archiveableCount > 0 && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {',
    '\t\t\t\t\t\t\tlabel: t("actions.archiveAll"),',
    '\t\t\t\t\t\t\tside: "bottom",',
    '\t\t\t\t\t\t\talign: "end",',
    '\t\t\t\t\t\t\tdelayMs: 500,',
    '\t\t\t\t\t\t\tportal: true,',
    '\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)("button", {',
    '\t\t\t\t\t\t\t\ttype: "button",',
    '\t\t\t\t\t\t\t\tclassName: Rows_module_css_default.iconButton,',
    '\t\t\t\t\t\t\t\t"aria-label": t("actions.archiveAll.aria", { name: label }),',
    '\t\t\t\t\t\t\t\tdisabled: archiving,',
    '\t\t\t\t\t\t\t\tonClick: (e) => {',
    '\t\t\t\t\t\t\t\t\te.stopPropagation();',
    '\t\t\t\t\t\t\t\t\tif (archiving || onArchiveAll === void 0) return;',
    '\t\t\t\t\t\t\t\t\tsetArchiving(true);',
    '\t\t\t\t\t\t\t\t\tPromise.resolve(onArchiveAll()).catch((reason) => {',
    '\t\t\t\t\t\t\t\t\t\tconsole.warn("workspace archive rejected:", reason);',
    '\t\t\t\t\t\t\t\t\t}).finally(() => {',
    '\t\t\t\t\t\t\t\t\t\tsetArchiving(false);',
    '\t\t\t\t\t\t\t\t\t});',
    '\t\t\t\t\t\t\t\t},',
    '\t\t\t\t\t\t\t\tchildren: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutlineRegular, {})',
    '\t\t\t\t\t\t\t})',
    '\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {',
    '\t\t\t\t\t\t\tlabel: t("actions.newSession"),',
  ].join('\n'),
  'ProjectRowItem archive-all button',
)

source = replaceOnce(
  source,
  [
    '\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(ProjectRowItem, {',
    '\t\t\t\t\t\t\tnewShortcut: shortcuts.find((row) => row.id === "session.new"),',
    '\t\t\t\t\t\t\tgroup,',
  ].join('\n'),
  [
    '\t\t\t\t\t\t(0, react_jsx_runtime.jsx)(ProjectRowItem, {',
    '\t\t\t\t\t\t\tnewShortcut: shortcuts.find((row) => row.id === "session.new"),',
    '\t\t\t\t\t\t\tgroup,',
    '\t\t\t\t\t\t\tarchiveableCount: group.workspaceId === void 0 ? 0 : archiveableCounts.get(group.workspaceId) ?? 0,',
    '\t\t\t\t\t\t\tonArchiveAll: group.workspaceId === void 0 ? void 0 : () => archiveWorkspaceSessions(group.workspaceId),',
  ].join('\n'),
  'renderGroup ProjectRowItem archive-all props',
)

// 11. The browser counts each Workspace's archiveable members, so the button only
//     renders where a click has something to archive. The count is derived from
//     the same membership rule the click uses, so the two can never drift apart.
source = replaceOnce(
  source,
  [
    '\t\t\tconst archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds);',
    '\t\t\tconst pinnedSessionIds = useWorkspaces((state) => state.pinnedSessionIds);',
  ].join('\n'),
  [
    '\t\t\tconst archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds);',
    '\t\t\tconst pinnedSessionIds = useWorkspaces((state) => state.pinnedSessionIds);',
    '\t\t\tconst archiveableCounts = (0, react.useMemo)(() => archiveableCountsByWorkspace(list, workspaces, archivedSessionIds, pinnedSessionIds), [',
    '\t\t\t\tworkspaces,',
    '\t\t\t\tlist,',
    '\t\t\t\tarchivedSessionIds,',
    '\t\t\t\tpinnedSessionIds',
    '\t\t\t]);',
  ].join('\n'),
  'browser archiveable counts',
)

source = replaceOnce(
  source,
  'notifyArchivedNotOpenable, renameWorkspace,',
  'notifyArchivedNotOpenable, archiveWorkspaceSessions, renameWorkspace,',
  'WorkspaceBrowser archive-all prop',
)

// 11b. The rows live one component lower, so SessionTree receives both the counts
//      and the operation the row button calls.
source = replaceOnce(
  source,
  'function SessionTree({ list, useSessionStatus, startSession, open, workspaces, ungroupedSessionIds, rowState, onLeaveArchivedOnly, workspaceReady, animationResetKey, usePanelInfo, onRenameRequest, onDeleteRequest, onSessionRenameRequest, renderSlot, insertWorkspaceBefore, nestWorkspaces, groupExpansion, setGroupExpanded, setSessionOrder, home, t, revealSessionId, onSessionRevealed, shortcuts }) {',
  'function SessionTree({ list, useSessionStatus, startSession, open, workspaces, ungroupedSessionIds, rowState, archiveableCounts, archiveWorkspaceSessions, onLeaveArchivedOnly, workspaceReady, animationResetKey, usePanelInfo, onRenameRequest, onDeleteRequest, onSessionRenameRequest, renderSlot, insertWorkspaceBefore, nestWorkspaces, groupExpansion, setGroupExpanded, setSessionOrder, home, t, revealSessionId, onSessionRevealed, shortcuts }) {',
  'SessionTree signature',
)

source = replaceOnce(
  source,
  [
    '\t\t\t\t\t\t\tsetGroupExpanded: actions.setGroupExpanded,',
    '\t\t\t\t\t\t\tsetSessionOrder: saveSessionOrder,',
    '\t\t\t\t\t\t\trowState,',
    '\t\t\t\t\t\t\tonLeaveArchivedOnly: leaveArchivedOnly,',
  ].join('\n'),
  [
    '\t\t\t\t\t\t\tsetGroupExpanded: actions.setGroupExpanded,',
    '\t\t\t\t\t\t\tsetSessionOrder: saveSessionOrder,',
    '\t\t\t\t\t\t\trowState,',
    '\t\t\t\t\t\t\tarchiveableCounts,',
    '\t\t\t\t\t\t\tarchiveWorkspaceSessions,',
    '\t\t\t\t\t\t\tonLeaveArchivedOnly: leaveArchivedOnly,',
  ].join('\n'),
  'SessionTree archive-all props',
)

// 12. The bulk operation: one Host archive call per target. A Session with running
//     work is counted as skipped rather than stopped, and a Session pinned after
//     the click was computed is left alone.
source = replaceOnce(
  source,
  [
    '\t\t\tconst notify = (toast) => {',
    '\t\t\t\trowToast.set({',
    '\t\t\t\t\t...toast,',
    '\t\t\t\t\tseq: ++toastSeq',
    '\t\t\t\t});',
    '\t\t\t};',
  ].join('\n'),
  [
    '\t\t\tconst notify = (toast) => {',
    '\t\t\t\trowToast.set({',
    '\t\t\t\t\t...toast,',
    '\t\t\t\t\tseq: ++toastSeq',
    '\t\t\t\t});',
    '\t\t\t};',
    '\t\t\t/**',
    '\t\t\t* Archive every ordinary, unarchived, unpinned Session of one Workspace.',
    '\t\t\t* A pin is the Host\'s only \"keep this row\" promise, and archiving durably',
    '\t\t\t* drops it, so a pinned member is never a bulk target: a click on a',
    '\t\t\t* Workspace row must not silently unpin a row the user lifted out of it.',
    '\t\t\t* A Session with running work refuses the plain archive, so it is counted',
    '\t\t\t* and reported instead of stopped: the click never interrupts a run.',
    '\t\t\t* @param workspaceId - Workspace whose members are archived.',
    '\t\t\t*/',
    '\t\t\tconst archiveWorkspaceSessions = async (workspaceId) => {',
    '\t\t\t\tconst workspaceSnapshot = workspaces.list.getSnapshot();',
    '\t\t\t\tconst workspace = workspaceSnapshot.items.find((item) => item.workspaceId === workspaceId);',
    '\t\t\t\tif (workspace === void 0) return;',
    '\t\t\t\tconst targets = archiveAllTargets(sessions.list.getSnapshot(), workspace, workspaceSnapshot.archivedSessionIds, workspaceSnapshot.pinnedSessionIds);',
    '\t\t\t\tlet archivedCount = 0;',
    '\t\t\t\tlet skipped = 0;',
    '\t\t\t\tfor (const sessionId of targets) {',
    '\t\t\t\t\t// A pin taken while the click runs outranks the click.',
    '\t\t\t\t\tif (workspaces.list.getSnapshot().pinnedSessionIds.includes(sessionId)) continue;',
    '\t\t\t\t\ttry {',
    '\t\t\t\t\t\tawait uiWorkspace.archiveSession(sessionId);',
    '\t\t\t\t\t\tarchivedCount += 1;',
    '\t\t\t\t\t} catch (reason) {',
    '\t\t\t\t\t\tif (activeSessionRefusal(reason) !== void 0) skipped += 1;',
    '\t\t\t\t\t\telse console.warn("workspace archive rejected:", reason);',
    '\t\t\t\t\t}',
    '\t\t\t\t}',
    '\t\t\t\tif (archivedCount > 0 && skipped > 0) notify({',
    '\t\t\t\t\tkind: "archivedAllSkipped",',
    '\t\t\t\t\tcount: archivedCount,',
    '\t\t\t\t\tskipped',
    '\t\t\t\t});',
    '\t\t\t\telse if (archivedCount > 0) notify({',
    '\t\t\t\t\tkind: "archivedAll",',
    '\t\t\t\t\tcount: archivedCount',
    '\t\t\t\t});',
    '\t\t\t\telse if (skipped > 0) notify({',
    '\t\t\t\t\tkind: "archivedAllRunning",',
    '\t\t\t\t\tskipped',
    '\t\t\t\t});',
    '\t\t\t};',
  ].join('\n'),
  'apply archiveWorkspaceSessions',
)

source = replaceOnce(
  source,
  [
    '\t\t\t\tunarchiveSession: async (sessionId) => {',
    '\t\t\t\t\tawait uiWorkspace.unarchiveSession(sessionId);',
    '\t\t\t\t},',
  ].join('\n'),
  [
    '\t\t\t\tunarchiveSession: async (sessionId) => {',
    '\t\t\t\t\tawait uiWorkspace.unarchiveSession(sessionId);',
    '\t\t\t\t},',
    '\t\t\t\tarchiveWorkspaceSessions,',
  ].join('\n'),
  'browserInjected archiveWorkspaceSessions',
)

// 13. The membership rule the bulk click uses, kept pure so the tests can pin it.
source = replaceOnce(
  source,
  '\t\tfunction activeSessionRefusal(reason) {',
  [
    '\t\t/**',
    '\t\t* The Workspace members one-click archive may archive: every ordinary,',
    '\t\t* unarchived, unpinned Session with a loaded summary, in the Workspace',
    '\t\t* order. Blank drafts and subagent children stay, so a bulk click never',
    '\t\t* discards a draft or a delegated child. Pinned Sessions stay because',
    '\t\t* archiving drops their pin on the Host; the bulk click must not unpin a',
    '\t\t* row that was deliberately lifted out of its group. Running Sessions are',
    '\t\t* filtered after the Host refuses their plain archive.',
    '\t\t* @param list - sessions list snapshot.',
    '\t\t* @param workspace - Workspace view whose membership is archived.',
    '\t\t* @param archivedSessionIds - registry-global archive set.',
    '\t\t* @param pinnedSessionIds - registry-global pin set.',
    '\t\t* @returns Session ids eligible for the bulk archive.',
    '\t\t*/',
    '\t\tfunction archiveAllTargets(list, workspace, archivedSessionIds, pinnedSessionIds) {',
    '\t\t\tconst archived = new Set(archivedSessionIds);',
    '\t\t\tconst pinned = new Set(pinnedSessionIds);',
    '\t\t\treturn workspace.sessionIds.filter((sessionId) => {',
    '\t\t\t\tconst summary = list.byId[sessionId];',
    '\t\t\t\treturn summary !== void 0 && !archived.has(sessionId) && !pinned.has(sessionId) && summary.blank !== true && summary.origin !== "subagent";',
    '\t\t\t});',
    '\t\t}',
    '\t\t/**',
    '\t\t* Count the bulk-archive targets of every Workspace, keyed by Workspace id.',
    '\t\t* The row\'s hover button renders only on a positive count, so counting',
    '\t\t* through archiveAllTargets keeps the button and the click on one rule.',
    '\t\t* @param list - sessions list snapshot.',
    '\t\t* @param workspaces - Workspace views in Host order.',
    '\t\t* @param archivedSessionIds - registry-global archive set.',
    '\t\t* @param pinnedSessionIds - registry-global pin set.',
    '\t\t* @returns target count per Workspace id.',
    '\t\t*/',
    '\t\tfunction archiveableCountsByWorkspace(list, workspaces, archivedSessionIds, pinnedSessionIds) {',
    '\t\t\tconst counts = /* @__PURE__ */ new Map();',
    '\t\t\tfor (const workspace of workspaces) counts.set(workspace.workspaceId, archiveAllTargets(list, workspace, archivedSessionIds, pinnedSessionIds).length);',
    '\t\t\treturn counts;',
    '\t\t}',
    '',
    '\t\tfunction activeSessionRefusal(reason) {',
  ].join('\n'),
  'archiveAllTargets helper',
)

// 14. Notices for the bulk result: the count, the skipped running Sessions, or a
//     Workspace whose every Session is running.
source = replaceOnce(
  source,
  [
    '\t\t\t\tyield ctx.slots.register({',
    '\t\t\t\t\tname: "workspace.toast",',
    '\t\t\t\t\tkey: "archived",',
  ].join('\n'),
  [
    '\t\t\t\tyield ctx.slots.register({',
    '\t\t\t\t\tname: "workspace.toast",',
    '\t\t\t\t\tkey: "archivedAll",',
    '\t\t\t\t\tlocale: "workspace",',
    '\t\t\t\t\tinject: () => ({ display: (notice, t) => ({',
    '\t\t\t\t\t\ttext: t("toast.archivedAll", { count: notice.count }),',
    '\t\t\t\t\t\ttone: "success",',
    '\t\t\t\t\t\tholdMs: 6e3',
    '\t\t\t\t\t}) })',
    '\t\t\t\t}, ToastEntry);',
    '\t\t\t\tyield ctx.slots.register({',
    '\t\t\t\t\tname: "workspace.toast",',
    '\t\t\t\t\tkey: "archivedAllSkipped",',
    '\t\t\t\t\tlocale: "workspace",',
    '\t\t\t\t\tinject: () => ({ display: (notice, t) => ({',
    '\t\t\t\t\t\ttext: t("toast.archivedAllSkipped", {',
    '\t\t\t\t\t\t\tcount: notice.count,',
    '\t\t\t\t\t\t\tskipped: notice.skipped',
    '\t\t\t\t\t\t}),',
    '\t\t\t\t\t\ttone: "success",',
    '\t\t\t\t\t\tholdMs: 6e3',
    '\t\t\t\t\t}) })',
    '\t\t\t\t}, ToastEntry);',
    '\t\t\t\tyield ctx.slots.register({',
    '\t\t\t\t\tname: "workspace.toast",',
    '\t\t\t\t\tkey: "archivedAllRunning",',
    '\t\t\t\t\tlocale: "workspace",',
    '\t\t\t\t\tinject: () => ({ display: (notice, t) => ({',
    '\t\t\t\t\t\ttext: t("toast.archivedAllRunning", { skipped: notice.skipped }),',
    '\t\t\t\t\t\ttone: "warning",',
    '\t\t\t\t\t\tholdMs: 6e3',
    '\t\t\t\t\t}) })',
    '\t\t\t\t}, ToastEntry);',
    '\t\t\t\tyield ctx.slots.register({',
    '\t\t\t\t\tname: "workspace.toast",',
    '\t\t\t\t\tkey: "archived",',
  ].join('\n'),
  'archive-all toasts',
)

// 15. Locale copy for the button and its notices. The label names the pinned
//     exemption, so a hover explains why a pinned row survives the click.
source = replaceOnce(
  source,
  '\t\t\t"menu.archiveSession": "归档会话",',
  [
    '\t\t\t"menu.archiveSession": "归档会话",',
    '\t\t\t"actions.archiveAll": "归档全部会话（保留置顶）",',
    '\t\t\t"actions.archiveAll.aria": "归档「{name}」下的全部会话（保留置顶）",',
    '\t\t\t"toast.archivedAll": "已归档 {count} 个会话",',
    '\t\t\t"toast.archivedAllSkipped": "已归档 {count} 个会话，{skipped} 个正在运行，已跳过",',
    '\t\t\t"toast.archivedAllRunning": "工作区内 {skipped} 个会话正在运行，未归档",',
  ].join('\n'),
  'zh archive-all dictionary',
)
source = replaceOnce(
  source,
  '\t\t\t"menu.archiveSession": "Archive session",',
  [
    '\t\t\t"menu.archiveSession": "Archive session",',
    '\t\t\t"actions.archiveAll": "Archive all sessions (pinned kept)",',
    '\t\t\t"actions.archiveAll.aria": "Archive all sessions in {name} (pinned kept)",',
    '\t\t\t"toast.archivedAll": "Archived {count} sessions",',
    '\t\t\t"toast.archivedAllSkipped": "Archived {count} sessions; skipped {skipped} that are running",',
    '\t\t\t"toast.archivedAllRunning": "{skipped} sessions are running; nothing archived",',
  ].join('\n'),
  'en archive-all dictionary',
)

// 16. The shipped trailing source-map comment points at a map this fork does not ship.
source = source.replace(/\n\/\/# sourceMappingURL=[^\n]*\n?$/, '\n')

mkdirSync(dirname(outClient), { recursive: true })
// Write-then-rename: the client HMR watcher polls this artifact, and a torn write
// would be published as a revision whose bundle cannot register.
const staged = `${outClient}.${process.pid}.tmp`
writeFileSync(staged, source)
renameSync(staged, outClient)
console.log(`patched ${outClient} (${source.length} bytes)`)
console.log('')
console.log('NOTE: while a page is open, the client HMR watcher publishes this revision')
console.log('and swaps the sidebar plugin in place. This plugin PROVIDES the uiWorkspace')
console.log('service, so the swap tears down and re-creates every view that injects it')
console.log('(the conversation input/composer included). Current DSH releases re-cascade')
console.log('those consumers, and a failed swap has no rollback.')
console.log('')
console.log('Publish with the page CLOSED when you can: no swap is published, so nothing')
console.log('is torn down. Publishing while the row is enabled is the supported HMR path.')
console.log('Do NOT disable the row, rebuild, then enable it: replacing package code')
console.log('during an enable is outside ordinary enable/disable synchronization and can')
console.log('leave the composer missing until the page is rebooted.')
console.log('Recovery ladder: reload the page -> Settings > Plugins > Plugin list retry')
console.log('-> restart only as a last resort. See README "Updating while the app is running".')
