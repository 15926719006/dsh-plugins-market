/**
 * 工作台（浏览器侧）
 *
 * 两个座位，和 `onerway-pmo` 同一套挂法：
 * - `sidebar.panellist`：左侧常驻入口（id 即面板 id）
 * - `main`：整页，key 与入口 id 相同，点入口就切到这一页
 *
 * 任务的定义：**会话正文里出现 devops 单号才算一件任务**；同一个单号出现在
 * 多个会话里，就归到同一个任务下面。正文扫描在 Host 做（`/api/workbench/refs`），
 * 这里只负责分组与呈现。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** 左侧入口 id，同时也是 `main` 的 key。 */
    const PANEL_ID = 'workbench'

    const NOTES_ROUTE = '/api/workbench/notes'
    const CONFIG_ROUTE = '/api/workbench/config'
    const REFS_ROUTE = '/api/workbench/refs'

    /** 兜底：Host 扫不到正文时，退回从会话标题里认编号。 */
    const REF_PATTERN = /\b(RO-\d{8}-\d{3}(?:-S\d+)?|T-\d{8}-\d{3}|P-\d{8}-\d{3}|BUG-\d{8}-\d{3}|ON3-\d{4,})\b/

    /** 排障：把异常打回 Host 写日志（页面控制台看不到时也能查）。 */
    function report(label, message) {
      try {
        fetch('/api/workbench/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            label,
            message: message instanceof Error ? `${message.message}\n${message.stack ?? ''}` : String(message),
          }),
        })
      } catch {
        // 日志本身不能再抛。
      }
    }

    /** 本周一 00:00 到下周一 00:00（本地时区）。 */
    function weekRange(now = new Date()) {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const dow = (start.getDay() + 6) % 7 // 周一 = 0
      start.setDate(start.getDate() - dow)
      const end = new Date(start)
      end.setDate(end.getDate() + 7)
      return { start: start.getTime(), end: end.getTime() }
    }

    /** MM-DD */
    function md(timestamp) {
      const d = new Date(timestamp)
      return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    /** 项目名 = 会话 cwd 的最后一段。 */
    function projectOf(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return '未知'
      const parts = cwd.split('/').filter(Boolean)
      return parts[parts.length - 1] ?? cwd
    }

    /** 从文本里认编号；子任务归到父需求。 */
    function refOf(text) {
      if (typeof text !== 'string') return null
      const hit = REF_PATTERN.exec(text)
      return hit === null ? null : hit[1].replace(/-S\d+$/u, '')
    }

    /** 主题 token，跟着 DSH 的亮/暗色走。 */
    const C = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const styles = {
      page: {
        height: '100%',
        overflowY: 'auto',
        background: C.base,
        color: C.label1,
        font: '13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif',
      },
      shell: { maxWidth: 1040, margin: '0 auto', padding: '26px 28px 56px' },
      header: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 },
      h1: { fontSize: 19, fontWeight: 650, letterSpacing: '-0.01em' },
      week: { fontSize: 12, color: C.label2 },
      spacer: { flex: 1 },
      actions: { display: 'flex', gap: 8, alignItems: 'center' },
      button: {
        appearance: 'none',
        border: `1px solid ${C.border2}`,
        background: C.layer1,
        color: C.label1,
        borderRadius: 8,
        padding: '5px 11px',
        fontSize: 12,
        cursor: 'pointer',
      },
      primary: {
        appearance: 'none',
        border: `1px solid ${C.border2}`,
        background: C.brand,
        color: '#fff',
        borderRadius: 8,
        padding: '5px 11px',
        fontSize: 12,
        cursor: 'pointer',
      },
      summary: {
        display: 'flex',
        gap: 20,
        alignItems: 'flex-end',
        margin: '14px 0 6px',
        padding: '12px 14px',
        border: `1px solid ${C.border1}`,
        borderRadius: 12,
        background: C.layer1,
      },
      metric: { display: 'flex', flexDirection: 'column', gap: 2 },
      metricValue: { fontSize: 20, fontWeight: 650, lineHeight: 1.1 },
      metricLabel: { fontSize: 11, color: C.label2 },
      sectionTitle: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '22px 0 10px',
        fontSize: 12,
        color: C.label2,
      },
      badge: {
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 999,
        background: C.layer2,
        color: C.label2,
      },
      card: {
        border: `1px solid ${C.border1}`,
        borderRadius: 11,
        marginBottom: 10,
        background: C.layer1,
        overflow: 'hidden',
      },
      cardHead: {
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '11px 14px 0',
      },
      ref: {
        flex: 'none',
        fontSize: 12,
        fontWeight: 600,
        padding: '1px 7px',
        borderRadius: 5,
        border: `1px solid ${C.border2}`,
        color: C.label1,
        font: '12px/18px ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      headMeta: { fontSize: 11.5, color: C.label2, display: 'flex', gap: 10, alignItems: 'center' },
      statusChip: { flex: 'none', fontSize: 11 },
      cardBody: { padding: '8px 14px 12px' },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        marginTop: 7,
        background: C.base,
        border: `1px solid ${C.border1}`,
        borderRadius: 7,
        color: C.label1,
        font: 'inherit',
        padding: '6px 9px',
        outline: 'none',
      },
      members: { marginTop: 8, borderTop: `1px solid ${C.border1}`, paddingTop: 6 },
      memberRow: {
        display: 'flex',
        gap: 8,
        alignItems: 'baseline',
        padding: '4px 2px',
        fontSize: 12,
        cursor: 'pointer',
      },
      memberTitle: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      memberMeta: { flex: 'none', fontSize: 11, color: C.label2 },
      toggle: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: C.label2,
        font: 'inherit',
        fontSize: 11.5,
        cursor: 'pointer',
        padding: '2px 0',
      },
      empty: { fontSize: 12, color: C.label2, padding: '8px 2px' },
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        marginTop: 26,
        paddingTop: 14,
        borderTop: `1px solid ${C.border1}`,
        fontSize: 11.5,
        color: C.label2,
      },
      pathInput: {
        flex: 1,
        background: C.layer1,
        border: `1px solid ${C.border1}`,
        borderRadius: 7,
        color: C.label2,
        font: '11.5px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '5px 9px',
        outline: 'none',
      },
      toast: {
        position: 'fixed',
        left: '50%',
        bottom: 32,
        transform: 'translateX(-50%)',
        zIndex: 950,
        background: C.layer2,
        border: `1px solid ${C.border2}`,
        color: C.label1,
        borderRadius: 10,
        padding: '8px 14px',
        fontSize: 12,
      },
    }

    /**
     * 会话 + 旁注 → 任务列表。
     *
     * 任务主键是单号：`devops:<ref>`。同一个单号出现在几个会话里，就只有一个任务，
     * 成员是这些会话。没有单号的会话不算任务，单独列出来。
     */
    function groupTasks(sessions, notes) {
      const byRef = new Map()
      for (const session of sessions) {
        for (const ref of session.refs) {
          const existing = byRef.get(ref)
          if (existing === undefined) {
            byRef.set(ref, { key: `devops:${ref}`, ref, sessions: [session] })
          } else {
            existing.sessions.push(session)
          }
        }
      }

      const tasks = []
      for (const task of byRef.values()) {
        task.sessions.sort((a, b) => b.updatedAt - a.updatedAt)
        const latest = task.sessions[0]
        const note = notes[task.key] ?? {}
        const outcome = typeof note.outcome === 'string' ? note.outcome.trim() : ''
        const status = typeof note.status === 'string' && note.status !== ''
          ? note.status
          : outcome !== '' ? 'done' : 'open'
        tasks.push({
          ...task,
          updatedAt: latest.updatedAt,
          running: task.sessions.some((session) => session.running),
          outcome,
          next: typeof note.next === 'string' ? note.next : '',
          status,
          doneAt: typeof note.updatedAt === 'number' ? note.updatedAt : 0,
        })
      }
      tasks.sort((a, b) => b.updatedAt - a.updatedAt)

      const unlinked = sessions
        .filter((session) => session.refs.length === 0)
        .map((session) => {
          const key = `session:${session.id}`
          const note = notes[key] ?? {}
          const outcome = typeof note.outcome === 'string' ? note.outcome.trim() : ''
          const status = typeof note.status === 'string' && note.status !== ''
            ? note.status
            : outcome !== '' ? 'done' : 'open'
          return {
            ...session,
            key,
            outcome,
            next: typeof note.next === 'string' ? note.next : '',
            status,
            doneAt: typeof note.updatedAt === 'number' ? note.updatedAt : 0,
          }
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)

      return { tasks, unlinked }
    }

    /** 周报草稿：本周收尾的任务写结论，进行中的写下一步。 */
    function weeklyDraft(tasks) {
      const { start, end } = weekRange()
      const done = tasks.filter((task) => task.status === 'done' && task.doneAt >= start && task.doneAt < end)
      const open = tasks.filter((task) => task.status === 'open')
      const lines = [`## 本周完成（${md(start)} ~ ${md(end - 1)}）`]
      if (done.length === 0) lines.push('- （无）')
      for (const task of done) {
        lines.push(`- ${task.ref}（${task.sessions.length} 个会话）${task.outcome === '' ? '' : `：${task.outcome}`}`)
      }
      lines.push('', '## 进行中')
      if (open.length === 0) lines.push('- （无）')
      for (const task of open) {
        lines.push(`- ${task.ref}${task.next === '' ? '' : ` → ${task.next}`}`)
      }
      return lines.join('\n')
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        report('apply-start', `slots=${ctx.slots === undefined ? 'missing' : 'ok'}`)

        // 服务在渲染时按需取：页面启动时它们可能还没就绪，放在模块级 inject
        // 会让整体一直等待、静默不执行。
        const service = (name) => {
          try {
            return ctx.get(name)
          } catch {
            return undefined
          }
        }

        /** 会话快照里属于工作目录的那些会话。 */
        const readSessions = (root) => {
          if (typeof root !== 'string' || root === '') return []
          const sessions = service('sessions')
          if (sessions?.list?.getSnapshot === undefined) return []
          const byId = sessions.list.getSnapshot().byId ?? {}
          const rows = []
          for (const id of Object.keys(byId)) {
            const summary = byId[id]
            if (summary === undefined || summary === null) continue
            const cwd = typeof summary.cwd === 'string' ? summary.cwd : ''
            if (cwd !== root && !cwd.startsWith(`${root}/`)) continue
            // 子会话（以及空草稿）不参与：它们由父会话代表，算进来只会重复计数。
            if (summary.blank === true || summary.origin === 'subagent') continue
            const title = summary.displayTitle ?? id
            rows.push({
              id,
              title,
              cwd,
              project: projectOf(cwd),
              updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
              running: summary.running === true,
              refs: [],
            })
          }
          rows.sort((a, b) => b.updatedAt - a.updatedAt)
          return rows
        }

        const loadNotes = async () => {
          const response = await fetch(NOTES_ROUTE, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.error ?? '读取旁注失败')
          return { notes: body.notes ?? {}, config: body.config ?? { workRoot: '' } }
        }

        /** 让 Host 扫会话正文里的单号；标题里认出来的编号也算。 */
        const loadRefs = async (sessions) => {
          const response = await fetch(REFS_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessions: sessions.map((session) => ({ id: session.id, updatedAt: session.updatedAt })) }),
          })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.error ?? '扫描单号失败')
          return body
        }

        const saveNote = async (key, patch) => {
          const response = await fetch(NOTES_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ key, patch }),
          })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.error ?? '保存失败')
          return body.note
        }

        const saveConfig = async (workRoot) => {
          const response = await fetch(CONFIG_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workRoot }),
          })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.error ?? '保存失败')
          return body.config
        }

        /** 左侧入口的图标：跟着文字的 currentColor 走。 */
        let iconReported = false
        function PanelIcon(props) {
          if (iconReported === false) {
            iconReported = true
            report('ready', 'sidebar entry rendered')
          }
          const size = typeof props?.size === 'number' ? props.size : 18
          const active = props?.active === true
          return h('span', {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'inherit',
              opacity: active ? 1 : 0.62,
            },
          }, h('svg', {
            viewBox: '0 0 24 24',
            width: size,
            height: size,
            fill: 'none',
            'aria-hidden': 'true',
            style: { display: 'block' },
          },
          h('rect', { x: 2.8, y: 3.6, width: 18.4, height: 16.8, rx: 4, stroke: 'currentColor', strokeWidth: 1.6 }),
          h('path', { d: 'M7 9.2h10M7 12.9h6.6M7 16.6h8.4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          ))
        }

        /** 一个任务：单号 + 成员会话 + 结论/下一步。 */
        function TaskCard({ task, onSave, onOpen }) {
          const [outcome, setOutcome] = useState(task.outcome)
          const [next, setNext] = useState(task.next)
          const [expanded, setExpanded] = useState(false)
          useEffect(() => {
            setOutcome(task.outcome)
            setNext(task.next)
          }, [task.outcome, task.next])

          const commit = (field, value) => {
            const trimmed = value.trim()
            if (trimmed === (field === 'outcome' ? task.outcome : task.next)) return
            onSave(task.key, field === 'outcome'
              ? { outcome: trimmed, status: trimmed === '' ? 'open' : 'done' }
              : { next: trimmed })
          }

          const statusColor = task.status === 'done' ? C.success : task.status === 'dropped' ? C.idle : C.warn
          const statusText = task.status === 'dropped' ? '已放弃' : task.status === 'done' ? '已收尾' : '未收尾'

          return h('div', { style: styles.card },
            h('div', { style: styles.cardHead },
              h('span', { style: styles.ref }, task.ref),
              h('span', { style: styles.headMeta },
                h('span', null, `${task.sessions.length} 个会话`),
                h('span', null, `最近 ${md(task.updatedAt)}`),
                task.running ? h('span', { style: { color: C.success } }, '运行中') : null,
              ),
              h('span', { style: styles.spacer }),
              h('span', { style: { ...styles.statusChip, color: statusColor } }, statusText),
            ),
            h('div', { style: styles.cardBody },
              h('input', {
                style: styles.input,
                placeholder: '结论：这个单最终交付了什么',
                value: outcome,
                onChange: (event) => setOutcome(event.target.value),
                onBlur: (event) => commit('outcome', event.target.value),
              }),
              h('input', {
                style: styles.input,
                placeholder: '下一步（留空 = 没有后续）',
                value: next,
                onChange: (event) => setNext(event.target.value),
                onBlur: (event) => commit('next', event.target.value),
              }),
              h('div', { style: styles.members },
                h('button', { style: styles.toggle, onClick: () => setExpanded((value) => !value) },
                  `${expanded ? '▾' : '▸'} ${task.sessions.length} 个会话`),
                expanded
                  ? task.sessions.map((session) => h('div', {
                    key: session.id,
                    style: styles.memberRow,
                    onClick: () => onOpen(session.id),
                    title: session.title,
                  },
                  h('span', { style: styles.memberTitle }, session.title),
                  h('span', { style: styles.memberMeta }, `${session.project} · ${md(session.updatedAt)}`),
                  ))
                  : null,
              ),
            ),
          )
        }

        /** 没有单号的会话：不算任务，单列，可折叠。 */
        function UnlinkedCard({ session, onSave, onOpen }) {
          const [outcome, setOutcome] = useState(session.outcome)
          const [next, setNext] = useState(session.next)
          useEffect(() => {
            setOutcome(session.outcome)
            setNext(session.next)
          }, [session.outcome, session.next])
          const commit = (field, value) => {
            const trimmed = value.trim()
            if (trimmed === (field === 'outcome' ? session.outcome : session.next)) return
            onSave(session.key, field === 'outcome'
              ? { outcome: trimmed, status: trimmed === '' ? 'open' : 'done' }
              : { next: trimmed })
          }
          return h('div', { style: styles.card },
            h('div', { style: styles.cardHead },
              h('span', { style: styles.memberTitle, onClick: () => onOpen(session.id), title: session.title }, session.title),
              h('span', { style: styles.headMeta }, `${session.project} · ${md(session.updatedAt)}`),
            ),
            h('div', { style: styles.cardBody },
              h('input', {
                style: styles.input,
                placeholder: '结论：做了什么（没有单号也算记录）',
                value: outcome,
                onChange: (event) => setOutcome(event.target.value),
                onBlur: (event) => commit('outcome', event.target.value),
              }),
              h('input', {
                style: styles.input,
                placeholder: '下一步（留空 = 没有后续）',
                value: next,
                onChange: (event) => setNext(event.target.value),
                onBlur: (event) => commit('next', event.target.value),
              }),
            ),
          )
        }

        function WorkbenchPage() {
          const [notes, setNotes] = useState({})
          const [config, setConfig] = useState({ workRoot: '' })
          const [sessions, setSessions] = useState([])
          const [tasks, setTasks] = useState([])
          const [unlinked, setUnlinked] = useState([])
          const [scan, setScan] = useState(null)
          const [loading, setLoading] = useState(true)
          const [error, setError] = useState(null)
          const [toast, setToast] = useState(null)
          const [showAll, setShowAll] = useState(false)
          const [showUnlinked, setShowUnlinked] = useState(false)

          const refresh = useCallback(async () => {
            setLoading(true)
            try {
              const loaded = await loadNotes()
              const root = (loaded.config?.workRoot ?? '').replace(/\/+$/, '')
              setConfig({ workRoot: root })
              const sessions = readSessions(root)

              let refsMap = {}
              let scanned = 0
              let pending = 0
              try {
                // Host 每轮只扫一批（单轮读上百份日志会让首屏很慢），这里把没扫完的补完。
                for (let round = 0; round < 20; round += 1) {
                  const result = await loadRefs(sessions)
                  refsMap = { ...refsMap, ...(result.refs ?? {}) }
                  scanned += result.scanned ?? 0
                  pending = result.pending ?? 0
                  if (pending === 0) break
                  setScan({ sessions: sessions.length, tasks: 0, scanned, pending })
                }
              } catch (reason) {
                report('refs', reason)
              }

              const merged = sessions.map((session) => {
                const found = Array.isArray(refsMap[session.id]) ? refsMap[session.id] : []
                // 只认一个单号：即使 Host 是旧版把所有编号都返回来，也不让它扩散。
                return { ...session, refs: found.length > 0 ? [found[0]] : [] }
              })

              const grouped = groupTasks(merged, loaded.notes)
              setNotes(loaded.notes)
              setSessions(merged)
              setTasks(grouped.tasks)
              setUnlinked(grouped.unlinked)
              setScan({ sessions: merged.length, tasks: grouped.tasks.length, scanned, pending })
              report('board', JSON.stringify({
                sessions: merged.length,
                tasks: grouped.tasks.length,
                unlinked: grouped.unlinked.length,
                scanned,
                pending,
              }))
              setError(null)
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason))
            } finally {
              setLoading(false)
            }
          }, [])

          useEffect(() => {
            refresh()
          }, [refresh])

          // 备注一改就重新分组：会话本身不变，只换旁注。
          useEffect(() => {
            if (sessions.length === 0) return
            const grouped = groupTasks(sessions, notes)
            setTasks(grouped.tasks)
            setUnlinked(grouped.unlinked)
          }, [sessions, notes])

          useEffect(() => {
            if (toast === null) return undefined
            const timer = setTimeout(() => setToast(null), 1800)
            return () => clearTimeout(timer)
          }, [toast])

          const onSave = useCallback((key, patch) => {
            saveNote(key, patch)
              .then((note) => setNotes((current) => ({ ...current, [key]: note })))
              .catch((reason) => setToast(`保存失败：${reason.message}`))
          }, [])

          const onOpen = useCallback((sessionId) => {
            service('uiWorkspace')?.openSession(sessionId)
          }, [])

          const { start, end } = weekRange()
          const openTasks = tasks.filter((task) => task.status === 'open')
          const doneThisWeek = tasks.filter((task) => task.status === 'done' && task.doneAt >= start && task.doneAt < end)
          const doneBefore = tasks.filter((task) => task.status === 'done' && (task.doneAt < start || task.doneAt === 0))
          const visibleOpen = showAll ? openTasks : openTasks.slice(0, 30)
          const hiddenOpen = openTasks.length - visibleOpen.length

          const section = (label, list, renderRow, emptyText, extra) => h('div', { key: label },
            h('div', { style: styles.sectionTitle }, label, h('span', { style: styles.badge }, String(list.length))),
            list.length === 0 ? h('div', { style: styles.empty }, emptyText) : list.map(renderRow),
            extra ?? null,
          )

          return h('div', { style: styles.page },
            h('div', { style: styles.shell },
              h('div', { style: styles.header },
                h('span', { style: styles.h1 }, '工作台'),
                h('span', { style: styles.week }, `${md(start)} ~ ${md(end - 1)} · 任务 = 会话正文里出现过的 devops 单号`),
                h('span', { style: styles.spacer }),
                h('div', { style: styles.actions },
                  h('button', { style: styles.button, onClick: refresh, disabled: loading }, loading ? '刷新中…' : '刷新'),
                  h('button', {
                    style: styles.primary,
                    onClick: () => {
                      navigator.clipboard?.writeText(weeklyDraft(tasks))
                      setToast('周报草稿已复制')
                    },
                  }, '复制周报草稿'),
                ),
              ),
              h('div', { style: styles.summary },
                h('div', { style: styles.metric },
                  h('span', { style: { ...styles.metricValue, color: openTasks.length === 0 ? C.label1 : C.warn } }, String(openTasks.length)),
                  h('span', { style: styles.metricLabel }, '进行中的任务'),
                ),
                h('div', { style: styles.metric },
                  h('span', { style: { ...styles.metricValue, color: C.success } }, String(doneThisWeek.length)),
                  h('span', { style: styles.metricLabel }, '本周收尾'),
                ),
                h('div', { style: styles.metric },
                  h('span', { style: styles.metricValue }, String(scan === null ? 0 : scan.sessions)),
                  h('span', { style: styles.metricLabel }, '工作目录内会话'),
                ),
                h('div', { style: styles.metric },
                  h('span', { style: styles.metricValue, color: unlinked.length === 0 ? C.label1 : C.label2 }, String(unlinked.length)),
                  h('span', { style: styles.metricLabel }, '未挂单的会话'),
                ),
                h('div', { style: { ...styles.metric, marginLeft: 'auto', alignItems: 'flex-end' } },
                  h('span', { style: { ...styles.metricLabel, maxWidth: 320, textAlign: 'right' } }, config.workRoot),
                  h('span', { style: styles.metricLabel }, scan?.pending > 0 ? `正在扫描 ${scan.scanned} 条，还有 ${scan.pending} 条` : '只统计这个目录'),
                ),
              ),
              error === null ? null : h('div', { style: { ...styles.empty, color: C.error } }, `读取失败：${error}`),
              section('进行中的任务', visibleOpen,
                (task) => h(TaskCard, { key: task.key, task, onSave, onOpen }),
                '没有进行中的任务。',
                hiddenOpen <= 0 ? null : h('button', {
                  style: { ...styles.button, marginTop: 2 },
                  onClick: () => setShowAll(true),
                }, `还有 ${hiddenOpen} 个更早的任务，展开`),
              ),
              section(`本周收尾（${md(start)} ~ ${md(end - 1)}）`, doneThisWeek,
                (task) => h(TaskCard, { key: task.key, task, onSave, onOpen }),
                '本周还没有写结论的任务。'),
              doneBefore.length === 0 ? null : section('更早收尾', doneBefore.slice(0, 20),
                (task) => h(TaskCard, { key: task.key, task, onSave, onOpen }), ''),
              section('未挂单的会话', showUnlinked ? unlinked : [],
                (session) => h(UnlinkedCard, { key: session.key, session, onSave, onOpen }),
                showUnlinked ? '没有未挂单的会话。' : '',
                unlinked.length === 0 ? null : h('button', {
                  style: { ...styles.button, marginTop: 2 },
                  onClick: () => setShowUnlinked((value) => !value),
                }, showUnlinked ? '收起' : `展开 ${unlinked.length} 条（正文里没有单号）`),
              ),
              h('div', { style: styles.footer },
                h('span', { style: { flex: 'none' } }, '工作目录'),
                h('input', {
                  style: styles.pathInput,
                  defaultValue: config.workRoot,
                  key: config.workRoot,
                  onBlur: (event) => {
                    const value = event.target.value.trim()
                    if (value === '' || value === config.workRoot) return
                    saveConfig(value).then(() => refresh()).catch((reason) => setToast(`保存失败：${reason.message}`))
                  },
                }),
                h('span', { style: { flex: 'none' } }, '失焦即存'),
                h('span', { style: { flex: 'none' } }, '· 归类规则：每个会话只认一个单号'),
              ),
              toast === null ? null : h('div', { style: styles.toast }, toast),
            ),
          )
        }

        const guard = (label, build) => {
          try {
            return ctx.effect(() => {
              try {
                return build()
              } catch (error) {
                report(`${label}:effect`, error)
                return () => {}
              }
            }, label)
          } catch (error) {
            report(`${label}:guard`, error)
            return () => {}
          }
        }

        const seat = (slotName, label, spec, Component) => guard(label, () => ctx.slots.inject(slotName, () => {
          try {
            return ctx.slots.register(spec, Component)
          } catch (error) {
            report(`${label}:register`, error)
            return () => {}
          }
        }))

        // 官方约定：`id` + 可选 `order` + 字面量文案。这里是「左侧栏面板」，
        // 和 onerway-pmo / Mini Bots 同一排。
        seat('sidebar.panellist', 'panellist', {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 6,
          label: '工作台',
        }, PanelIcon)

        seat('main', 'main', { name: 'main', key: PANEL_ID, id: PANEL_ID }, WorkbenchPage)

        // 临时自检：每个标签页首次加载时打开一次工作台，让我能从日志看到分组结果。
        try {
          if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('workbench:probe') === null) {
            sessionStorage.setItem('workbench:probe', '1')
            setTimeout(() => {
              try {
                service('layout').selectPanel(PANEL_ID)
              } catch (error) {
                report('probe:select', error)
              }
            }, 2500)
          }
        } catch (error) {
          report('probe', error)
        }

        // `apply` 的返回值会被 Cordis 当成 disposer：生产环境一律不返回。
        if (globalThis.__workbenchTest === true) {
          return { groupTasks, weeklyDraft, weekRange, refOf, projectOf }
        }
        return undefined
      },
    }
  },
})

