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
 *
 * Since DSH 0.2.2-rc.3 the shipped Client bundle is minified (no whitespace, no
 * parentheses around single arrow parameters), so the anchors below are written
 * in that minified shape. Rebuilding against a non-minified bundle therefore
 * fails at the first anchor — that is the intended loud failure, not a silent
 * half-patch.
 *
 * The fork replaces the whole package, so every shipped slot declaration comes
 * along with it — including `workspace.picker.directoryFlow`, the third
 * directory-flow hole that the native/browse directory picker registers into.
 * A fork that misses a hole blocks the picker's transactional registration
 * entirely, which is what hid the sidebar's "add workspace" button in 0.2.1.
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

/** Apply one exact patch anchor. */
function replaceOnce(text, from, to, label) {
  const first = text.indexOf(from)
  if (first === -1) throw new Error(`patch anchor missing: ${label}`)
  if (text.indexOf(from, first + 1) !== -1) throw new Error(`patch anchor not unique: ${label}`)
  return text.slice(0, first) + to + text.slice(first + from.length)
}

const shippedRoot = `/dsh/node_modules/${SHIPPED}`
let source = readAsarFile(asarPath, `${shippedRoot}/lib/client.js`).toString('utf8')

// 0. Signature check: this script only knows the minified 0.2.2-rc.3+ bundle
//    shape. A reopened/reformatted upstream fails here with one clear message.
if (!source.includes('function deriveGroups(list,workspaces,rowState,statuses,view){')) {
  throw new Error(
    'upstream bundle shape changed: expected the minified @deepseek-ai/dsh-client-ui-workspace ' +
      'bundle of DSH 0.2.2-rc.3+; re-derive the anchors in build/fork.mjs before rebuilding',
  )
}

// 1. A pinned row is revealed by id alone: it no longer lives in its owning
//    Workspace group, so the group-key guard would leave the reveal request
//    pending forever after navigating to a pinned Session from search.
source = replaceOnce(
  source,
  'onReveal:node.id===revealSessionId&&group.key===revealGroup?()=>{onSessionRevealed(node.id)}:void 0,',
  'onReveal:node.id===revealSessionId?()=>{onSessionRevealed(node.id)}:void 0,',
  'renderGroup onReveal',
)

// 2. The identity of this fork replaces the shipped package name (module id and
//    the four CSS ownership tags).
source = source.split(SHIPPED).join(PACKAGE_NAME)

// 3. Synthetic group key constant.
source = replaceOnce(
  source,
  'const SESSION_WATERMARK_BASE=5;',
  'const SESSION_WATERMARK_BASE=5;const PINNED_GROUP_KEY=`__pinned__`;',
  'watermark constant',
)

// 4. Derive the pinned section and keep pinned rows out of their Workspace group.
source = replaceOnce(
  source,
  'const groups=[];for(const g of groupByWorkspace(',
  [
    'const groups=[];',
    'const pinnedSection=[];',
    'for(const id of rowState.pinnedSessionIds){',
    'const session=list.byId[id];',
    'if(session===void 0||archived.has(id)||!sessionVisible(session,current,archived,rowState.archivedFilter))continue;',
    'pinnedSection.push(session);',
    '}',
    'const pinnedShown=new Set(pinnedSection.map(session=>session.id));',
    'if(pinnedSection.length>0)groups.push({',
    'key:PINNED_GROUP_KEY,',
    'workspaceId:void 0,',
    'cwd:void 0,',
    'createdAt:void 0,',
    'label:view.pinnedLabel??`Pinned`,',
    'sessionCount:pinnedSection.length,',
    'expanded:view.pinnedExpanded!==false,',
    'containsCurrent:false,',
    'sessions:view.pinnedExpanded!==false?pinnedSection.map(session=>sessionNode(session,list,statuses,pinned,archived)):[],',
    '});',
    'for(const g of groupByWorkspace(',
  ].join(''),
  'deriveGroups header',
)

source = replaceOnce(
  source,
  'sessions:expanded?sectionMembers(g.sessions,pinned,archived).map(session=>sessionNode(session,list,statuses,pinned,archived)):[]',
  'sessions:expanded?sectionMembers(g.sessions,pinned,archived).filter(session=>!pinnedShown.has(session.id)).map(session=>sessionNode(session,list,statuses,pinned,archived)):[]',
  'deriveGroups group sessions',
)

// 5. SessionTree: locale label + default expansion, and no watermark inside the
//    pinned section (every pinned row stays visible).
source = replaceOnce(
  source,
  'deriveGroups(list,workspaces,rowState,statuses,{expandedGroups,ungroupedOrder:ungroupedSessionIds})',
  'deriveGroups(list,workspaces,rowState,statuses,{expandedGroups,ungroupedOrder:ungroupedSessionIds,pinnedLabel:t(`group.pinned`),pinnedExpanded:groupExpansion[PINNED_GROUP_KEY]!==false})',
  'SessionTree deriveGroups call',
)

source = replaceOnce(
  source,
  '[list,workspaces,rowState,statuses,expandedGroups,ungroupedSessionIds]',
  '[list,workspaces,rowState,statuses,expandedGroups,ungroupedSessionIds,groupExpansion,t]',
  'SessionTree deriveGroups deps',
)

source = replaceOnce(
  source,
  'Math.max(SESSION_WATERMARK_BASE,requiredWatermark(group.sessions,current,group.key===revealGroup?revealSessionId:void 0))',
  'group.key===PINNED_GROUP_KEY?Infinity:Math.max(SESSION_WATERMARK_BASE,requiredWatermark(group.sessions,current,group.key===revealGroup?revealSessionId:void 0))',
  'SessionTree baselines',
)

// 6. Pinned rows are not reorderable: their position follows the Host pin order.
source = replaceOnce(
  source,
  'const dragProps={start:()=>{sessionDropCommitted.current=false;',
  'const dragProps=group.key===PINNED_GROUP_KEY?void 0:{start:()=>{sessionDropCommitted.current=false;',
  'renderGroup dragProps',
)

// 7. The section header: its own title, a pin glyph, and no Workspace row
//    actions (rename / delete / new session do not belong to a pin list).
source = replaceOnce(
  source,
  'const label=row.workspaceId===void 0?t(`group.ungrouped`):row.label;',
  'const label=row.key===PINNED_GROUP_KEY?row.label:row.workspaceId===void 0?t(`group.ungrouped`):row.label;',
  'ProjectRow label',
)

source = replaceOnce(
  source,
  'children:row.expanded?(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenRegular,{}):(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderCloseRegular,{})',
  'children:row.key===PINNED_GROUP_KEY?(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPinFillRegular,{}):row.expanded?(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderOpenRegular,{}):(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconFolderCloseRegular,{})',
  'ProjectRow folder icon',
)

source = replaceOnce(
  source,
  'className:Rows_module_css_default.rowActions,children:[workspaceMenuTarget!==void 0&&renderFactorySlot(',
  'className:Rows_module_css_default.rowActions,children:row.key===PINNED_GROUP_KEY?[]:[workspaceMenuTarget!==void 0&&renderFactorySlot(',
  'ProjectRow row actions',
)

// 8. Locale entry for the section title.
source = replaceOnce(source, '"group.ungrouped":`未分组`,', '"group.ungrouped":`未分组`,"group.pinned":`置顶`,', 'zh dictionary')
source = replaceOnce(source, '"group.ungrouped":`Ungrouped`,', '"group.ungrouped":`Ungrouped`,"group.pinned":`Pinned`,', 'en dictionary')

// 9. One-click archive: every Workspace row gains a hover button that archives
//    the Workspace's ordinary, unarchived, unpinned Sessions through the shared
//    archive action. Pinned Sessions stay pinned (the Host drops a pin when a
//    Session is archived). Running Sessions refuse the plain archive, so the
//    click counts and reports them instead of stopping a run.
source = replaceOnce(
  source,
  'function ProjectRow({group,containsCurrentDescendant=false,onToggle,drag:offeredDrag,home,newShortcut,t,actions,renderFactorySlot,useContextMenuTarget,useContextMenu}){',
  'function ProjectRow({group,containsCurrentDescendant=false,onToggle,drag:offeredDrag,home,newShortcut,t,actions,archiveableCount=0,onArchiveAll,renderFactorySlot,useContextMenuTarget,useContextMenu}){',
  'ProjectRow signature',
)

source = replaceOnce(
  source,
  'const{getTriggerProps}=useContextMenu();const drag=actions.reorder?offeredDrag:void 0;',
  'const{getTriggerProps}=useContextMenu();const[archiving,setArchiving]=(0,react.useState)(false);const drag=actions.reorder?offeredDrag:void 0;',
  'ProjectRow archive-all state',
)

// 10. The row's hover actions: archive-all sits between the "..." menu and the
//     new-Session button, so the primary create action keeps its position.
source = replaceOnce(
  source,
  'create!==void 0&&(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip,{label:t(`actions.newSession`),',
  [
    'archiveableCount>0&&(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip,{',
    'label:t(`actions.archiveAll`),',
    'side:`bottom`,align:`end`,delayMs:500,portal:!0,',
    'children:(0,react_jsx_runtime.jsx)(`button`,{',
    'type:`button`,',
    'className:Rows_module_css_default.iconButton,',
    '"aria-label":t(`actions.archiveAll.aria`,{name:label}),',
    'disabled:archiving,',
    'onClick:e=>{',
    'e.stopPropagation();',
    'if(archiving||onArchiveAll===void 0)return;',
    'setArchiving(!0);',
    'Promise.resolve(onArchiveAll()).catch(reason=>{',
    'console.warn("workspace archive rejected:",reason);',
    '}).finally(()=>{',
    'setArchiving(false);',
    '});',
    '},',
    'children:(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconArchiveOutlineRegular,{})',
    '})',
    '}),',
    'create!==void 0&&(0,react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip,{label:t(`actions.newSession`),',
  ].join(''),
  'ProjectRow archive-all button',
)

source = replaceOnce(
  source,
  '(0,react_jsx_runtime.jsx)(ProjectRowItem,{newShortcut:shortcuts.find(row=>row.id===`session.new`),group,',
  [
    '(0,react_jsx_runtime.jsx)(ProjectRowItem,{newShortcut:shortcuts.find(row=>row.id===`session.new`),group,',
    'archiveableCount:group.workspaceId===void 0?0:archiveableCounts.get(group.workspaceId)??0,',
    'onArchiveAll:group.workspaceId===void 0?void 0:()=>archiveWorkspaceSessions(group.workspaceId),',
  ].join(''),
  'renderGroup ProjectRowItem archive-all props',
)

// 11. The browser counts each Workspace's archiveable members, so the button only
//     renders where a click has something to archive. The count is derived from
//     the same membership rule the click uses, so the two can never drift apart.
source = replaceOnce(
  source,
  'const archivedSessionIds=useWorkspaces(state=>state.archivedSessionIds);const pinnedSessionIds=useWorkspaces(state=>state.pinnedSessionIds);',
  [
    'const archivedSessionIds=useWorkspaces(state=>state.archivedSessionIds);',
    'const pinnedSessionIds=useWorkspaces(state=>state.pinnedSessionIds);',
    'const archiveableCounts=(0,react.useMemo)(()=>archiveableCountsByWorkspace(list,workspaces,archivedSessionIds,pinnedSessionIds),[workspaces,list,archivedSessionIds,pinnedSessionIds]);',
  ].join(''),
  'browser archiveable counts',
)

source = replaceOnce(
  source,
  'notifyArchivedNotOpenable,renameWorkspace,useWorkspaceActionRequest,',
  'notifyArchivedNotOpenable,renameWorkspace,archiveWorkspaceSessions,useWorkspaceActionRequest,',
  'WorkspaceBrowser archive-all prop',
)

// 11b. The rows live one component lower, so SessionTree receives both the counts
//      and the operation the row button calls.
source = replaceOnce(
  source,
  'function SessionTree({list,useSessionStatus,startSession,open,workspaces,ungroupedSessionIds,rowState,onLeaveArchivedOnly,workspaceReady,animationResetKey,usePanelInfo,useSessionAccess,useWorkspaceAccess,onSessionRenameRequest,renderSlot,renderFactorySlot,useContextMenuTarget,useContextMenu,insertWorkspaceBefore,nestWorkspaces,groupExpansion,setGroupExpanded,setSessionOrder,home,t,revealSessionId,onSessionRevealed,shortcuts}){',
  'function SessionTree({list,useSessionStatus,startSession,open,workspaces,ungroupedSessionIds,rowState,archiveableCounts,archiveWorkspaceSessions,onLeaveArchivedOnly,workspaceReady,animationResetKey,usePanelInfo,useSessionAccess,useWorkspaceAccess,onSessionRenameRequest,renderSlot,renderFactorySlot,useContextMenuTarget,useContextMenu,insertWorkspaceBefore,nestWorkspaces,groupExpansion,setGroupExpanded,setSessionOrder,home,t,revealSessionId,onSessionRevealed,shortcuts}){',
  'SessionTree signature',
)

source = replaceOnce(
  source,
  'setSessionOrder:saveSessionOrder,rowState,onLeaveArchivedOnly:leaveArchivedOnly,startSession,',
  'setSessionOrder:saveSessionOrder,rowState,archiveableCounts,archiveWorkspaceSessions,onLeaveArchivedOnly:leaveArchivedOnly,startSession,',
  'SessionTree archive-all props',
)

// 12. The bulk operation: one Host archive call per target. A Session with running
//     work is counted as skipped rather than stopped, and a Session pinned after
//     the click was computed is left alone.
source = replaceOnce(
  source,
  'const uiWorkspace=new UiWorkspaceService(ctx,ctx.remote.directoryPicker,workspaces,sessions,viewInstance.actions,notify);',
  [
    'const uiWorkspace=new UiWorkspaceService(ctx,ctx.remote.directoryPicker,workspaces,sessions,viewInstance.actions,notify);',
    '/**',
    '* Archive every ordinary, unarchived, unpinned Session of one Workspace.',
    '* A pin is the Host\'s only "keep this row" promise, and archiving durably',
    '* drops it, so a pinned member is never a bulk target: a click on a',
    '* Workspace row must not silently unpin a row the user lifted out of it.',
    '* A Session with running work refuses the plain archive, so it is counted',
    '* and reported instead of stopped: the click never interrupts a run.',
    '* @param workspaceId - Workspace whose members are archived.',
    '*/',
    'const archiveWorkspaceSessions=async workspaceId=>{',
    'const workspaceSnapshot=workspaces.list.getSnapshot();',
    'const workspace=workspaceSnapshot.items.find(item=>item.workspaceId===workspaceId);',
    'if(workspace===void 0)return;',
    'const targets=archiveAllTargets(sessions.list.getSnapshot(),workspace,workspaceSnapshot.archivedSessionIds,workspaceSnapshot.pinnedSessionIds);',
    'let archivedCount=0;',
    'let skipped=0;',
    'for(const sessionId of targets){',
    'if(workspaces.list.getSnapshot().pinnedSessionIds.includes(sessionId))continue;',
    'try{',
    'await uiWorkspace.archiveSession(sessionId);',
    'archivedCount+=1;',
    '}catch(reason){',
    'if(activeSessionRefusal(reason)!==void 0)skipped+=1;',
    'else console.warn("workspace archive rejected:",reason);',
    '}',
    '}',
    'if(archivedCount>0&&skipped>0)notify({kind:`archivedAllSkipped`,count:archivedCount,skipped});',
    'else if(archivedCount>0)notify({kind:`archivedAll`,count:archivedCount});',
    'else if(skipped>0)notify({kind:`archivedAllRunning`,skipped});',
    '};',
  ].join(''),
  'apply archiveWorkspaceSessions',
)

source = replaceOnce(
  source,
  'unarchiveSession:async sessionId=>{await uiWorkspace.unarchiveSession(sessionId)},',
  'unarchiveSession:async sessionId=>{await uiWorkspace.unarchiveSession(sessionId)},archiveWorkspaceSessions,',
  'browserInjected archiveWorkspaceSessions',
)

// 13. The membership rule the bulk click uses, kept pure so the tests can pin it.
source = replaceOnce(
  source,
  'function activeSessionRefusal(reason){',
  [
    '/**',
    '* The Workspace members one-click archive may archive: every ordinary,',
    '* unarchived, unpinned Session with a loaded summary, in the Workspace',
    '* order. Blank drafts and subagent children stay, so a bulk click never',
    '* discards a draft or a delegated child. Pinned Sessions stay because',
    '* archiving drops their pin on the Host; the bulk click must not unpin a',
    '* row that was deliberately lifted out of its group. Running Sessions are',
    '* filtered after the Host refuses their plain archive.',
    '* @param list - sessions list snapshot.',
    '* @param workspace - Workspace view whose membership is archived.',
    '* @param archivedSessionIds - registry-global archive set.',
    '* @param pinnedSessionIds - registry-global pin set.',
    '* @returns Session ids eligible for the bulk archive.',
    '*/',
    'function archiveAllTargets(list,workspace,archivedSessionIds,pinnedSessionIds){',
    'const archived=new Set(archivedSessionIds);',
    'const pinned=new Set(pinnedSessionIds);',
    'return workspace.sessionIds.filter(sessionId=>{',
    'const summary=list.byId[sessionId];',
    'return summary!==void 0&&!archived.has(sessionId)&&!pinned.has(sessionId)&&summary.blank!==!0&&summary.origin!==`subagent`;',
    '});',
    '}',
    '/**',
    '* Count the bulk-archive targets of every Workspace, keyed by Workspace id.',
    '* The row\'s hover button renders only on a positive count, so counting',
    '* through archiveAllTargets keeps the button and the click on one rule.',
    '* @param list - sessions list snapshot.',
    '* @param workspaces - Workspace views in Host order.',
    '* @param archivedSessionIds - registry-global archive set.',
    '* @param pinnedSessionIds - registry-global pin set.',
    '* @returns target count per Workspace id.',
    '*/',
    'function archiveableCountsByWorkspace(list,workspaces,archivedSessionIds,pinnedSessionIds){',
    'const counts=new Map();',
    'for(const workspace of workspaces)counts.set(workspace.workspaceId,archiveAllTargets(list,workspace,archivedSessionIds,pinnedSessionIds).length);',
    'return counts;',
    '}',
    'function activeSessionRefusal(reason){',
  ].join(''),
  'archiveAllTargets helper',
)

// 14. Notices for the bulk result: the count, the skipped running Sessions, or a
//     Workspace whose every Session is running.
source = replaceOnce(
  source,
  'ctx.slots.inject(`workspace.toast`,function*(){',
  [
    'ctx.slots.inject(`workspace.toast`,function*(){',
    'yield ctx.slots.register({name:`workspace.toast`,key:`archivedAll`,locale:`workspace`,inject:()=>({display:(notice,t)=>({text:t(`toast.archivedAll`,{count:notice.count}),tone:`success`,holdMs:6e3})})},ToastEntry);',
    'yield ctx.slots.register({name:`workspace.toast`,key:`archivedAllSkipped`,locale:`workspace`,inject:()=>({display:(notice,t)=>({text:t(`toast.archivedAllSkipped`,{count:notice.count,skipped:notice.skipped}),tone:`success`,holdMs:6e3})})},ToastEntry);',
    'yield ctx.slots.register({name:`workspace.toast`,key:`archivedAllRunning`,locale:`workspace`,inject:()=>({display:(notice,t)=>({text:t(`toast.archivedAllRunning`,{skipped:notice.skipped}),tone:`warning`,holdMs:6e3})})},ToastEntry);',
  ].join(''),
  'archive-all toasts',
)

// 15. Locale copy for the button and its notices. The label names the pinned
//     exemption, so a hover explains why a pinned row survives the click.
source = replaceOnce(
  source,
  '"menu.archiveSession":`归档会话`,',
  '"menu.archiveSession":`归档会话`,"actions.archiveAll":`归档全部会话（保留置顶）`,"actions.archiveAll.aria":`归档「{name}」下的全部会话（保留置顶）`,"toast.archivedAll":`已归档 {count} 个会话`,"toast.archivedAllSkipped":`已归档 {count} 个会话，{skipped} 个正在运行，已跳过`,"toast.archivedAllRunning":`工作区内 {skipped} 个会话正在运行，未归档`,',
  'zh archive-all dictionary',
)
source = replaceOnce(
  source,
  '"menu.archiveSession":`Archive session`,',
  '"menu.archiveSession":`Archive session`,"actions.archiveAll":`Archive all sessions (pinned kept)`,"actions.archiveAll.aria":`Archive all sessions in {name} (pinned kept)`,"toast.archivedAll":`Archived {count} sessions`,"toast.archivedAllSkipped":`Archived {count} sessions; skipped {skipped} that are running`,"toast.archivedAllRunning":`{skipped} sessions are running; nothing archived`,',
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
