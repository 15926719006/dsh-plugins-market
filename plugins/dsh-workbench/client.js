/**
 * 工作台（浏览器侧）
 *
 * 两个座位，和 `onerway-pmo` 同一套挂法：
 * - `sidebar.panellist`：左侧常驻入口（id 即面板 id）
 * - `main`：整页，key 与入口 id 相同，点入口就切到这一页
 *
 * 不接管任何官方 Slot，不 fork 官方 bundle：会话清单与归档状态全部来自官方
 * `sessions` / `workspaces` 快照，旁注走 Host 的 `/api/workbench/*` 路由。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-workbench',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** 排障：把加载与注册的异常打回 Host 写日志，页面控制台看不到时也能查。 */
    function report(label, message) {
      try {
        fetch('/api/workbench/log', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ label, message: message instanceof Error ? `${message.message}\n${message.stack ?? ''}` : String(message) }),
        })
      } catch {
        // 日志本身不能再抛。
      }
    }

    /** 左侧入口 id，同时也是 `main` 的 key。 */
    const PANEL_ID = 'workbench'

    const NOTES_ROUTE = '/api/workbench/notes'
    const CONFIG_ROUTE = '/api/workbench/config'

    /** 单号：标题里已有的 devops 编号直接认出来当标签。 */
    const REF_PATTERN = /\b(RO-\d{8}-\d{3}(?:-S\d+)?|T-\d{8}-\d{3}|P-\d{8}-\d{3}|BUG-\d{8}-\d{3}|ON3-\d+)\b/

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

    /** 从标题里捞单号。 */
    function refOf(title) {
      if (typeof title !== 'string') return null
      const hit = REF_PATTERN.exec(title)
      return hit === null ? null : hit[1]
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
        gap: 18,
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
        letterSpacing: '0.02em',
      },
      badge: {
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 999,
        background: C.layer2,
        color: C.label2,
      },
      row: {
        display: 'grid',
        gridTemplateColumns: '1fr 104px',
        gap: 14,
        padding: '12px 14px',
        border: `1px solid ${C.border1}`,
        borderRadius: 11,
        marginBottom: 8,
        background: C.layer1,
      },
      rowTitle: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 13.5,
        fontWeight: 550,
        cursor: 'pointer',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      ref: {
        flex: 'none',
        fontSize: 11,
        padding: '0 6px',
        borderRadius: 4,
        border: `1px solid ${C.border2}`,
        color: C.label2,
        font: '11px/16px ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      meta: { display: 'flex', gap: 10, marginTop: 4, fontSize: 11.5, color: C.label2 },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        marginTop: 8,
        background: C.base,
        border: `1px solid ${C.border1}`,
        borderRadius: 7,
        color: C.label1,
        font: 'inherit',
        padding: '6px 9px',
        outline: 'none',
      },
      side: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 },
      status: { fontSize: 11, color: C.label2 },
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

    /** 左侧入口的图标：跟着文字的 currentColor 走。 */
    function PanelIcon(props) {
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

    return {
      inject: ['slots'],
      apply(ctx) {
        report('apply-start', `slots=${ctx.slots === undefined ? 'missing' : 'ok'}`)
        // 服务在渲染时按需取：Web 页启动时这些服务可能还没就绪，
        // 放进模块级 inject 会让整个模块一直等待、静默不执行。
        const service = (name) => {
          try {
            return ctx.get(name)
          } catch {
            return undefined
          }
        }
        let config = { workRoot: '' }

        /** 会话快照 + 旁注 → 行。 */
        const buildRows = (notes, rootOverride) => {
          const sessions = service('sessions')
          const workspaces = service('workspaces')
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
            const status = typeof note.status === 'string' && note.status !== ''
              ? note.status
              : outcome !== '' ? 'done' : 'open'
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
            })
          }
          rows.sort((a, b) => b.updatedAt - a.updatedAt)
          return rows
        }

        const loadAll = async () => {
          const response = await fetch(NOTES_ROUTE, { headers: { accept: 'application/json' } })
          const body = await response.json()
          if (body?.ok !== true) throw new Error(body?.error ?? '读取旁注失败')
          config = body.config ?? config
          return body.notes ?? {}
        }

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

        /** 周报草稿：本周完成的写结论，未收尾的写下一步。 */
        const weeklyDraft = (rows) => {
          const { start, end } = weekRange()
          const done = rows.filter((row) => row.status === 'done' && row.updatedAt >= start && row.updatedAt < end)
          const open = rows.filter((row) => row.status === 'open' && row.archived === false)
          const lines = [`## 本周完成（${md(start)} ~ ${md(end - 1)}）`]
          if (done.length === 0) lines.push('- （无）')
          for (const row of done) {
            lines.push(`- ${row.ref === null ? '' : `${row.ref} `}${row.title}${row.outcome === '' ? '' : `：${row.outcome}`}`)
          }
          lines.push('', '## 进行中 / 未收尾')
          if (open.length === 0) lines.push('- （无）')
          for (const row of open) {
            lines.push(`- ${row.ref === null ? '' : `${row.ref} `}${row.title}${row.next === '' ? '' : ` → ${row.next}`}`)
          }
          return lines.join('\n')
        }

        /** 一行会话：就地写结论与下一步。 */
        function Row({ row, onSave, onOpen }) {
          const [outcome, setOutcome] = useState(row.outcome)
          const [next, setNext] = useState(row.next)
          useEffect(() => {
            setOutcome(row.outcome)
            setNext(row.next)
          }, [row.outcome, row.next])

          const commit = (field, value) => {
            const trimmed = value.trim()
            const previous = field === 'outcome' ? row.outcome : row.next
            if (trimmed === previous) return
            const patch = field === 'outcome'
              ? { outcome: trimmed, status: trimmed === '' ? 'open' : 'done' }
              : { next: trimmed }
            onSave(row.id, patch)
          }

          const statusText = row.status === 'dropped' ? '已放弃' : row.status === 'done' ? '已收尾' : '未收尾'
          const statusColor = row.status === 'done' ? C.success : row.status === 'dropped' ? C.idle : C.warn

          return h('div', { style: styles.row },
            h('div', { style: { minWidth: 0 } },
              h('div', { style: styles.rowTitle, onClick: () => onOpen(row.id), title: row.title },
                row.title,
                row.ref === null ? null : h('span', { style: styles.ref }, row.ref),
              ),
              h('div', { style: styles.meta },
                h('span', null, row.project),
                h('span', null, row.archived ? `已归档 · ${md(row.updatedAt)}` : `更新于 ${md(row.updatedAt)}`),
                row.running ? h('span', { style: { color: C.success } }, '运行中') : null,
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
              h('span', { style: { ...styles.status, color: statusColor } }, statusText),
              h('button', { style: styles.button, onClick: () => onOpen(row.id) }, '打开'),
            ),
          )
        }

        /** 整页。 */
        function WorkbenchPage() {
          const [rows, setRows] = useState([])
          const [loading, setLoading] = useState(true)
          const [error, setError] = useState(null)
          const [toast, setToast] = useState(null)
          const [showAllOpen, setShowAllOpen] = useState(false)

          const applyNotes = useCallback((notes) => {
            setRows(buildRows(notes))
          }, [])

          const refresh = useCallback(async () => {
            setLoading(true)
            try {
              const notes = await loadAll()
              applyNotes(notes)
              setError(null)
            } catch (reason) {
              setError(reason instanceof Error ? reason.message : String(reason))
            } finally {
              setLoading(false)
            }
          }, [applyNotes])

          useEffect(() => {
            refresh()
          }, [refresh])

          useEffect(() => {
            if (toast === null) return undefined
            const timer = setTimeout(() => setToast(null), 1800)
            return () => clearTimeout(timer)
          }, [toast])

          const onSave = useCallback((sessionId, patch) => {
            saveNote(sessionId, patch)
              .then(() => loadAll())
              .then((notes) => applyNotes(notes))
              .catch((reason) => setToast(`保存失败：${reason.message}`))
          }, [applyNotes])

          const onOpen = useCallback((sessionId) => {
            service('uiWorkspace')?.openSession(sessionId)
          }, [])

          const { start, end } = weekRange()
          const openRows = rows.filter((row) => row.status === 'open' && !row.archived)
          const doneThisWeek = rows.filter((row) => row.status === 'done' && row.updatedAt >= start && row.updatedAt < end)
          const doneBefore = rows.filter((row) => row.status === 'done' && row.updatedAt < start)

          const visibleOpen = showAllOpen ? openRows : openRows.slice(0, 30)
          const hiddenOpen = openRows.length - visibleOpen.length

          const section = (label, list, emptyText, extra) => h('div', { key: label },
            h('div', { style: styles.sectionTitle }, label, h('span', { style: styles.badge }, String(list.length))),
            list.length === 0
              ? h('div', { style: styles.empty }, emptyText)
              : list.map((row) => h(Row, { key: row.id, row, onSave, onOpen })),
            extra ?? null,
          )

          return h('div', { style: styles.page },
            h('div', { style: styles.shell },
              h('div', { style: styles.header },
                h('span', { style: styles.h1 }, '工作台'),
                h('span', { style: styles.week }, `${md(start)} ~ ${md(end - 1)} · 本周一股到下周一股`),
                h('span', { style: styles.spacer }),
                h('div', { style: styles.actions },
                  h('button', { style: styles.button, onClick: refresh, disabled: loading }, loading ? '刷新中…' : '刷新'),
                  h('button', {
                    style: styles.primary,
                    onClick: () => {
                      const text = weeklyDraft(rows)
                      navigator.clipboard?.writeText(text)
                      setToast('周报草稿已复制')
                    },
                  }, '复制周报草稿'),
                ),
              ),
              h('div', { style: styles.summary },
                h('div', { style: styles.metric },
                  h('span', { style: { ...styles.metricValue, color: openRows.length === 0 ? C.label1 : C.warn } }, String(openRows.length)),
                  h('span', { style: styles.metricLabel }, '未收尾'),
                ),
                h('div', { style: styles.metric },
                  h('span', { style: { ...styles.metricValue, color: C.success } }, String(doneThisWeek.length)),
                  h('span', { style: styles.metricLabel }, '本周收尾'),
                ),
                h('div', { style: styles.metric },
                  h('span', { style: styles.metricValue }, String(rows.length)),
                  h('span', { style: styles.metricLabel }, '工作目录内会话'),
                ),
                h('div', { style: { ...styles.metric, marginLeft: 'auto', alignItems: 'flex-end' } },
                  h('span', { style: { ...styles.metricLabel, maxWidth: 320, textAlign: 'right' } }, config.workRoot),
                  h('span', { style: styles.metricLabel }, '只统计这个目录'),
                ),
              ),
              error === null ? null : h('div', { style: { ...styles.empty, color: C.error } }, `读取失败：${error}`),
              section('进行中 / 未收尾', visibleOpen, '没有未收尾的会话。',
                hiddenOpen <= 0 ? null : h('button', {
                  style: { ...styles.button, marginTop: 2 },
                  onClick: () => setShowAllOpen(true),
                }, `还有 ${hiddenOpen} 条更早的未收尾，展开`),
              ),
              section(`本周收尾（${md(start)} ~ ${md(end - 1)}）`, doneThisWeek, '本周还没有写结论的会话。'),
              doneBefore.length === 0 ? null : section('更早收尾', doneBefore.slice(0, 20), ''),
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
                h('span', { style: { flex: 'none' } }, '回车外点即存'),
              ),
              toast === null ? null : h('div', { style: styles.toast }, toast),
            ),
          )
        }

        /**
         * 渲染兜底：槽位里的组件一旦抛错，那一格会被清空且不报错到页面。
         * 包一层，把渲染期异常也写进同一份日志。
         */
        const safe = (label, Component) => function SafeSeat(props) {
          try {
            report(`${label}:render`, 'ok')
            return Component(props)
          } catch (error) {
            report(`${label}:render`, error)
            return null
          }
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
          report(`${label}:inject`, 'fired')
          try {
            const dispose = ctx.slots.register(spec, Component)
            report(`${label}:register`, 'ok')
            return dispose
          } catch (error) {
            report(`${label}:register`, error)
            return () => {}
          }
        }))

        seat('sidebar.panellist', 'panellist', {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 6,
          label: '工作台',
        }, PanelIcon)

        seat('main', 'main', { name: 'main', key: PANEL_ID, id: PANEL_ID }, WorkbenchPage)

        /** 探针：直接打印每个入口的 options，判断 key/id 到底登记成什么。 */
        const dumpEntries = (when) => {
          try {
            const shape = (slot) => (ctx.slots.entries(slot) ?? []).map((entry) => entry?.options ?? {})
            report(`entries:${when}`, JSON.stringify({
              panellist: shape('sidebar.panellist'),
              main: shape('main'),
            }))
          } catch (error) {
            report(`entries:${when}`, error)
          }
        }
        try {
          setTimeout(() => dumpEntries('late'), 1500)
        } catch (error) {
          report('entries:timer', error)
        }
        dumpEntries('now')

        // 探针：直接选中工作台，验证「面板 id 已注册 + 整页能渲染」。
        try {
          setTimeout(() => {
            try {
              service('layout').selectPanel(PANEL_ID)
              report('selectPanel', 'ok')
            } catch (error) {
              report('selectPanel', error)
            }
          }, 2000)
        } catch (error) {
          report('selectPanel:timer', error)
        }

        // 生产环境忽略返回值；测试从这里拿纯逻辑（快照 → 行、行 → 周报）。
        return { buildRows, weeklyDraft, weekRange, refOf, projectOf }
      },
    }
  },
})
