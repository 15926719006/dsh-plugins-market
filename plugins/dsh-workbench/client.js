/**
 * 工作台（浏览器侧）
 *
 * 两个座位：
 * - `conversation.composer.dock`：输入框下方一枚「工作台」胶囊，显示未收尾数量
 * - `shell.overlay`：整屏浮层，进行中 / 未收尾 / 本周收尾 + 生成周报草稿
 *
 * 不接管任何官方 Slot，不 fork 官方 bundle：只用官方 `sessions` / `workspaces`
 * 快照做派生，旁注走 Host 的 `/api/workbench/*` 路由。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState, useSyncExternalStore } = React

    const NOTES_ROUTE = '/api/workbench/notes'
    const CONFIG_ROUTE = '/api/workbench/config'

    /** 单号：优先从标题里已有的 devops 前缀识别。 */
    const REF_PATTERN = /\b(RO-\d{8}-\d{3}(?:-S\d+)?|T-\d{8}-\d{3}|P-\d{8}-\d{3}|BUG-\d{8}-\d{3}|ON3-\d+)\b/

    /** 极小的可订阅状态，供两个座位共享。 */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        set(next) {
          value = typeof next === 'function' ? next(value) : next
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
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

    /** 项目名 = 会话 cwd 的最后一段 */
    function projectOf(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return '未知'
      const parts = cwd.split('/').filter(Boolean)
      return parts[parts.length - 1] ?? cwd
    }

    /** 从标题里捞单号。 */
    function refOf(title) {
      if (typeof title !== 'string') return null
      const hit = REF_PATTERN.exec(title)
      return hit === null ? null : hit[1]
    }

    const styles = {
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 900,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(8, 10, 14, 0.55)',
        backdropFilter: 'blur(2px)',
      },
      panel: {
        width: 'min(1040px, 92vw)',
        height: 'min(760px, 86vh)',
        display: 'flex',
        flexDirection: 'column',
        background: '#1b1e24',
        color: '#e7e9ee',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 16,
        boxShadow: '0 24px 64px rgba(0,0,0,0.45)',
        overflow: 'hidden',
        font: '13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif',
      },
      header: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 18px',
        borderBottom: '1px solid rgba(255,255,255,0.09)',
      },
      title: { fontSize: 15, fontWeight: 600 },
      week: { fontSize: 12, color: '#9aa3b2' },
      spacer: { flex: 1 },
      button: {
        appearance: 'none',
        border: '1px solid rgba(255,255,255,0.16)',
        background: 'rgba(255,255,255,0.06)',
        color: '#e7e9ee',
        borderRadius: 8,
        padding: '5px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      primary: {
        appearance: 'none',
        border: '1px solid rgba(90,150,255,0.5)',
        background: 'rgba(90,150,255,0.18)',
        color: '#cfe0ff',
        borderRadius: 8,
        padding: '5px 10px',
        fontSize: 12,
        cursor: 'pointer',
      },
      body: { flex: 1, overflowY: 'auto', padding: '6px 18px 18px' },
      sectionTitle: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '18px 0 8px',
        fontSize: 12,
        letterSpacing: '0.04em',
        color: '#9aa3b2',
        textTransform: 'uppercase',
      },
      badge: {
        fontSize: 11,
        padding: '0 6px',
        borderRadius: 999,
        background: 'rgba(255,255,255,0.1)',
        color: '#cfd5e0',
      },
      row: {
        display: 'grid',
        gridTemplateColumns: '1fr 150px',
        gap: 10,
        padding: '10px 12px',
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 10,
        marginBottom: 8,
        background: 'rgba(255,255,255,0.02)',
      },
      rowTitle: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
      },
      meta: { fontSize: 11, color: '#8590a2', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap' },
      ref: {
        fontSize: 11,
        padding: '0 6px',
        borderRadius: 4,
        background: 'rgba(120,170,255,0.16)',
        color: '#a9c8ff',
        border: '1px solid rgba(120,170,255,0.3)',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        marginTop: 8,
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 7,
        color: '#e7e9ee',
        font: 'inherit',
        padding: '6px 8px',
        outline: 'none',
      },
      side: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 },
      pill: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        margin: '6px 0 0',
        border: '1px solid rgba(255,255,255,0.14)',
        background: 'rgba(255,255,255,0.05)',
        borderRadius: 999,
        color: '#cfd5e0',
        font: '12px/1.4 -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
        cursor: 'pointer',
      },
      empty: { fontSize: 12, color: '#8590a2', padding: '10px 2px' },
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '12px 18px',
        borderTop: '1px solid rgba(255,255,255,0.09)',
        background: 'rgba(0,0,0,0.15)',
      },
      toast: {
        position: 'fixed',
        left: '50%',
        bottom: 48,
        transform: 'translateX(-50%)',
        zIndex: 1000,
        background: 'rgba(30,34,42,0.96)',
        border: '1px solid rgba(255,255,255,0.14)',
        color: '#e7e9ee',
        borderRadius: 10,
        padding: '8px 14px',
        fontSize: 12,
      },
      pathInput: {
        flex: 1,
        background: 'rgba(0,0,0,0.25)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 7,
        color: '#9aa3b2',
        font: '11px/1.4 ui-monospace, monospace',
        padding: '5px 8px',
        outline: 'none',
      },
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        const ui = createStore({ open: false, counts: null, toast: null })
        const sessions = ctx.get('sessions')
        const workspaces = ctx.get('workspaces')
        const uiWorkspace = ctx.get('uiWorkspace')
        let config = { workRoot: '' }

        /** 从官方快照派生行。 */
        const buildRows = (notes, rootOverride) => {
          if (sessions?.list?.getSnapshot === undefined) return []
          const list = sessions.list.getSnapshot()
          const byId = list.byId ?? {}
          const registry = workspaces?.list?.getSnapshot?.() ?? { archivedSessionIds: [] }
          const archived = new Set(registry.archivedSessionIds ?? [])
          const root = (rootOverride ?? config.workRoot ?? '').replace(/\/+$/, '')
          if (root === '') return []
          const rows = []
          for (const id of Object.keys(byId)) {
            const summary = byId[id]
            if (summary === undefined || summary === null) continue
            const cwd = typeof summary.cwd === 'string' ? summary.cwd : ''
            if (cwd !== root && !cwd.startsWith(`${root}/`)) continue
            if (summary.origin === 'subagent' || summary.blank === true) continue
            const note = notes[id] ?? {}
            const outcome = typeof note.outcome === 'string' ? note.outcome.trim() : ''
            const status = typeof note.status === 'string' && note.status !== '' ? note.status : outcome !== '' ? 'done' : 'open'
            rows.push({
              id,
              title: summary.displayTitle ?? id,
              cwd,
              project: projectOf(cwd),
              updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : 0,
              running: summary.running === true,
              archived: archived.has(id),
              outcome,
              next: typeof note.next === 'string' ? note.next : '',
              status,
              ref: refOf(summary.displayTitle),
              note,
            })
          }
          rows.sort((a, b) => b.updatedAt - a.updatedAt)
          return rows
        }

        /** 读旁注与配置。 */
        const loadAll = async () => {
          const response = await fetch(NOTES_ROUTE, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.error ?? '读取旁注失败')
          config = body.config ?? config
          return body.notes ?? {}
        }

        /** 写一条旁注。 */
        const saveNote = async (sessionId, patch) => {
          const response = await fetch(NOTES_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, patch }),
          })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.error ?? '保存失败')
          return body.note
        }

        /** 改工作工作区。 */
        const saveConfig = async (workRoot) => {
          const response = await fetch(CONFIG_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workRoot }),
          })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.error ?? '保存失败')
          config = body.config ?? config
        }

        const notify = (toast) => ui.set((state) => ({ ...state, toast }))

        /** 周报草稿。 */
        const weeklyDraft = (rows) => {
          const { start, end } = weekRange()
          const done = rows.filter((row) => row.status === 'done' && row.updatedAt >= start && row.updatedAt < end)
          const open = rows.filter((row) => row.status === 'open' && row.archived === false)
          const lines = []
          lines.push(`## 本周完成（${md(start)} ~ ${md(end - 1)}）`)
          if (done.length === 0) lines.push('- （无）')
          for (const row of done) {
            const ref = row.ref === null ? '' : `${row.ref} `
            lines.push(`- ${ref}${row.title}${row.outcome === '' ? '' : `：${row.outcome}`}`)
          }
          lines.push('')
          lines.push('## 进行中 / 未收尾')
          if (open.length === 0) lines.push('- （无）')
          for (const row of open) {
            const ref = row.ref === null ? '' : `${row.ref} `
            lines.push(`- ${ref}${row.title}${row.next === '' ? '' : ` → ${row.next}`}`)
          }
          return lines.join('\n')
        }

        /** 行内编辑：结论 / 下一步。 */
        function Row({ row, onSave, onOpen }) {
          const [outcome, setOutcome] = useState(row.outcome)
          const [next, setNext] = useState(row.next)
          useEffect(() => {
            setOutcome(row.outcome)
            setNext(row.next)
          }, [row.outcome, row.next])

          const commit = (field, value) => {
            const trimmed = value.trim()
            if (trimmed === (field === 'outcome' ? row.outcome : row.next)) return
            const patch = field === 'outcome'
              ? { outcome: trimmed, status: trimmed === '' ? 'open' : 'done' }
              : { next: trimmed }
            onSave(row.id, patch).catch((error) => notify(`保存失败：${error.message}`))
          }

          return h('div', { style: styles.row },
            h('div', null,
              h('div', { style: styles.rowTitle, onClick: () => onOpen(row.id), title: '打开会话' },
                row.title,
                row.ref === null ? null : h('span', { style: styles.ref }, row.ref),
                row.running ? h('span', { style: { ...styles.ref, background: 'rgba(120,255,170,0.14)', color: '#9df0be', borderColor: 'rgba(120,255,170,0.3)' } }, '运行中') : null,
              ),
              h('div', { style: styles.meta },
                h('span', null, row.project),
                h('span', null, row.archived ? `归档 · ${md(row.updatedAt)}` : `更新于 ${md(row.updatedAt)}`),
              ),
              h('input', {
                style: styles.input,
                placeholder: row.status === 'done' ? '结论：做了什么、结果如何' : '结论：这件事干完了吗？',
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
            h('div', { style: styles.side },
              h('span', { style: styles.badge }, row.status === 'done' ? '已收尾' : row.status === 'dropped' ? '已放弃' : '未收尾'),
              h('button', { style: styles.button, onClick: () => onOpen(row.id) }, '打开'),
            ),
          )
        }

        function Panel() {
          const state = useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot)
          const [rows, setRows] = useState([])
          const [loading, setLoading] = useState(false)
          const [error, setError] = useState(null)
          const [notes, setNotes] = useState({})

          const refresh = useCallback(async () => {
            setLoading(true)
            try {
              const loaded = await loadAll()
              setNotes(loaded)
              const next = buildRows(loaded)
              setRows(next)
              setError(null)
              ui.set((current) => ({
                ...current,
                counts: { open: next.filter((row) => row.status === 'open' && !row.archived).length, done: next.filter((row) => row.status === 'done').length },
              }))
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason))
            } finally {
              setLoading(false)
            }
          }, [])

          useEffect(() => {
            if (state.open) refresh()
          }, [state.open, refresh])

          const onSave = useCallback(async (sessionId, patch) => {
            const note = await saveNote(sessionId, patch)
            const merged = { ...notes, [sessionId]: note }
            setNotes(merged)
            const next = buildRows(merged)
            setRows(next)
            ui.set((current) => ({
              ...current,
              counts: { open: next.filter((row) => row.status === 'open' && !row.archived).length, done: next.filter((row) => row.status === 'done').length },
            }))
          }, [notes])

          const onOpen = useCallback((sessionId) => {
            ui.set((current) => ({ ...current, open: false }))
            uiWorkspace?.openSession(sessionId)
          }, [])

          if (!state.open) return null

          const { start, end } = weekRange()
          const openRows = rows.filter((row) => row.status === 'open' && !row.archived)
          const doneThisWeek = rows.filter((row) => row.status === 'done' && row.updatedAt >= start && row.updatedAt < end)
          const doneBefore = rows.filter((row) => row.status === 'done' && row.updatedAt < start)

          const section = (label, list, emptyText) => h('div', null,
            h('div', { style: styles.sectionTitle }, label, h('span', { style: styles.badge }, String(list.length))),
            list.length === 0
              ? h('div', { style: styles.empty }, emptyText)
              : list.map((row) => h(Row, { key: row.id, row, onSave, onOpen })),
          )

          return h('div', { style: styles.overlay, onClick: (event) => { if (event.target === event.currentTarget) ui.set((current) => ({ ...current, open: false })) } },
            h('div', { style: styles.panel },
              h('div', { style: styles.header },
                h('span', { style: styles.title }, '工作台'),
                h('span', { style: styles.week }, `${md(start)} ~ ${md(end - 1)} · ${rows.length} 个会话`),
                h('span', { style: styles.spacer }),
                h('button', { style: styles.button, onClick: refresh, disabled: loading }, loading ? '刷新中…' : '刷新'),
                h('button', { style: styles.button, onClick: () => { const text = weeklyDraft(rows); navigator.clipboard?.writeText(text); notify('周报草稿已复制') } }, '复制周报草稿'),
                h('button', { style: styles.button, onClick: () => ui.set((current) => ({ ...current, open: false })) }, '关闭'),
              ),
              h('div', { style: styles.body },
                error === null ? null : h('div', { style: { ...styles.empty, color: '#ff9a9a' } }, `读取失败：${error}`),
                section('进行中 / 未收尾', openRows, '没有未收尾的会话。'),
                section(`本周收尾（${md(start)} ~ ${md(end - 1)}）`, doneThisWeek, '本周还没有写结论的会话。'),
                doneBefore.length === 0 ? null : section('更早收尾', doneBefore.slice(0, 20), ''),
              ),
              h('div', { style: styles.footer },
                h('input', {
                  style: styles.pathInput,
                  defaultValue: config.workRoot,
                  key: config.workRoot,
                  onBlur: (event) => {
                    const value = event.target.value.trim()
                    if (value === '' || value === config.workRoot) return
                    saveConfig(value).then(() => refresh()).catch((reason) => notify(`保存失败：${reason.message}`))
                  },
                }),
                h('span', { style: { fontSize: 11, color: '#8590a2' } }, '只收这个目录下的会话'),
              ),
              state.toast === null ? null : h('div', { style: styles.toast }, state.toast),
            ),
          )
        }

        /** 输入框下方的胶囊入口。 */
        function Entry() {
          const state = useSyncExternalStore(ui.subscribe, ui.getSnapshot, ui.getSnapshot)
          const open = state.counts === null ? null : state.counts.open
          useEffect(() => {
            if (state.counts !== null) return
            loadAll()
              .then((notes) => {
                const next = buildRows(notes)
                ui.set((current) => ({
                  ...current,
                  counts: { open: next.filter((row) => row.status === 'open' && !row.archived).length, done: next.filter((row) => row.status === 'done').length },
                }))
              })
              .catch(() => {})
          }, [state.counts])
          return h('button', {
            style: styles.pill,
            onClick: () => ui.set((current) => ({ ...current, open: !current.open })),
            title: '打开工作台',
          },
          h('span', { style: { color: '#8fb3ff' } }, '▤'),
          '工作台',
          open === null || open === 0 ? null : h('span', { style: { ...styles.ref, background: 'rgba(255,150,120,0.16)', color: '#ffb3a0', borderColor: 'rgba(255,150,120,0.3)' } }, `${open} 未收尾`),
          )
        }

        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'workbench-entry',
          order: 60,
        }, Entry)), 'workbench: composer entry')

        ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'workbench-panel',
          order: 900,
        }, Panel)), 'workbench: panel overlay')

        // 生产环境忽略返回值；测试从这里拿纯逻辑（快照 → 行、行 → 周报）。
        return { buildRows, weeklyDraft, weekRange, refOf, projectOf }
      },
    }
  },
})
