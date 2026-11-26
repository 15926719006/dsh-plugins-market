/**
 * 会议纪要（浏览器侧）
 *
 * 两个座位，和 `workbench` / `fast-read` 同一套挂法：
 * - `sidebar.panellist`：左侧常驻入口（id 即面板 id）
 * - `main`：整页，key 与入口 id 相同，点入口就切到这一页
 *
 * 这一侧只做呈现：录音、转写、生成纪要都在 Host（`/api/meeting-notes/*`）。
 * 页面只有三种形态：录制条（常驻）+ 历史列表 / 详情。
 * 状态轮询：录制中 / 准备中 / 收尾中每 2 秒拉一次 `/state`；详情里
 * transcribing|generating 每 2 秒拉一次 `/record`。定时器、请求（AbortController）、
 * 键盘监听、播放中的 audio 都在 useEffect 的 cleanup 里关掉；页面切走即停。
 *
 * 不 require 任何 @deepseek-ai/dsh-client-* 模块，也不引第三方库；
 * 只用 `--dsw-alias-*` 主题变量，因此亮色/暗色都跟着 DSH 走。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-meeting-notes',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** 左侧入口 id，同时也是 `main` 的 key。 */
    const PANEL_ID = 'meeting-notes'

    /** Host 路由前缀。 */
    const API = '/api/meeting-notes'

    /** 历史列表里一次显示多少条（再多也没人翻，Host 侧本来就很少）。 */
    const LIST_LIMIT = 500

    /** 实时原文最多显示多少条，多了自动滚到底只留最近的。 */
    const LIVE_LIMIT = 10

    /** 排障：把异常打回 Host 写日志（页面控制台看不到时也能查）。 */
    function report(label, message) {
      try {
        fetch(`${API}/log`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            label,
            message: message instanceof Error ? `${message.message}\n${message.stack ?? ''}` : String(message),
          }),
        }).catch(() => {
          // 日志本身不能再抛。
        })
      } catch {
        // 日志本身不能再抛。
      }
    }

    /** 统一的报错文案。 */
    function messageOf(reason) {
      return reason instanceof Error ? reason.message : String(reason)
    }

    /** POST 一份 JSON。 */
    function jsonInit(body) {
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }
    }

    /**
     * 发一个请求并把 JSON 解开。
     *
     * Host 失败时回 `{ error, code }`：`code === 'setup'` 表示「还没准备好」，
     * 前端据此把引导卡片滚到视野里。同源请求默认带 cookie，这里不加任何 CORS 头。
     */
    async function request(path, init) {
      const response = await fetch(`${API}${path}`, init)
      const body = await response.json().catch(() => null)
      if (!response.ok) {
        const error = new Error(
          body !== null && typeof body.error === 'string' && body.error !== ''
            ? body.error
            : `请求失败（HTTP ${response.status}）`,
        )
        if (body !== null && typeof body.code === 'string') error.code = body.code
        throw error
      }
      if (body === null) throw new Error('Host 返回了无法解析的内容')
      return body
    }

    /** 带 signal 的 GET：轮询 / 详情装载用，切走时能真的把请求掐掉。 */
    function getJson(path, signal) {
      return request(path, { headers: { accept: 'application/json' }, signal })
    }

    /** 接口清单，和 Host 的 `routes` 一一对应。 */
    const api = {
      state: (signal) => getJson('/state', signal),
      start: (title) => request('/start', jsonInit(title === undefined ? {} : { title })),
      stop: () => request('/stop', jsonInit({})),
      cancel: () => request('/cancel', jsonInit({})),
      list: (signal) => getJson('/list', signal),
      record: (id, source, signal) => {
        const query = `id=${encodeURIComponent(id)}`
        const extra = source === undefined || source === null ? '' : `&source=${encodeURIComponent(source)}`
        return getJson(`/record?${query}${extra}`, signal)
      },
      remove: (id) => request(`/record?id=${encodeURIComponent(id)}`, { method: 'DELETE', headers: { accept: 'application/json' } }),
      rename: (id, title) => request('/rename', jsonInit({ id, title })),
      importText: (id, text) => request('/import', jsonInit({ id, text })),
      regenerate: (id) => request('/regenerate', jsonInit({ id })),
      recover: (id) => request('/recover', jsonInit({ id })),
      setup: (action) => request('/setup', jsonInit({ action })),
    }

    /** 被 abort 的请求不算错误，别往 Host 日志里灌。 */
    function ignoreAbort(reason) {
      return reason !== null && reason !== undefined && reason.name === 'AbortError'
    }

    // ---------------------------------------------------------------- 格式化

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    /** 块级时间戳：`mm:ss`。 */
    function clockOf(ms) {
      const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
      return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
    }

    /** 录制中的钟：`00:12:34`。 */
    function hmsOf(ms) {
      const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
      return `${pad2(Math.floor(total / 3600))}:${pad2(Math.floor(total / 60) % 60)}:${pad2(total % 60)}`
    }

    /** 时长的人话版：`32 分钟`。 */
    function durationText(ms) {
      const value = Number(ms) || 0
      if (value < 60000) return '不到 1 分钟'
      const minutes = Math.round(value / 60000)
      if (minutes < 60) return `${minutes} 分钟`
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
    }

    function parseTime(iso) {
      if (typeof iso !== 'string' || iso === '') return null
      const value = Date.parse(iso)
      return Number.isNaN(value) ? null : value
    }

    /** 列表里的 `11-26 10:42`。 */
    function dateTimeText(iso) {
      const value = parseTime(iso)
      if (value === null) return '—'
      const date = new Date(value)
      return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    /** 详情里的 `2026-11-26 10:42`。 */
    function fullDateText(iso) {
      const value = parseTime(iso)
      if (value === null) return '—'
      const date = new Date(value)
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    /** 下载文件名：把 `/` 这类非法字符换成 `-`。 */
    function safeFileName(title) {
      const base = typeof title === 'string' && title.trim() !== '' ? title.trim() : '会议纪要'
      const cleaned = base
        .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
        .replace(/\s+/g, ' ')
        .trim()
      return (cleaned === '' ? '会议纪要' : cleaned).slice(0, 80)
    }

    // ---------------------------------------------------------------- 主题

    /** 主题 token，跟着 DSH 的亮/暗色走（名字与 workbench 保持一致）。 */
    const C = {
      base: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      layer3: 'var(--dsw-alias-bg-layer-3)',
      border1: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      label1: 'var(--dsw-alias-label-primary)',
      label2: 'var(--dsw-alias-label-secondary)',
      label3: 'var(--dsw-alias-label-tertiary)',
      brand: 'var(--dsw-alias-brand-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    /** 状态徽标：录制中 / 转写中 / 生成纪要 / 已完成 / 失败 / 中断。 */
    const STATUS_MAP = {
      preparing: { text: '准备录制', color: C.warn },
      recording: { text: '录制中', color: C.error },
      stopping: { text: '收尾中', color: C.brand },
      transcribing: { text: '转写中', color: C.brand },
      generating: { text: '生成纪要', color: C.brand },
      ready: { text: '已完成', color: C.success },
      failed: { text: '失败', color: C.error },
      interrupted: { text: '中断', color: C.warn },
    }

    function statusOf(status) {
      return STATUS_MAP[status] ?? { text: '未知', color: C.label2 }
    }

    /** 悬停、呼吸点这类伪类/动画只能进 CSS，其余一律走内联样式。 */
    const CSS = `
.mn-row{display:grid;grid-template-columns:68px minmax(120px,1.4fr) 78px 76px minmax(110px,1.2fr);align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.18))}
.mn-row:first-child{border-top:0}
.mn-row:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}
.mn-row:focus-visible{outline:1px solid var(--dsw-alias-brand-primary,#2f6fd0);outline-offset:-1px}
.mn-tr{display:flex;align-items:baseline;gap:9px;padding:4px 8px;border-radius:6px;cursor:pointer}
.mn-tr:hover{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.10))}
.mn-tr.active{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary,#2f6fd0)}
.mn-tr:focus-visible{outline:1px solid var(--dsw-alias-brand-primary,#2f6fd0);outline-offset:-1px}
.mn-ghost:hover:not([disabled]){background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.12))}
.mn-solid:hover:not([disabled]){filter:brightness(1.06)}
.mn-ghost[disabled],.mn-solid[disabled]{opacity:.5;cursor:default}
.mn-rec-dot{animation:mn-pulse 1.5s ease-in-out infinite}
@keyframes mn-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.78)}}
@media (prefers-reduced-motion:reduce){.mn-rec-dot{animation:none}}
.mn-md a{color:var(--dsw-alias-brand-primary,#2f6fd0);text-decoration:none}
.mn-md a:hover{text-decoration:underline}
`

    const BAR_BASE = {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '14px 16px',
      border: `1px solid ${C.border1}`,
      borderRadius: 10,
      background: C.layer1,
      flexWrap: 'wrap',
    }

    const styles = {
      page: {
        height: '100%',
        overflowY: 'auto',
        background: C.base,
        color: C.label1,
        padding: '24px 32px',
        boxSizing: 'border-box',
        font: '13.5px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif',
      },
      shell: { maxWidth: 1180, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 },

      // 录制条
      bar: BAR_BASE,
      barRecording: { ...BAR_BASE, borderColor: C.error },
      barMain: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
      barTitle: { fontSize: 15, fontWeight: 650, letterSpacing: '-0.01em' },
      barSub: { fontSize: 12, color: C.label2 },
      barDivider: { color: C.label3, flex: 'none' },
      recDot: { width: 9, height: 9, borderRadius: 5, background: C.error, flex: 'none' },
      recLabel: { fontSize: 13, color: C.error, fontWeight: 600, flex: 'none' },
      recClock: { font: '13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace', fontVariantNumeric: 'tabular-nums', flex: 'none' },
      recTitle: {
        minWidth: 0,
        maxWidth: 420,
        fontSize: 13.5,
        fontWeight: 550,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        cursor: 'text',
        padding: '1px 4px',
        borderRadius: 5,
      },
      recTitleInput: {
        minWidth: 160,
        flex: '1 1 200px',
        background: C.base,
        border: `1px solid ${C.border2}`,
        borderRadius: 6,
        color: C.label1,
        font: 'inherit',
        padding: '3px 7px',
        outline: 'none',
      },

      // 按钮
      primary: {
        appearance: 'none',
        border: `1px solid ${C.brand}`,
        background: C.brand,
        color: '#fff',
        borderRadius: 8,
        padding: '7px 15px',
        fontSize: 13,
        fontWeight: 550,
        cursor: 'pointer',
        flex: 'none',
      },
      dangerSolid: {
        appearance: 'none',
        border: `1px solid ${C.error}`,
        background: C.error,
        color: '#fff',
        borderRadius: 8,
        padding: '7px 14px',
        fontSize: 13,
        fontWeight: 550,
        cursor: 'pointer',
        flex: 'none',
      },
      button: {
        appearance: 'none',
        border: `1px solid ${C.border2}`,
        background: 'transparent',
        color: C.label1,
        borderRadius: 8,
        padding: '5px 11px',
        fontSize: 12.5,
        cursor: 'pointer',
        flex: 'none',
      },
      dangerGhost: {
        appearance: 'none',
        border: `1px solid ${C.error}`,
        background: 'transparent',
        color: C.error,
        borderRadius: 8,
        padding: '5px 11px',
        fontSize: 12.5,
        cursor: 'pointer',
        flex: 'none',
      },
      dangerSolidSmall: {
        appearance: 'none',
        border: `1px solid ${C.error}`,
        background: C.error,
        color: '#fff',
        borderRadius: 8,
        padding: '5px 11px',
        fontSize: 12.5,
        cursor: 'pointer',
        flex: 'none',
      },

      // 准备引导卡片
      setupCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        border: `1px solid ${C.border2}`,
        borderRadius: 10,
        background: C.layer1,
      },
      setupHead: { display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' },
      setupTitleBig: { fontSize: 14, fontWeight: 600 },
      setupRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 12px',
        border: `1px solid ${C.border1}`,
        borderRadius: 8,
        background: C.layer2,
        flexWrap: 'wrap',
      },
      setupText: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 220, flex: 1 },
      setupTitle: { fontSize: 13, fontWeight: 550 },
      setupHint: { fontSize: 12, color: C.label2 },
      setupNote: { fontSize: 11.5, color: C.label3 },
      setupLog: {
        margin: 0,
        maxHeight: 96,
        overflow: 'auto',
        background: C.base,
        border: `1px solid ${C.border1}`,
        borderRadius: 7,
        padding: '7px 9px',
        font: '11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: C.label2,
        whiteSpace: 'pre-wrap',
      },
      progressTrack: {
        height: 6,
        borderRadius: 3,
        background: C.layer1,
        overflow: 'hidden',
        width: '100%',
        maxWidth: 320,
        flex: 'none',
      },
      progressFill: { height: '100%', background: C.brand, borderRadius: 3, transition: 'width .3s ease' },

      // 实时原文
      live: {
        border: `1px solid ${C.border1}`,
        borderRadius: 10,
        background: C.layer1,
        padding: '10px 14px 12px',
      },
      liveHead: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
      liveTitle: { fontSize: 12, color: C.label2 },
      liveHint: { fontSize: 11.5, color: C.label3 },
      liveBody: { maxHeight: 208, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 },
      liveEmpty: { fontSize: 12.5, color: C.label2, padding: '10px 2px' },
      liveRow: { display: 'flex', alignItems: 'baseline', gap: 8, padding: '2px 0' },
      liveTime: {
        flex: 'none',
        fontSize: 11.5,
        color: C.label3,
        fontVariantNumeric: 'tabular-nums',
        font: '11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      liveText: { minWidth: 0, fontSize: 13 },
      speakerTag: {
        flex: 'none',
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 999,
        background: C.layer2,
        fontWeight: 550,
      },

      // 列表
      section: { display: 'flex', flexDirection: 'column', gap: 10 },
      sectionHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      searchBox: {
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        width: 320,
        maxWidth: '100%',
        padding: '5px 9px',
        border: `1px solid ${C.border1}`,
        borderRadius: 8,
        background: C.layer1,
        color: C.label2,
      },
      searchInput: {
        flex: 1,
        minWidth: 0,
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: C.label1,
        font: 'inherit',
        fontSize: 12.5,
        padding: 0,
        outline: 'none',
      },
      clearButton: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: C.label2,
        fontSize: 14,
        lineHeight: '16px',
        cursor: 'pointer',
        padding: '0 2px',
        flex: 'none',
      },
      muted: { fontSize: 12, color: C.label2 },
      list: { border: `1px solid ${C.border1}`, borderRadius: 10, background: C.layer1, overflow: 'hidden' },
      rowDate: {
        fontSize: 12,
        color: C.label2,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      },
      rowTitle: {
        minWidth: 0,
        fontSize: 13.5,
        fontWeight: 550,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      rowDuration: {
        fontSize: 12,
        color: C.label2,
        textAlign: 'right',
        whiteSpace: 'nowrap',
      },
      rowSummary: {
        minWidth: 0,
        fontSize: 12.5,
        color: C.label2,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      badge: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        lineHeight: '17px',
        padding: '0 7px',
        borderRadius: 999,
        border: `1px solid ${C.border2}`,
        background: C.layer2,
        whiteSpace: 'nowrap',
        justifySelf: 'start',
      },
      emptyBox: {
        border: `1px dashed ${C.border2}`,
        borderRadius: 10,
        padding: '28px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        alignItems: 'center',
        textAlign: 'center',
      },
      emptyTitle: { fontSize: 13.5, fontWeight: 550 },
      emptyHint: { fontSize: 12, color: C.label2 },
      empty: { fontSize: 12.5, color: C.label2, padding: '10px 2px' },
      footer: { fontSize: 11.5, color: C.label3, paddingTop: 2 },

      // 错误提示
      errorBox: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        border: `1px solid ${C.error}`,
        borderRadius: 8,
        fontSize: 12.5,
        color: C.error,
      },

      // 详情
      detail: { display: 'flex', flexDirection: 'column', gap: 12 },
      detailHead: { display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' },
      backButton: {
        appearance: 'none',
        border: `1px solid ${C.border2}`,
        background: 'transparent',
        color: C.label2,
        borderRadius: 8,
        padding: '4px 9px',
        fontSize: 12.5,
        cursor: 'pointer',
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      },
      detailTitleBox: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 220, flex: '1 1 260px' },
      detailTitle: {
        fontSize: 17,
        fontWeight: 650,
        letterSpacing: '-0.01em',
        cursor: 'text',
        borderRadius: 6,
        padding: '0 3px',
        marginLeft: -3,
      },
      titleInput: {
        width: '100%',
        maxWidth: 480,
        background: C.base,
        border: `1px solid ${C.border2}`,
        borderRadius: 7,
        color: C.label1,
        fontFamily: 'inherit',
        fontSize: 17,
        lineHeight: 1.4,
        fontWeight: 650,
        padding: '2px 7px',
        outline: 'none',
      },
      detailMeta: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        flexWrap: 'wrap',
        fontSize: 12,
        color: C.label2,
      },
      sourceChip: {
        fontSize: 11,
        lineHeight: '17px',
        padding: '0 7px',
        borderRadius: 999,
        border: `1px solid ${C.border2}`,
        background: C.layer2,
        color: C.label2,
      },
      detailActions: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' },
      notice: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        border: `1px solid ${C.border2}`,
        borderRadius: 8,
        background: C.layer2,
        fontSize: 12.5,
        color: C.label1,
        flexWrap: 'wrap',
      },

      // 标签页
      tabs: { display: 'flex', gap: 2, borderBottom: `1px solid ${C.border1}`, paddingBottom: 0 },
      tab: {
        appearance: 'none',
        border: 'none',
        borderBottom: '2px solid transparent',
        background: 'transparent',
        color: C.label2,
        font: 'inherit',
        fontSize: 13,
        padding: '6px 11px 8px',
        cursor: 'pointer',
      },
      tabActive: {
        appearance: 'none',
        border: 'none',
        borderBottom: `2px solid ${C.brand}`,
        background: 'transparent',
        color: C.label1,
        font: 'inherit',
        fontSize: 13,
        fontWeight: 550,
        padding: '6px 11px 8px',
        cursor: 'pointer',
      },
      panel: {
        border: `1px solid ${C.border1}`,
        borderRadius: 10,
        background: C.layer1,
        padding: '12px 16px 16px',
      },
      panelHead: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' },
      panelTitle: { fontSize: 12.5, fontWeight: 550, color: C.label1 },
      switchWrap: {
        display: 'inline-flex',
        border: `1px solid ${C.border2}`,
        borderRadius: 7,
        overflow: 'hidden',
      },
      switchOn: {
        appearance: 'none',
        border: 'none',
        background: C.layer2,
        color: C.label1,
        font: 'inherit',
        fontSize: 11.5,
        padding: '3px 9px',
        cursor: 'pointer',
      },
      switchOff: {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: C.label2,
        font: 'inherit',
        fontSize: 11.5,
        padding: '3px 9px',
        cursor: 'pointer',
      },
      transcriptList: { display: 'flex', flexDirection: 'column', gap: 1 },
      autoNote: {
        margin: '0 0 8px',
        padding: '6px 10px',
        border: `1px solid ${C.border1}`,
        borderRadius: 7,
        background: C.layer2,
        fontSize: 12,
        color: C.label2,
      },
      trTime: {
        flex: 'none',
        width: 46,
        fontSize: 11.5,
        color: C.label3,
        fontVariantNumeric: 'tabular-nums',
        font: '11.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      trTag: {
        flex: 'none',
        fontSize: 11,
        lineHeight: '16px',
        padding: '0 6px',
        borderRadius: 999,
        background: C.layer2,
        fontWeight: 550,
      },
      trText: { flex: 1, minWidth: 0, fontSize: 13.5, lineHeight: 1.65 },

      // 录音
      audioBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '8px 12px',
        border: `1px solid ${C.border1}`,
        borderRadius: 10,
        background: C.layer1,
        flexWrap: 'wrap',
      },
      audioPanel: {
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '14px 16px',
        border: `1px solid ${C.border1}`,
        borderRadius: 10,
        background: C.layer1,
      },
      audio: { width: '100%', display: 'block', height: 36, flex: '1 1 280px' },
      audioHint: { fontSize: 11.5, color: C.label3 },

      // 纪要（markdown）
      minutesWrap: {
        border: `1px solid ${C.border1}`,
        borderRadius: 10,
        background: C.layer1,
        padding: '14px 20px 18px',
      },
      md: { fontSize: 13.5, lineHeight: 1.7, color: C.label1 },
      mdP: { margin: '8px 0' },
      mdList: { margin: '8px 0', paddingLeft: 20 },
      mdLi: { margin: '3px 0' },
      mdQuote: {
        margin: '10px 0',
        padding: '6px 12px',
        borderLeft: `2px solid ${C.brand}`,
        background: C.layer2,
        color: C.label2,
        borderRadius: '0 6px 6px 0',
      },
      mdHr: { border: 'none', borderTop: `1px solid ${C.border1}`, margin: '16px 0' },
      mdCode: {
        padding: '1px 4px',
        borderRadius: 4,
        background: C.layer2,
        font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      },
      mdLink: { color: C.brand, textDecoration: 'none' },
      mdHeading: {
        1: { fontSize: 18, fontWeight: 650, margin: '4px 0 10px', lineHeight: 1.4 },
        2: { fontSize: 15.5, fontWeight: 620, margin: '18px 0 8px', lineHeight: 1.4 },
        3: { fontSize: 14, fontWeight: 600, margin: '14px 0 6px', lineHeight: 1.4 },
        4: { fontSize: 13.5, fontWeight: 600, margin: '12px 0 6px', lineHeight: 1.4, color: C.label2 },
      },

      // 导入对话框
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 940,
        background: 'rgba(0, 0, 0, .38)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      },
      dialog: {
        width: 'min(720px, 100%)',
        maxHeight: '86vh',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '18px 20px 16px',
        border: `1px solid ${C.border2}`,
        borderRadius: 12,
        background: C.layer1,
        boxShadow: '0 12px 40px rgba(0, 0, 0, .24)',
      },
      dialogTitle: { fontSize: 14.5, fontWeight: 600 },
      dialogHint: { fontSize: 12.5, color: C.label2, lineHeight: 1.6 },
      textarea: {
        flex: 1,
        minHeight: 220,
        resize: 'vertical',
        background: C.base,
        border: `1px solid ${C.border1}`,
        borderRadius: 8,
        color: C.label1,
        font: '12.5px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
        padding: '9px 11px',
        outline: 'none',
        boxSizing: 'border-box',
      },
      dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: 8 },

      // 其它
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
        fontSize: 12.5,
        maxWidth: 'min(560px, 84vw)',
      },
      loadingBox: { padding: '26px 4px', fontSize: 12.5, color: C.label2 },
    }

    // ---------------------------------------------------------------- 图标

    const STROKE = { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }

    /** 页面里用的小图标，全部 currentColor，不引图标库。 */
    function Icon({ name, size }) {
      const px = typeof size === 'number' ? size : 15
      const box = { viewBox: '0 0 24 24', width: px, height: px, fill: 'none', 'aria-hidden': 'true', style: { display: 'block', flex: 'none' } }
      if (name === 'mic') {
        return h('svg', box,
          h('rect', { key: 'a', x: 9, y: 3, width: 6, height: 11, rx: 3, ...STROKE }),
          h('path', { key: 'b', d: 'M6.2 11a5.8 5.8 0 0 0 11.6 0M12 17v4M9 21h6', ...STROKE }),
        )
      }
      if (name === 'search') {
        return h('svg', box,
          h('circle', { key: 'a', cx: 10.5, cy: 10.5, r: 6.5, ...STROKE }),
          h('path', { key: 'b', d: 'M15.4 15.4 20 20', ...STROKE }),
        )
      }
      if (name === 'back') {
        return h('svg', box, h('path', { key: 'a', d: 'M14.5 5.5 8 12l6.5 6.5', ...STROKE }))
      }
      if (name === 'download') {
        return h('svg', box,
          h('path', { key: 'a', d: 'M12 4v10M8 11l4 4 4-4', ...STROKE }),
          h('path', { key: 'b', d: 'M5 19.5h14', ...STROKE }),
        )
      }
      if (name === 'upload') {
        return h('svg', box,
          h('path', { key: 'a', d: 'M12 16V6M8 10l4-4 4 4', ...STROKE }),
          h('path', { key: 'b', d: 'M5 19.5h14', ...STROKE }),
        )
      }
      if (name === 'refresh') {
        return h('svg', box,
          h('path', { key: 'a', d: 'M19.4 12a7.4 7.4 0 0 1-12.7 5.2M4.6 12a7.4 7.4 0 0 1 12.7-5.2', ...STROKE }),
          h('path', { key: 'b', d: 'M17.2 3.4v3.6h-3.6M6.8 20.6V17h3.6', ...STROKE }),
        )
      }
      if (name === 'trash') {
        return h('svg', box,
          h('path', { key: 'a', d: 'M5 7h14M9.5 7V4.8h5V7M7 7l.8 12h8.4L17 7', ...STROKE }),
          h('path', { key: 'b', d: 'M10.5 11v5M13.5 11v5', ...STROKE }),
        )
      }
      if (name === 'play') {
        return h('svg', box, h('path', { key: 'a', d: 'M9 6.5 17.5 12 9 17.5z', ...STROKE }))
      }
      return h('svg', box, h('circle', { key: 'a', cx: 12, cy: 12, r: 8, ...STROKE }))
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
      h('rect', { key: 'mic', x: 9, y: 3, width: 6, height: 11, rx: 3, ...STROKE, strokeWidth: 1.6 }),
      h('path', { key: 'arc', d: 'M6.2 11a5.8 5.8 0 0 0 11.6 0M12 17v4', ...STROKE, strokeWidth: 1.6 }),
      h('path', { key: 'wave', d: 'M20.4 8.6c.5 1.1.8 2.3.8 3.4M3.6 8.6c-.5 1.1-.8 2.3-.8 3.4', ...STROKE, strokeWidth: 1.3, opacity: 0.72 }),
      ))
    }

    function StatusDot({ color }) {
      return h('span', { style: { width: 6, height: 6, borderRadius: 3, background: color, display: 'inline-block', flex: 'none' } })
    }

    function StatusBadge({ status }) {
      const info = statusOf(status)
      return h('span', { style: styles.badge }, h(StatusDot, { color: info.color }), info.text)
    }

    // ---------------------------------------------------------------- 就地改名

    /**
     * 点一下就能改名的标题：回车保存、Esc 取消、失焦保存。
     * 用 doneRef 挡住「回车之后又触发一次 blur」造成的重复提交。
     */
    function EditableTitle({ value, onCommit, textStyle, inputStyle, fallback }) {
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(value)
      const doneRef = useRef(false)

      // 进入编辑态时从最新值开抄（不用 effect 同步：effect 在这里只会多一轮渲染）。
      const start = () => {
        doneRef.current = false
        setDraft(value)
        setEditing(true)
      }

      const commit = () => {
        if (doneRef.current) return
        doneRef.current = true
        const next = String(draft ?? '').trim()
        setEditing(false)
        if (next === '' || next === value) return
        onCommit(next)
      }

      if (!editing) {
        return h('span', {
          style: textStyle,
          title: '点击改名',
          role: 'button',
          tabIndex: 0,
          onClick: start,
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            start()
          },
        }, value === '' || value === null || value === undefined ? (fallback ?? '未命名会议') : value)
      }

      return h('input', {
        style: inputStyle,
        value: draft,
        autoFocus: true,
        'aria-label': '会议标题',
        onChange: (event) => setDraft(event.target.value),
        onClick: (event) => event.stopPropagation(),
        onBlur: commit,
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            doneRef.current = true
            setEditing(false)
            setDraft(value)
          }
        },
      })
    }

    // ---------------------------------------------------------------- 准备引导

    /** whisper.cpp / 模型没准备好时，占住录制条的位置。 */
    function SetupBanner({ setup, busy, onSetup, bannerRef }) {
      if (setup === null || typeof setup !== 'object') return null
      const binary = setup.binary ?? {}
      const model = setup.model ?? {}
      const installing = setup.installing ?? null
      const downloading = model.downloading ?? null
      const installingActive = installing?.active === true
      const received = downloading === null ? 0 : Number(downloading.received) || 0
      const total = downloading === null ? 0 : Number(downloading.total) || 0
      const percent = downloading === null ? null : total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null

      const rows = []
      if (binary.ok !== true) {
        rows.push(h('div', { key: 'binary', style: styles.setupRow },
          h('div', { style: styles.setupText },
            h('div', { style: styles.setupTitle }, '需要安装 whisper.cpp'),
            h('div', { style: styles.setupHint },
              typeof binary.hint === 'string' && binary.hint !== ''
                ? binary.hint
                : '一次即可。装在本机，转写不上传音频。'),
          ),
          h('button', {
            className: 'mn-ghost',
            style: styles.primary,
            disabled: busy === 'install-binary' || installingActive,
            onClick: () => onSetup('install-binary'),
          }, installingActive || busy === 'install-binary' ? '安装中…' : '安装'),
        ))
      }

      if (model.ok !== true) {
        rows.push(h('div', { key: 'model', style: styles.setupRow },
          h('div', { style: styles.setupText },
            h('div', { style: styles.setupTitle }, '需要下载语音模型（约 1.6GB，一次即可）'),
            h('div', { style: styles.setupHint },
              downloading === null
                ? 'large-v3-turbo：中文标点和中英混说更稳，下载完就不用再联网。'
                : `下载中${percent === null ? '' : ` ${percent}%`}`),
            downloading === null ? null : h('div', { style: styles.progressTrack },
              h('div', { style: { ...styles.progressFill, width: `${percent ?? 0}%` } })),
          ),
          downloading === null
            ? h('button', {
              className: 'mn-ghost',
              style: styles.primary,
              disabled: busy === 'download-model',
              onClick: () => onSetup('download-model'),
            }, busy === 'download-model' ? '准备中…' : '下载')
            : h('span', { style: styles.muted }, percent === null ? '下载中…' : `${percent}%`),
        ))
      }

      if (rows.length === 0 && !installingActive) {
        return h('div', { ref: bannerRef, style: styles.setupCard },
          h('div', { style: styles.setupHead },
            h('span', { style: styles.setupTitleBig }, '准备中'),
            h('span', { style: styles.setupHint }, 'Host 还会再确认一次 whisper 与模型的可用性。'),
          ),
          h('div', { style: styles.setupNote }, '音频只留本机、纪要生成时才把文字发给模型。'),
        )
      }

      const log = installingActive && typeof installing.log === 'string' && installing.log !== ''
        ? installing.log.split('\n').slice(-6).join('\n')
        : null

      return h('div', { ref: bannerRef, style: styles.setupCard },
        h('div', { style: styles.setupHead },
          h(Icon, { name: 'mic', size: 16 }),
          h('span', { style: styles.setupTitleBig }, '开始前先准备一次'),
          h('span', { style: styles.setupHint }, '只做一次，之后点「开始记录」就行'),
        ),
        rows,
        log === null ? null : h('pre', { style: styles.setupLog }, log),
        h('div', { style: styles.setupNote }, '音频只留本机、纪要生成时才把文字发给模型。'),
      )
    }

    // ---------------------------------------------------------------- 录制条

    /** 顶部录制条：空闲 / 录制中 / 准备中 三种形态。 */
    function RecordBar(props) {
      const { state, elapsedMs, archives, busy, onStart, onStop, onCancel, onRename, onSetup, bannerRef } = props
      const recording = state?.recording ?? null
      const setup = state?.setup ?? null
      const setupReady = setup === null || setup === undefined ? true : setup.ready === true
      const recordingId = recording?.id ?? null
      // 「确认放弃」按给哪一场：换一场会就不再是确认态（不用额外的 effect 去重置）。
      const [confirmTarget, setConfirmTarget] = useState(null)
      const confirming = recordingId !== null && confirmTarget === recordingId

      useEffect(() => {
        if (confirmTarget === null) return undefined
        const timer = setTimeout(() => setConfirmTarget(null), 6000)
        return () => clearTimeout(timer)
      }, [confirmTarget])

      // 还没读到 /state：先给一个静态的条，避免页面跳一下。
      if (state === null) {
        return h('div', { style: styles.bar },
          h('div', { style: styles.barMain },
            h('div', { style: styles.barTitle }, '会议纪要'),
            h('div', { style: styles.barSub }, '正在读取状态…'),
          ),
        )
      }

      if (!setupReady) {
        return h(SetupBanner, { setup, busy, onSetup, bannerRef })
      }

      if (recording === null) {
        return h('div', { style: styles.bar },
          h('div', { style: styles.barMain },
            h('div', { style: styles.barTitle }, '会议纪要'),
            h('div', { style: styles.barSub }, `档案 ${archives} 场 · 录音只存在这台电脑上`),
          ),
          h('span', { style: { flex: 1 } }),
          h('button', {
            className: 'mn-solid',
            style: styles.primary,
            disabled: busy === 'start',
            onClick: onStart,
          }, busy === 'start' ? '正在开始…' : '开始记录'),
        )
      }

      const preparing = recording.status === 'preparing'

      return h('div', { style: styles.barRecording },
        h('span', { className: 'mn-rec-dot', style: styles.recDot }),
        h('span', { style: styles.recLabel }, preparing ? '正在准备' : '正在记录'),
        h('span', { style: styles.recClock }, hmsOf(elapsedMs)),
        h('span', { style: styles.barDivider }, '·'),
        h(EditableTitle, {
          value: recording.title,
          onCommit: (title) => onRename(recording.id, title),
          textStyle: styles.recTitle,
          inputStyle: styles.recTitleInput,
        }),
        h('span', { style: { flex: 1 } }),
        h('button', {
          className: 'mn-solid',
          style: styles.dangerSolid,
          disabled: busy === 'stop',
          onClick: onStop,
        }, busy === 'stop' ? '正在结束…' : '结束并生成纪要'),
        confirming
          ? [
            h('button', {
              key: 'yes',
              className: 'mn-solid',
              style: styles.dangerSolidSmall,
              disabled: busy === 'cancel',
              onClick: () => {
                setConfirmTarget(null)
                onCancel()
              },
            }, busy === 'cancel' ? '删除中…' : '确认放弃'),
            h('button', {
              key: 'no',
              className: 'mn-ghost',
              style: styles.button,
              onClick: () => setConfirmTarget(null),
            }, '再想想'),
          ]
          : h('button', {
            className: 'mn-ghost',
            style: styles.dangerGhost,
            onClick: () => setConfirmTarget(recordingId),
          }, '放弃'),
      )
    }

    // ---------------------------------------------------------------- 实时原文

    function LiveRow({ entry }) {
      const speaker = entry?.speaker === 'me' ? 'me' : 'them'
      return h('div', { style: styles.liveRow },
        h('span', { style: styles.liveTime }, clockOf(entry?.startMs)),
        h('span', {
          style: { ...styles.speakerTag, color: speaker === 'me' ? C.brand : C.warn },
        }, speaker === 'me' ? '我' : '对方'),
        h('span', { style: styles.liveText }, String(entry?.text ?? '')),
      )
    }

    /** 录制中滚动显示的最近几条原文，自动贴底。 */
    function LiveFeed({ entries }) {
      const list = useMemo(() => (Array.isArray(entries) ? entries.slice(-LIVE_LIMIT) : []), [entries])
      const boxRef = useRef(null)
      const lastLength = list.length === 0 ? 0 : String(list[list.length - 1]?.text ?? '').length

      // 只滚一下容器，没有定时器/监听器可释放（这个 effect 不产生资源）。
      useEffect(() => {
        const node = boxRef.current
        if (node === null) return
        node.scrollTop = node.scrollHeight
      }, [list.length, lastLength])

      return h('div', { style: styles.live },
        h('div', { style: styles.liveHead },
          h('span', { style: styles.liveTitle }, '实时原文'),
          h('span', { style: styles.liveHint }, `最近 ${LIVE_LIMIT} 条 · 每 20 秒出一段`),
        ),
        list.length === 0
          ? h('div', { style: styles.liveEmpty }, '正在听……（每 20 秒出一段）')
          : h('div', { ref: boxRef, style: styles.liveBody },
            list.map((entry, index) => h(LiveRow, { key: `${index}-${entry?.startMs ?? 0}`, entry }))),
      )
    }

    // ---------------------------------------------------------------- 历史列表

    /** 前端过滤：标题 / 摘要 / keywords（原文关键词）都参与，空格分词要求全部命中。 */
    function filterRecords(records, query) {
      const terms = String(query ?? '').toLowerCase().split(/\s+/).filter((term) => term !== '')
      if (terms.length === 0) return records
      return records.filter((record) => {
        const haystack = [record?.title, record?.summary, record?.keywords]
          .filter((value) => typeof value === 'string')
          .join('\n')
          .toLowerCase()
        return terms.every((term) => haystack.includes(term))
      })
    }

    function HistoryRow({ record, onOpen }) {
      const summary = typeof record?.summary === 'string' ? record.summary.trim() : ''
      const title = typeof record?.title === 'string' && record.title.trim() !== '' ? record.title : '未命名会议'
      return h('div', {
        className: 'mn-row',
        role: 'button',
        tabIndex: 0,
        title: summary === '' ? title : `${title}\n${summary}`,
        onClick: () => onOpen(record.id),
        onKeyDown: (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          onOpen(record.id)
        },
      },
      h('span', { style: styles.rowDate }, dateTimeText(record?.startedAt)),
      h('span', { style: styles.rowTitle }, title),
      h(StatusBadge, { status: record?.status }),
      h('span', { style: styles.rowDuration }, durationText(record?.durationMs)),
      h('span', { style: styles.rowSummary }, summary === '' ? '—' : summary),
      )
    }

    function HistoryList({ records, query, onQuery, onOpen, loading, recordsRoot }) {
      const filtered = useMemo(() => filterRecords(records, query), [records, query])
      const totalMs = useMemo(
        () => records.reduce((sum, record) => sum + (Number(record?.durationMs) || 0), 0),
        [records],
      )
      const root = typeof recordsRoot === 'string' && recordsRoot !== '' ? recordsRoot : '~/.dsh/meeting-notes/records/'

      let body
      if (loading && records.length === 0) {
        body = h('div', { style: styles.loadingBox }, '正在读取档案…')
      } else if (records.length === 0) {
        body = h('div', { style: styles.emptyBox },
          h('div', { style: styles.emptyTitle }, '还没有会议记录，点右上角「开始记录」'),
          h('div', { style: styles.emptyHint }, `每场会留档在 ${root}`),
        )
      } else if (filtered.length === 0) {
        body = h('div', { style: styles.emptyBox },
          h('div', { style: styles.emptyHint }, `没有匹配「${query}」的记录`),
        )
      } else {
        body = h('div', { style: styles.list },
          filtered.slice(0, LIST_LIMIT).map((record) => h(HistoryRow, { key: record.id, record, onOpen })),
        )
      }

      return h('div', { style: styles.section },
        h('div', { style: styles.sectionHead },
          h('div', { style: styles.searchBox },
            h(Icon, { name: 'search', size: 14 }),
            h('input', {
              style: styles.searchInput,
              value: query,
              placeholder: '搜索标题、摘要或原文关键词',
              'aria-label': '搜索会议记录',
              onChange: (event) => onQuery(event.target.value),
            }),
            query === ''
              ? null
              : h('button', {
                style: styles.clearButton,
                title: '清空搜索',
                onClick: () => onQuery(''),
              }, '×'),
          ),
          h('span', { style: { flex: 1 } }),
          h('span', { style: styles.muted }, loading ? '读取中…' : `共 ${records.length} 场`),
        ),
        body,
        h('div', { style: styles.footer }, `档案 ${records.length} 场 · 总时长 ${durationText(totalMs)}`),
      )
    }

    // ---------------------------------------------------------------- Markdown

    /** 只放行安全协议，避免 Markdown 里的链接变成 javascript:。 */
    function safeHref(uri) {
      const value = String(uri ?? '').trim()
      return /^(https?:|mailto:|\/|#)/i.test(value) ? value : '#'
    }

    const INLINE_PATTERN = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g

    /**
     * 行内记号：**粗体**、`代码`、[文字](链接)。
     * 所有文本都作为 React 文本节点插入（等价于 HTML 转义），不拼 innerHTML。
     */
    function renderInline(text, keyPrefix) {
      const value = String(text ?? '')
      const parts = []
      let last = 0
      let index = 0
      // 全局正则的 lastIndex 是共享状态，每次进来先归零。
      INLINE_PATTERN.lastIndex = 0
      let match = INLINE_PATTERN.exec(value)
      while (match !== null) {
        if (match.index > last) parts.push(value.slice(last, match.index))
        const token = match[0]
        const key = `${keyPrefix}-i${index}`
        index += 1
        if (token.startsWith('**')) {
          parts.push(h('strong', { key }, token.slice(2, -2)))
        } else if (token.startsWith('`')) {
          parts.push(h('code', { key, style: styles.mdCode }, token.slice(1, -1)))
        } else {
          const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
          if (link === null) parts.push(token)
          else {
            parts.push(h('a', {
              key,
              href: safeHref(link[2]),
              target: '_blank',
              rel: 'noreferrer',
              style: styles.mdLink,
            }, link[1]))
          }
        }
        last = match.index + token.length
        match = INLINE_PATTERN.exec(value)
      }
      if (last < value.length) parts.push(value.slice(last))
      return parts
    }

    /** 表格分隔行：`| --- | --- |`。 */
    function isTableSeparator(line) {
      return typeof line === 'string' && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/u.test(line)
    }

    /** 拆一行表格：去掉首尾竖线，按竖线切单元。 */
    function splitTableRow(line) {
      const value = String(line ?? '').trim().replace(/^\|/u, '').replace(/\|$/u, '')
      return value.split('|').map((cell) => cell.trim())
    }

    /**
     * 纪要渲染器：#/##/### 标题、有序/无序列表、引用、分隔线、段落，
     * 行内粗体/代码/链接。够用就好，不引 markdown 库。
     */
    function Markdown({ text }) {
      const blocks = useMemo(() => {
        const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
        const out = []
        let paragraph = []
        let list = null

        const flushParagraph = () => {
          if (paragraph.length === 0) return
          const key = `p${out.length}`
          out.push(h('p', { key, style: styles.mdP }, renderInline(paragraph.join(' '), key)))
          paragraph = []
        }
        const flushList = () => {
          if (list === null) return
          const key = `l${out.length}`
          out.push(h(list.type, { key, style: styles.mdList },
            list.items.map((item, itemIndex) => h('li', { key: `${key}-${itemIndex}`, style: styles.mdLi },
              renderInline(item, `${key}-${itemIndex}`)))))
          list = null
        }

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
          const raw = lines[lineIndex]
          const line = raw.trimEnd()
          const trimmed = line.trim()
          if (trimmed === '') {
            flushParagraph()
            flushList()
            continue
          }
          if (trimmed.startsWith('|') && isTableSeparator(lines[lineIndex + 1])) {
            flushParagraph()
            flushList()
            const rows = []
            let cursor = lineIndex
            while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
              if (!isTableSeparator(lines[cursor])) rows.push(splitTableRow(lines[cursor]))
              cursor += 1
            }
            lineIndex = cursor - 1
            const key = `t${out.length}`
            const header = rows.shift() ?? []
            out.push(h('table', { key, style: styles.mdTable },
              h('thead', null, h('tr', null, header.map((cell, cellIndex) => h('th', {
                key: `${key}-h${cellIndex}`,
                style: styles.mdTh,
              }, renderInline(cell, `${key}-h${cellIndex}`))))),
              h('tbody', null, rows.map((row, rowIndex) => h('tr', { key: `${key}-r${rowIndex}` },
                row.map((cell, cellIndex) => h('td', {
                  key: `${key}-r${rowIndex}-c${cellIndex}`,
                  style: styles.mdTd,
                }, renderInline(cell, `${key}-r${rowIndex}-c${cellIndex}`))))))))
            continue
          }
          const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
          if (heading !== null) {
            flushParagraph()
            flushList()
            const level = Math.min(4, heading[1].length)
            const key = `h${out.length}`
            out.push(h(`h${level}`, { key, style: styles.mdHeading[level] }, renderInline(heading[2], key)))
            continue
          }
          if (trimmed.startsWith('> ')) {
            flushParagraph()
            flushList()
            const key = `q${out.length}`
            out.push(h('blockquote', { key, style: styles.mdQuote }, renderInline(trimmed.slice(2), key)))
            continue
          }
          if (/^([-*_])\1{2,}$/.test(trimmed)) {
            flushParagraph()
            flushList()
            out.push(h('hr', { key: `hr${out.length}`, style: styles.mdHr }))
            continue
          }
          const bullet = /^[-*+]\s+(.*)$/.exec(trimmed)
          const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed)
          if (bullet !== null || ordered !== null) {
            flushParagraph()
            const type = bullet !== null ? 'ul' : 'ol'
            if (list !== null && list.type !== type) flushList()
            if (list === null) list = { type, items: [] }
            list.items.push((bullet !== null ? bullet : ordered)[1])
            continue
          }
          flushList()
          paragraph.push(trimmed)
        }
        flushParagraph()
        flushList()
        return out
      }, [text])

      return h('div', { style: styles.md }, blocks)
    }

    // ---------------------------------------------------------------- 原文

    /**
     * 把 `{ blocks: [{ startMs, entries: [{ startMs }] }] }` 摊平成带绝对时间的行。
     *
     * 两种来源形状不一样：本机转写每条带 `startMs`（块内相对，加上块起点就是绝对时间）；
     * 导入的官方转写是整段纯文本，Host 存成 `speaker: 'note'`、`startMs: null`。
     * 后者的时间戳和说话人都无从得知，所以保留原样：不排序、不贴标签、不能跳转。
     */
    function flattenBlocks(blocks) {
      const rows = []
      if (!Array.isArray(blocks)) return rows
      blocks.forEach((block, blockIndex) => {
        const base = Number(block?.startMs) || 0
        const entries = Array.isArray(block?.entries) ? block.entries : []
        entries.forEach((entry, entryIndex) => {
          const text = typeof entry?.text === 'string' ? entry.text.trim() : ''
          if (text === '') return
          const relative = entry?.startMs
          const speaker = entry?.speaker === 'me' || entry?.speaker === 'them' ? entry.speaker : 'note'
          rows.push({
            key: `${blockIndex}-${entryIndex}`,
            ms: typeof relative === 'number' && Number.isFinite(relative) ? base + relative : null,
            speaker,
            text,
          })
        })
      })
      if (rows.every((row) => row.ms !== null)) rows.sort((a, b) => a.ms - b.ms)
      return rows
    }

    /** 原文里「我 / 对方」两色标签；导入的官方转写没有说话人，就不贴标签。 */
    function speakerChip(speaker) {
      if (speaker !== 'me' && speaker !== 'them') return null
      return h('span', {
        style: { ...styles.trTag, color: speaker === 'me' ? C.brand : C.warn },
      }, speaker === 'me' ? '我' : '对方')
    }

    /** 「原文」标签页：每条 mm:ss + 我/对方 + 文本，点一条跳到录音对应位置。 */
    function TranscriptPanel(props) {
      const { rows, positionMs, onSeek, sourceMode, autoLoading, hasSwitch, onSwitchSource, emptyText, note } = props
      let activeIndex = -1
      for (let index = 0; index < rows.length; index += 1) {
        const ms = rows[index].ms
        if (ms === null) continue
        if (ms <= positionMs) activeIndex = index
        else break
      }

      return h('div', { style: styles.panel },
        h('div', { style: styles.panelHead },
          h('span', { style: styles.panelTitle }, '原文'),
          hasSwitch
            ? h('div', { style: styles.switchWrap },
              h('button', {
                style: sourceMode === 'auto' ? styles.switchOn : styles.switchOff,
                disabled: autoLoading,
                onClick: () => onSwitchSource('auto'),
              }, autoLoading ? '读取中…' : '自动版'),
              h('button', {
                style: sourceMode === 'auto' ? styles.switchOff : styles.switchOn,
                onClick: () => onSwitchSource('loaded'),
              }, '官方版'),
            )
            : null,
          h('span', { style: { flex: 1 } }),
          rows.length === 0 ? null : h('span', { style: styles.muted }, `共 ${rows.length} 段`),
        ),
        typeof note === 'string' && note !== '' ? h('div', { style: styles.autoNote }, note) : null,
        rows.length === 0
          ? h('div', { style: styles.empty }, emptyText)
          : h('div', { style: styles.transcriptList },
            rows.map((row, index) => {
              const seekable = row.ms !== null
              return h('div', {
                key: row.key,
                className: seekable && index === activeIndex ? 'mn-tr active' : 'mn-tr',
                role: seekable ? 'button' : undefined,
                tabIndex: seekable ? 0 : undefined,
                title: seekable ? '跳到录音这个时间' : '官方转写没有时间戳，无法跳转',
                style: seekable ? undefined : { cursor: 'default' },
                onClick: seekable ? () => onSeek(row.ms) : undefined,
                onKeyDown: seekable
                  ? (event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return
                    event.preventDefault()
                    onSeek(row.ms)
                  }
                  : undefined,
              },
              h('span', { style: styles.trTime }, seekable ? clockOf(row.ms) : ''),
              speakerChip(row.speaker),
              h('span', { style: styles.trText }, row.text),
              )
            })),
      )
    }

    // ---------------------------------------------------------------- 导入对话框

    /** 导入对话框：只有打开时才挂载（挂着才存在，关掉即卸载，粘贴内容不跨次残留）。 */
    function ImportDialog({ busy, onCancel, onSubmit }) {
      const [text, setText] = useState('')

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onCancel()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onCancel])

      const trimmed = text.trim()
      const disabled = trimmed === '' || busy === 'import'

      return h('div', {
        style: styles.overlay,
        onClick: (event) => {
          if (event.target === event.currentTarget) onCancel()
        },
      },
      h('div', {
        style: styles.dialog,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': '导入官方转写',
      },
      h('div', { style: styles.dialogTitle }, '导入官方转写'),
      h('div', { style: styles.dialogHint },
        '把钉钉闪记 / 腾讯会议 / Teams 的转写文本整段粘进来，会替换原文，自动版留底（之后可以在原文里切回自动版）。'),
      h('textarea', {
        style: styles.textarea,
        value: text,
        autoFocus: true,
        placeholder: '00:00 张三：今天先过一下上周的进度……',
        'aria-label': '官方转写文本',
        onChange: (event) => setText(event.target.value),
      }),
      h('div', { style: styles.dialogActions },
        h('button', { className: 'mn-ghost', style: styles.button, onClick: onCancel }, '取消'),
        h('button', {
          className: 'mn-solid',
          style: styles.primary,
          disabled,
          onClick: () => onSubmit(trimmed),
        }, busy === 'import' ? '导入中…' : '导入'),
      )),
      )
    }

    // ---------------------------------------------------------------- Toast

    function Toast({ message }) {
      if (message === null || message === undefined || message === '') return null
      return h('div', { style: styles.toast, role: 'status' }, message)
    }

    // ---------------------------------------------------------------- 详情

    function DetailView(props) {
      const {
        detail, loading, error, hasAudio, busy,
        sourceMode, autoTranscript, autoLoading, autoNote, onSwitchSource,
        onBack, onRename, onExport, onImportOpen, onRegenerate, onRecover, onDelete,
      } = props

      const meta = detail?.meta ?? null
      const metaId = meta?.id ?? null
      const status = meta?.status ?? null
      const [tab, setTab] = useState('minutes')
      const [positionMs, setPositionMs] = useState(0)
      const [confirmDelete, setConfirmDelete] = useState(false)
      const audioRef = useRef(null)
      const pendingSeekRef = useRef(null)

      // 页面切走 / 换档案时把播放停掉。
      useEffect(() => () => {
        const node = audioRef.current
        if (node === null || typeof node.pause !== 'function') return
        try {
          node.pause()
        } catch {
          // 卸载时暂停失败无所谓。
        }
      }, [])

      useEffect(() => {
        if (!confirmDelete) return undefined
        const timer = setTimeout(() => setConfirmDelete(false), 6000)
        return () => clearTimeout(timer)
      }, [confirmDelete])

      // 原文：官方版 = /record 的 transcript；自动版 = 另外拉的一份。
      const loadedTranscript = detail?.transcript ?? null
      const transcript = sourceMode === 'auto' && autoTranscript !== null
        ? autoTranscript
        : loadedTranscript ?? { source: 'auto', blocks: [] }
      const rows = useMemo(() => flattenBlocks(transcript?.blocks), [transcript])
      const minutesText = typeof detail?.minutes === 'string' ? detail.minutes : ''
      const hasSwitch = detail?.autoTranscriptAvailable === true || autoTranscript !== null
      const officialImported = loadedTranscript?.source === 'imported'
        || detail?.transcriptSource === 'imported'
        || meta?.transcriptSource === 'imported'
      const audioAvailable = hasAudio !== false

      const seek = useCallback((ms) => {
        const node = audioRef.current
        const seconds = Math.max(0, (Number(ms) || 0) / 1000)
        setPositionMs(Number(ms) || 0)
        if (node === null) return
        const play = () => {
          try {
            node.currentTime = seconds
          } catch {
            // 还没加载好时忽略，onLoadedMetadata 会补。
          }
          try {
            const result = typeof node.play === 'function' ? node.play() : null
            if (result !== null && typeof result.catch === 'function') result.catch(() => {})
          } catch {
            // 自动播放被拦下也没关系。
          }
        }
        if (node.readyState >= 1) play()
        else pendingSeekRef.current = seconds
      }, [])

      const onTimeUpdate = useCallback((event) => {
        const ms = Math.round((event.target.currentTime || 0) * 1000)
        setPositionMs((current) => (Math.abs(current - ms) >= 900 ? ms : current))
      }, [])

      const onLoadedMetadata = useCallback(() => {
        const node = audioRef.current
        const pending = pendingSeekRef.current
        pendingSeekRef.current = null
        if (node === null || pending === null) return
        try {
          node.currentTime = pending
          const result = typeof node.play === 'function' ? node.play() : null
          if (result !== null && typeof result.catch === 'function') result.catch(() => {})
        } catch {
          // 同样忽略。
        }
      }, [])

      // 还没读到详情：只有一条返回 + 提示。
      if (detail === null) {
        return h('div', { style: styles.detail },
          h('div', { style: styles.detailHead },
            h('button', {
              style: styles.backButton,
              onClick: onBack,
            }, h(Icon, { name: 'back', size: 15 }), '返回'),
          ),
          h('div', { style: styles.loadingBox }, error === null ? '正在读取档案…' : `读取失败：${error}`),
        )
      }

      const busyGenerating = busy === 'regenerate' || status === 'transcribing' || status === 'generating'
      const canRecover = status === 'interrupted' || status === 'failed'
      const audioVisible = tab === 'transcript' || tab === 'audio'
      const audioWrapStyle = !audioVisible
        ? { display: 'none' }
        : tab === 'audio' ? styles.audioPanel : styles.audioBar

      const notice = status === 'transcribing'
        ? '正在转写录音，完成后会自动生成纪要；页面每 2 秒自动刷新。'
        : status === 'generating'
          ? '正在生成纪要，页面每 2 秒自动刷新。'
          : canRecover
            ? `这场没有完成：${typeof meta?.error === 'string' && meta.error !== '' ? meta.error : '未知原因'}，可以点「补完档案」重试。`
            : null

      const tabs = [
        ['minutes', '纪要'],
        ['transcript', '原文'],
        ['audio', '录音'],
      ]

      const minutesBody = minutesText.trim() === ''
        ? h('div', { style: styles.empty },
          status === 'transcribing'
            ? '录音已结束，正在转写原文，完成后会自动生成纪要。'
            : status === 'generating'
              ? '正在生成纪要…'
              : '这场还没有纪要，可以点右上角「重新生成纪要」再试一次。')
        : h('div', { style: styles.minutesWrap }, h(Markdown, { text: minutesText }))

      const transcriptEmptyText = status === 'transcribing'
        ? '正在转写原文，稍等一会儿。'
        : '这场没有原文。可以点右上角「导入官方转写」，把会议软件导出的文本粘进来。'

      return h('div', { style: styles.detail },
        h('div', { style: styles.detailHead },
          h('button', {
            style: styles.backButton,
            onClick: onBack,
            title: '返回历史列表',
          }, h(Icon, { name: 'back', size: 15 }), '返回'),
          h('div', { style: styles.detailTitleBox },
            h(EditableTitle, {
              value: typeof meta?.title === 'string' ? meta.title : '',
              onCommit: (title) => onRename(metaId, title),
              textStyle: styles.detailTitle,
              inputStyle: styles.titleInput,
            }),
            h('div', { style: styles.detailMeta },
              h(StatusBadge, { status }),
              h('span', null, fullDateText(meta?.startedAt)),
              h('span', null, durationText(meta?.durationMs)),
              h('span', { style: styles.sourceChip }, officialImported ? '官方转写' : '自动转写'),
              typeof meta?.minutesModel === 'string' && meta.minutesModel !== ''
                ? h('span', null, `纪要模型 ${meta.minutesModel}`)
                : null,
            ),
          ),
          h('div', { style: styles.detailActions },
            h('button', {
              className: 'mn-ghost',
              style: styles.button,
              disabled: minutesText.trim() === '',
              onClick: () => onExport('minutes'),
            }, '导出纪要'),
            h('button', {
              className: 'mn-ghost',
              style: styles.button,
              disabled: rows.length === 0,
              onClick: () => onExport('transcript'),
            }, '导出原文'),
            h('button', {
              className: 'mn-ghost',
              style: styles.button,
              onClick: onImportOpen,
            }, '导入官方转写'),
            h('button', {
              className: 'mn-ghost',
              style: styles.button,
              disabled: busyGenerating,
              onClick: () => onRegenerate(metaId),
            }, busyGenerating ? '正在重新生成…' : '重新生成纪要'),
            canRecover
              ? h('button', {
                className: 'mn-ghost',
                style: styles.button,
                disabled: busy === 'recover',
                onClick: () => onRecover(metaId),
              }, busy === 'recover' ? '补完中…' : '补完档案')
              : null,
            confirmDelete
              ? [
                h('button', {
                  key: 'yes',
                  className: 'mn-solid',
                  style: styles.dangerSolidSmall,
                  disabled: busy === 'delete',
                  onClick: () => {
                    setConfirmDelete(false)
                    onDelete(metaId)
                  },
                }, busy === 'delete' ? '删除中…' : '确认删除'),
                h('button', {
                  key: 'no',
                  className: 'mn-ghost',
                  style: styles.button,
                  onClick: () => setConfirmDelete(false),
                }, '取消'),
              ]
              : h('button', {
                className: 'mn-ghost',
                style: styles.dangerGhost,
                onClick: () => setConfirmDelete(true),
              }, '删除'),
          ),
        ),
        notice === null ? null : h('div', { style: styles.notice }, notice),
        h('div', { style: styles.tabs },
          tabs.map(([id, label]) => h('button', {
            key: id,
            style: tab === id ? styles.tabActive : styles.tab,
            onClick: () => setTab(id),
          }, label))),
        audioAvailable
          ? h('div', { key: 'audio', style: audioWrapStyle },
            h('audio', {
              ref: audioRef,
              controls: true,
              preload: 'metadata',
              src: `${API}/audio?id=${encodeURIComponent(metaId ?? '')}`,
              style: styles.audio,
              onTimeUpdate,
              onLoadedMetadata,
            }),
            h('span', { style: styles.audioHint },
              tab === 'audio'
                ? '录音只在本机，删档案就一起删掉。'
                : '点下面任意一句，跳到录音对应时间。'))
          : null,
        tab === 'minutes' ? minutesBody : null,
        tab === 'transcript'
          ? h(TranscriptPanel, {
            rows,
            positionMs,
            onSeek: seek,
            sourceMode,
            autoLoading,
            hasSwitch,
            onSwitchSource,
            note: autoNote,
            emptyText: transcriptEmptyText,
          })
          : null,
        tab === 'audio' && !audioAvailable
          ? h('div', { style: styles.panel },
            h('div', { style: styles.empty }, '这场没有录音文件（可能只导入了官方转写）。'))
          : null,
      )
    }

    // ---------------------------------------------------------------- 整页

    function MeetingPage() {
      const [state, setState] = useState(null)
      const [records, setRecords] = useState([])
      const [loadingList, setLoadingList] = useState(true)
      const [query, setQuery] = useState('')
      const [detailId, setDetailId] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailLoading, setDetailLoading] = useState(false)
      const [detailError, setDetailError] = useState(null)
      const [sourceMode, setSourceMode] = useState('loaded')
      const [autoTranscript, setAutoTranscript] = useState(null)
      const [autoLoading, setAutoLoading] = useState(false)
      // 自动版读不到时给一句持久说明（toast 一闪而过，用户会以为按钮坏了）。
      const [autoNote, setAutoNote] = useState(null)
      const [importOpen, setImportOpen] = useState(false)
      const [busy, setBusy] = useState(null)
      const [toast, setToast] = useState(null)
      const [pageError, setPageError] = useState(null)
      const [tick, setTick] = useState(() => Date.now())
      const bannerRef = useRef(null)
      const aliveRef = useRef(true)

      useEffect(() => {
        aliveRef.current = true
        return () => {
          aliveRef.current = false
        }
      }, [])

      const refreshState = useCallback(async (signal) => {
        const body = await api.state(signal)
        if (aliveRef.current) setState(body)
        return body
      }, [])

      const refreshList = useCallback(async (signal) => {
        const body = await api.list(signal)
        const next = Array.isArray(body?.records) ? body.records : []
        if (aliveRef.current) setRecords(next)
        return next
      }, [])

      // 首屏：状态 + 列表并行；离开页面就 abort + 丢弃迟到的响应。
      useEffect(() => {
        let cancelled = false
        const controller = new AbortController()
        const keep = () => !cancelled && aliveRef.current
        refreshState(controller.signal)
          .then(() => {
            if (keep()) setPageError(null)
          })
          .catch((reason) => {
            if (ignoreAbort(reason)) return
            report('state', reason)
            if (keep()) setPageError(`读取状态失败：${messageOf(reason)}`)
          })
        refreshList(controller.signal)
          .catch((reason) => {
            if (ignoreAbort(reason)) return
            report('list', reason)
            if (keep()) setPageError(`读取档案列表失败：${messageOf(reason)}`)
          })
          .finally(() => {
            if (keep()) setLoadingList(false)
          })
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [refreshState, refreshList])

      const recording = state?.recording ?? null
      const recordingId = recording?.id ?? null
      const setup = state?.setup ?? null
      const setupReady = setup === null || setup === undefined ? true : setup.ready === true
      const installingActive = setup?.installing?.active === true
      const downloading = setup?.model?.downloading ?? null
      // 停止之后 Host 还要转写尾巴、生成纪要、归档：`finalizing` 非空就继续刷。
      const finalizing = Array.isArray(state?.finalizing) ? state.finalizing : []

      // 录制中 / 准备中 / 收尾中：每 2 秒拉一次 /state（页面不可见时跳过）。
      const shouldPollState = recordingId !== null || !setupReady || installingActive || downloading !== null || finalizing.length > 0
      useEffect(() => {
        if (!shouldPollState) return undefined
        let cancelled = false
        const controller = new AbortController()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          api.state(controller.signal)
            .then((body) => {
              if (!cancelled) setState(body)
            })
            .catch((reason) => {
              if (ignoreAbort(reason)) return
              report('poll-state', reason)
            })
        }, 2000)
        return () => {
          cancelled = true
          clearInterval(timer)
          controller.abort()
        }
      }, [shouldPollState])

      // 录制中每秒走一次钟，时间从 startedAt 算，比轮询间隔更跟手。
      useEffect(() => {
        if (recordingId === null) return undefined
        setTick(Date.now())
        const timer = setInterval(() => setTick(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [recordingId])

      // 一场录完（recording 从有到无）时把列表换掉，状态徽标跟着更新。
      // 这个 effect 只记一笔 ref，没有资源要释放。
      const previousRecordingId = useRef(null)
      useEffect(() => {
        if (previousRecordingId.current !== null && recordingId === null) {
          refreshList().catch((reason) => report('list-after-stop', reason))
        }
        previousRecordingId.current = recordingId
      }, [recordingId, refreshList])

      // 后台收尾（补完 / 重新生成）结束时，列表里的状态徽标也要跟着变。
      // 这个 effect 只记一笔 ref，没有资源要释放。
      const previousFinalizing = useRef(0)
      useEffect(() => {
        if (previousFinalizing.current > 0 && finalizing.length === 0) {
          refreshList().catch((reason) => report('list-after-finalize', reason))
        }
        previousFinalizing.current = finalizing.length
      }, [finalizing, refreshList])

      // 详情：换 id 就重新拉一份。
      useEffect(() => {
        if (detailId === null) {
          setDetail(null)
          setDetailError(null)
          setDetailLoading(false)
          return undefined
        }
        let cancelled = false
        const controller = new AbortController()
        setDetailLoading(true)
        setDetailError(null)
        setSourceMode('loaded')
        setAutoTranscript(null)
        setAutoNote(null)
        api.record(detailId, null, controller.signal)
          .then((body) => {
            if (!cancelled) setDetail(body)
          })
          .catch((reason) => {
            if (ignoreAbort(reason)) return
            report('record', reason)
            if (!cancelled) setDetailError(messageOf(reason))
          })
          .finally(() => {
            if (!cancelled) setDetailLoading(false)
          })
        return () => {
          cancelled = true
          controller.abort()
        }
      }, [detailId])

      // 详情里 transcribing|generating：每 2 秒拉一次 /record，直到 ready|failed。
      const detailStatus = detail?.meta?.status ?? null
      const detailPolling = detailId !== null && (detailStatus === 'transcribing' || detailStatus === 'generating')
      useEffect(() => {
        if (!detailPolling) return undefined
        let cancelled = false
        const controller = new AbortController()
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          api.record(detailId, null, controller.signal)
            .then((body) => {
              if (cancelled) return
              setDetail(body)
              const nextStatus = body?.meta?.status
              if (nextStatus !== 'transcribing' && nextStatus !== 'generating') {
                refreshList().catch((reason) => report('list-after-detail', reason))
              }
            })
            .catch((reason) => {
              if (ignoreAbort(reason)) return
              report('poll-record', reason)
            })
        }, 2000)
        return () => {
          cancelled = true
          clearInterval(timer)
          controller.abort()
        }
      }, [detailPolling, detailId, refreshList])

      // toast 自动消失。
      useEffect(() => {
        if (toast === null) return undefined
        const timer = setTimeout(() => setToast(null), 2800)
        return () => clearTimeout(timer)
      }, [toast])

      // ---- 动作

      const startRecording = useCallback(async () => {
        setBusy('start')
        try {
          await api.start()
          await Promise.all([refreshState(), refreshList()])
          setToast('已开始记录')
        } catch (reason) {
          report('start', reason)
          if (reason?.code === 'setup') {
            setToast('先完成准备：安装 whisper.cpp 或下载语音模型')
            const node = bannerRef.current
            if (node !== null && typeof node.scrollIntoView === 'function') {
              node.scrollIntoView({ block: 'center', behavior: 'smooth' })
            }
          } else {
            setToast(`开始失败：${messageOf(reason)}`)
          }
          refreshState().catch(() => {})
        } finally {
          if (aliveRef.current) setBusy(null)
        }
      }, [refreshState, refreshList])

      const stopRecording = useCallback(async () => {
        setBusy('stop')
        try {
          await api.stop()
          setToast('已结束，正在转写原文并生成纪要')
          await Promise.all([refreshState(), refreshList()])
        } catch (reason) {
          report('stop', reason)
          setToast(`结束失败：${messageOf(reason)}`)
        } finally {
          if (aliveRef.current) setBusy(null)
        }
      }, [refreshState, refreshList])

      const cancelRecording = useCallback(async () => {
        setBusy('cancel')
        try {
          await api.cancel()
          setToast('已放弃这场录音')
          await Promise.all([refreshState(), refreshList()])
        } catch (reason) {
          report('cancel', reason)
          setToast(`放弃失败：${messageOf(reason)}`)
        } finally {
          if (aliveRef.current) setBusy(null)
        }
      }, [refreshState, refreshList])

      const renameRecord = useCallback(async (id, title) => {
        try {
          await api.rename(id, title)
          setToast('已改名')
          setDetail((current) => {
            if (current === null || current?.meta?.id !== id) return current
            return { ...current, meta: { ...current.meta, title } }
          })
          await Promise.all([refreshState(), refreshList()])
        } catch (reason) {
          report('rename', reason)
          setToast(`改名失败：${messageOf(reason)}`)
        }
      }, [refreshState, refreshList])

      const runSetup = useCallback(async (action) => {
        setBusy(action)
        try {
          await api.setup(action)
          setToast(action === 'install-binary' ? '正在安装 whisper.cpp…' : '正在下载语音模型，约 1.6GB')
          await refreshState()
        } catch (reason) {
          report('setup', reason)
          setToast(`准备失败：${messageOf(reason)}`)
        } finally {
          if (aliveRef.current) setBusy(null)
        }
      }, [refreshState])

      const openRecord = useCallback((id) => {
        // 先清掉上一场的详情：否则 DetailView 重挂的第一帧会拿旧数据画标题和纪要。
        setImportOpen(false)
        setDetail(null)
        setDetailError(null)
        setDetailId(id)
      }, [])

      const backToList = useCallback(() => {
        setDetailId(null)
        setDetail(null)
        setImportOpen(false)
        refreshList().catch((reason) => report('list-back', reason))
      }, [refreshList])

      const deleteRecord = useCallback(async (id) => {
        setBusy('delete')
        try {
          await api.remove(id)
          setToast('已删除这场档案')
          setDetailId(null)
          setDetail(null)
          await Promise.all([refreshState(), refreshList()])
        } catch (reason) {
          report('delete', reason)
          setToast(`删除失败：${messageOf(reason)}`)
        } finally {
          if (aliveRef.current) setBusy(null)
        }
      }, [refreshState, refreshList])

      const regenerateRecord = useCallback(async (id) => {
        setBusy('regenerate')
        try {
          await api.regenerate(id)
          setToast('正在重新生成纪要…')
          const body = await api.record(id)
          if (aliveRef.current) setDetail(body)
          refreshList().catch((reason) => report('list-regenerate', reason))
        } catch (reason) {
          report('regenerate', reason)
          setToast(`重新生成失败：${messageOf(reason)}`)
        } finally {
          if (aliveRef.current) setBusy(null)
        }
      }, [refreshList])

      const recoverRecord = useCallback(async (id) => {
        setBusy('recover')
        try {
          await api.recover(id)
          setToast('正在补完这场档案…')
          const body = await api.record(id)
          if (aliveRef.current) setDetail(body)
          refreshList().catch((reason) => report('list-recover', reason))
        } catch (reason) {
          report('recover', reason)
          setToast(`补完失败：${messageOf(reason)}`)
        } finally {
          if (aliveRef.current) setBusy(null)
        }
      }, [refreshList])

      const importTranscript = useCallback(async (id, text) => {
        setBusy('import')
        try {
          await api.importText(id, text)
          setImportOpen(false)
          setSourceMode('loaded')
          setAutoTranscript(null)
          const body = await api.record(id)
          if (aliveRef.current) {
            setDetail(body)
            setToast('已导入官方转写，自动版已留底')
          }
          refreshList().catch((reason) => report('list-import', reason))
        } catch (reason) {
          report('import', reason)
          setToast(`导入失败：${messageOf(reason)}`)
        } finally {
          if (aliveRef.current) setBusy(null)
        }
      }, [refreshList])

      const switchSource = useCallback(async (mode) => {
        if (mode === 'loaded') {
          setSourceMode('loaded')
          setAutoNote(null)
          return
        }
        if (autoTranscript !== null) {
          setSourceMode('auto')
          return
        }
        if (detailId === null) return
        setAutoLoading(true)
        setAutoNote(null)
        try {
          // Host 若在 /record 里给 autoTranscript（或认 source=auto），就直接用；
          // 拿回来的还是官方版就说明没提供，别假装切过去了。
          const body = await api.record(detailId, 'auto')
          const candidate = body?.autoTranscript
            ?? (body?.transcript?.source === 'auto' ? body.transcript : null)
          const blocks = Array.isArray(candidate?.blocks) ? candidate.blocks : []
          if (blocks.length === 0) {
            if (aliveRef.current) {
              setAutoNote('Host 没有返回自动版原文（档案目录里的 transcript.auto.json 还留着底）。')
            }
            return
          }
          if (!aliveRef.current) return
          setAutoTranscript({ source: candidate?.source ?? 'auto', blocks })
          setSourceMode('auto')
        } catch (reason) {
          report('auto-transcript', reason)
          if (aliveRef.current) setAutoNote(`读取自动版失败：${messageOf(reason)}`)
        } finally {
          if (aliveRef.current) setAutoLoading(false)
        }
      }, [autoTranscript, detailId])

      const exportRecord = useCallback(async (kind) => {
        if (detailId === null) return
        const title = typeof detail?.meta?.title === 'string' ? detail.meta.title : '会议纪要'
        try {
          const response = await fetch(`${API}/export?id=${encodeURIComponent(detailId)}&kind=${encodeURIComponent(kind)}`)
          if (!response.ok) throw new Error(`导出失败（HTTP ${response.status}）`)
          const text = await response.text()
          const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = `${safeFileName(title)}-${kind === 'minutes' ? '纪要' : '原文'}.md`
          link.style.display = 'none'
          document.body.appendChild(link)
          link.click()
          link.remove()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          setToast('已导出')
        } catch (reason) {
          report('export', reason)
          setToast(`导出失败：${messageOf(reason)}`)
        }
      }, [detailId, detail])

      const elapsedMs = (() => {
        if (recording === null) return 0
        const startedAt = parseTime(recording.startedAt)
        if (startedAt === null) return Number(recording.elapsedMs) || 0
        return Math.max(0, tick - startedAt)
      })()

      const liveEntries = state?.live?.entries ?? []
      const recordsRoot = state?.config?.recordsRoot

      return h('div', { style: styles.page },
        h('style', { key: 'mn-css' }, CSS),
        h('div', { style: styles.shell },
          h(RecordBar, {
            state,
            elapsedMs,
            archives: records.length,
            busy,
            onStart: startRecording,
            onStop: stopRecording,
            onCancel: cancelRecording,
            onRename: renameRecord,
            onSetup: runSetup,
            bannerRef,
          }),
          recording === null ? null : h(LiveFeed, { entries: liveEntries }),
          recording !== null || finalizing.length === 0
            ? null
            : h('div', { style: styles.notice },
              `正在处理 ${finalizing.length} 场录音（转写 / 生成纪要 / 归档），完成后会自动刷新。`),
          pageError === null ? null : h('div', { style: styles.errorBox }, pageError),
          detailId === null
            ? h(HistoryList, {
              records,
              query,
              onQuery: setQuery,
              onOpen: openRecord,
              loading: loadingList,
              recordsRoot,
            })
            : h(DetailView, {
              // 换一场会就重挂一次：标签页、播放位置、二次确认都自然归零。
              key: detailId,
              detail,
              loading: detailLoading,
              error: detailError,
              hasAudio: detail?.meta?.hasAudio ?? records.find((record) => record?.id === detailId)?.hasAudio,
              busy,
              sourceMode,
              autoTranscript,
              autoLoading,
              autoNote,
              onSwitchSource: switchSource,
              onBack: backToList,
              onRename: renameRecord,
              onExport: exportRecord,
              onImportOpen: () => setImportOpen(true),
              onRegenerate: regenerateRecord,
              onRecover: recoverRecord,
              onDelete: deleteRecord,
            }),
          importOpen
            ? h(ImportDialog, {
              busy,
              onCancel: () => setImportOpen(false),
              onSubmit: (text) => {
                if (detailId === null) return
                importTranscript(detailId, text)
              },
            })
            : null,
          h(Toast, { message: toast }),
        ),
      )
    }

    // ---------------------------------------------------------------- 注册

    return {
      inject: ['slots'],
      apply(ctx) {
        report('apply-start', `slots=${ctx.slots === undefined ? 'missing' : 'ok'}`)

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

        // 左侧常驻入口：id 即面板 id，点它切到 main 那一页。
        seat('sidebar.panellist', 'panellist', {
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 8,
          label: '会议纪要',
        }, PanelIcon)

        // 整页（不是右侧栏）。
        seat('main', 'main', { name: 'main', key: PANEL_ID, id: PANEL_ID }, MeetingPage)

        // `apply` 的返回值会被 Cordis 当成 disposer：生产环境一律不返回。
        // 只有测试钩子打开时才把内部纯函数交出去，方便 node 里直接跑。
        if (globalThis.__meetingNotesTest === true) {
          return {
            flattenBlocks,
            filterRecords,
            clockOf,
            hmsOf,
            durationText,
            safeFileName,
            safeHref,
            components: { RecordBar, LiveFeed, HistoryList, DetailView, ImportDialog, SetupBanner, Toast, Markdown, TranscriptPanel, EditableTitle, HistoryRow, StatusBadge, PanelIcon },
          }
        }
        return undefined
      },
    }
  },
})
