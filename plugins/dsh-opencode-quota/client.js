/**
 * Browser half of `@local/dsh-opencode-quota`.
 *
 * Renders one compact chip beside Settings at the sidebar foot — the page's
 * bottom-left corner — with the remaining OpenCode Go subscription quota, and a
 * popover listing the rolling (5h), weekly and monthly windows with their reset
 * times.
 *
 * Numbers come from the Host route `GET /plugins/opencode-quota/usage`; the API
 * key stays in the Host process. The chip previews the rolling (5-hour) window —
 * the one that refills fastest and therefore decides whether a heavy session can
 * continue — and names the time it refreshes; the popover carries every window.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-opencode-quota',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace of this plugin. */
    const NS = 'opencode-quota'

    /** Host route that answers the projected snapshot. */
    const ENDPOINT = '/plugins/opencode-quota/usage'

    /** Windows reported by the subscription, in display order. */
    const WINDOW_KEYS = ['rolling', 'weekly', 'monthly']

    /** Re-read interval while the popover is closed / open. */
    const POLL_IDLE_MS = 5 * 60 * 1000
    const POLL_OPEN_MS = 60 * 1000

    /** Preferred popover width; narrower when the viewport is. */
    const PANEL_WIDTH = 300

    const zh = {
      'chip.label': 'Go',
      'chip.title': 'OpenCode Go · 5 小时额度剩 {remaining}%',
      'chip.reset': '{time} 刷新',
      'chip.resetSoon': '即将刷新',
      'chip.unknown': 'OpenCode Go 额度',
      'panel.title': 'OpenCode Go 额度',
      'panel.refresh': '刷新',
      'panel.close': '关闭',
      'panel.loading': '读取中…',
      'panel.error': '额度读取失败',
      'panel.errorHint': '请确认凭据 OPENCODE_GO_API_KEY 可用',
      'panel.retry': '重试',
      'panel.updated': '更新于 {time}',
      'panel.auto': '每 60 秒自动刷新',
      'panel.stale': '刷新失败，显示上次结果',
      'window.rolling': '滚动（5 小时）',
      'window.weekly': '每周',
      'window.monthly': '每月',
      'window.remaining': '剩余 {value}%',
      'window.used': '已用 {value}%',
      'window.reset': '{time} 重置',
      'window.unknown': '暂无数据',
      'window.status': '状态 {status}',
    }

    const en = {
      'chip.label': 'Go',
      'chip.title': 'OpenCode Go · 5h quota {remaining}% left',
      'chip.reset': 'resets {time}',
      'chip.resetSoon': 'resets soon',
      'chip.unknown': 'OpenCode Go quota',
      'panel.title': 'OpenCode Go quota',
      'panel.refresh': 'Refresh',
      'panel.close': 'Close',
      'panel.loading': 'Loading…',
      'panel.error': 'Could not read the quota',
      'panel.errorHint': 'Check that the OPENCODE_GO_API_KEY credential is available',
      'panel.retry': 'Retry',
      'panel.updated': 'Updated {time}',
      'panel.auto': 'Refreshes every 60s',
      'panel.stale': 'Refresh failed; showing the last result',
      'window.rolling': 'Rolling (5h)',
      'window.weekly': 'Weekly',
      'window.monthly': 'Monthly',
      'window.remaining': '{value}% left',
      'window.used': '{value}% used',
      'window.reset': 'resets {time}',
      'window.unknown': 'No data',
      'window.status': 'status {status}',
    }

    const DICTS = { zh, en }

    /**
     * Pick the dictionary for one active locale id.
     * @param localeId - the active locale id.
     * @returns the matching dictionary.
     */
    function dictOf(localeId) {
      return String(localeId === undefined || localeId === null ? '' : localeId).toLowerCase().startsWith('zh')
        ? zh
        : en
    }

    /**
     * Translate one key with `{name}` interpolation.
     * @param dict - the active dictionary.
     * @param key - dictionary key.
     * @param params - interpolation values.
     * @returns the translated text.
     */
    function translate(dict, key, params) {
      const template = dict[key] === undefined ? en[key] === undefined ? key : en[key] : dict[key]
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        params[name] === undefined ? match : String(params[name]),
      )
    }

    /**
     * Severity bucket for one remaining percentage.
     * @param remaining - remaining percentage, or null without data.
     * @returns the CSS bucket name.
     */
    function severityOf(remaining) {
      if (remaining === null) return 'idle'
      if (remaining < 10) return 'error'
      if (remaining < 30) return 'warn'
      return 'ok'
    }

    /**
     * Format one reset timestamp for the active locale.
     * @param iso - the upstream timestamp.
     * @param localeId - the active locale id.
     * @returns the formatted local date/time, or null when unusable.
     */
    function formatReset(iso, localeId) {
      if (typeof iso !== 'string') return null
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return null
      try {
        return new Intl.DateTimeFormat(dictOf(localeId) === zh ? 'zh-CN' : 'en-US', {
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(date)
      } catch {
        return date.toISOString()
      }
    }

    /**
     * Format one epoch millisecond as a local wall-clock time.
     * @param millis - epoch milliseconds.
     * @returns the local `HH:mm` text.
     */
    function formatTime(millis) {
      if (typeof millis !== 'number' || !Number.isFinite(millis)) return '—'
      try {
        return new Intl.DateTimeFormat(undefined, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(millis))
      } catch {
        return '—'
      }
    }

    /**
     * Format one reset timestamp as the short clock the chip shows beside the
     * percentage: `HH:mm` on the same day, `MM/DD HH:mm` otherwise.
     * @param iso - the upstream timestamp.
     * @param localeId - the active locale id.
     * @param now - current epoch milliseconds.
     * @returns the short local time, or null when unusable.
     */
    function formatResetClock(iso, localeId, now) {
      if (typeof iso !== 'string') return null
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return null
      const reference = new Date(typeof now === 'number' && Number.isFinite(now) ? now : Date.now())
      const sameDay =
        date.getFullYear() === reference.getFullYear() &&
        date.getMonth() === reference.getMonth() &&
        date.getDate() === reference.getDate()
      try {
        return new Intl.DateTimeFormat(dictOf(localeId) === zh ? 'zh-CN' : 'en-US', {
          ...(sameDay ? {} : { month: '2-digit', day: '2-digit' }),
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(date)
      } catch {
        return date.toISOString()
      }
    }

    /**
     * Summarize the windows as the chip previews them: the rolling (5-hour)
     * window only. It is the fastest window to refill, so it decides whether a
     * long session can keep going; the other windows stay in the popover.
     * @param windows - projected windows from the Host route, or null.
     * @returns the remaining percentage, its severity bucket and the reset time.
     */
    function summarize(windows) {
      const rolling = windows === null || windows === undefined ? null : windows.rolling
      const entry = rolling === null || typeof rolling !== 'object' ? {} : rolling
      const used = entry.usedPercent
      const remaining =
        typeof used === 'number' && Number.isFinite(used)
          ? Math.max(0, Math.min(100, 100 - used))
          : typeof entry.remainingPercent === 'number' && Number.isFinite(entry.remainingPercent)
            ? Math.max(0, Math.min(100, entry.remainingPercent))
            : null
      return {
        remaining: remaining === null ? null : Math.round(remaining),
        severity: severityOf(remaining),
        resetsAt: typeof entry.resetsAt === 'string' ? entry.resetsAt : null,
      }
    }

    /**
     * Project the windows into the rows the popover renders.
     * @param windows - projected windows from the Host route, or null.
     * @param t - active translate function.
     * @param localeId - active locale id (for reset-time formatting).
     * @returns one plain row model per window.
     */
    function rowModels(windows, t, localeId) {
      const rows = []
      if (windows === null || windows === undefined) return rows
      for (const key of WINDOW_KEYS) {
        const entry = windows[key] === undefined || windows[key] === null ? {} : windows[key]
        const hasRemaining = typeof entry.remainingPercent === 'number' && Number.isFinite(entry.remainingPercent)
        const hasUsed = typeof entry.usedPercent === 'number' && Number.isFinite(entry.usedPercent)
        const remaining = hasRemaining
          ? Math.max(0, Math.min(100, entry.remainingPercent))
          : hasUsed
            ? Math.max(0, Math.min(100, 100 - entry.usedPercent))
            : null
        const used = hasUsed ? Math.max(0, Math.min(100, entry.usedPercent)) : null
        rows.push({
          key,
          label: t(`window.${key}`),
          remainingText:
            remaining === null ? t('window.unknown') : t('window.remaining', { value: Math.round(remaining) }),
          usedText: used === null ? t('window.unknown') : t('window.used', { value: Math.round(used) }),
          resetText: formatReset(entry.resetsAt, localeId),
          statusText:
            entry.status !== undefined && entry.status !== 'ok' && entry.status !== 'unknown'
              ? t('window.status', { status: entry.status })
              : null,
          remaining,
          bucket: severityOf(remaining),
        })
      }
      return rows
    }

    /**
     * Render the window row models as popover rows.
     * @param models - row models from `rowModels`.
     * @param t - active translate function.
     * @returns one element per window.
     */
    function buildRowElements(models, t) {
      return models.flatMap((row, index) => {
        const element = h(
          'div',
          { key: row.key, className: 'oq-row' },
          h(
            'div',
            { className: 'oq-row-head' },
            h('span', { className: 'oq-k' }, row.label),
            h('span', { className: `oq-v oq-${row.bucket}` }, row.remainingText),
          ),
          h(
            'div',
            { className: 'oq-bar' },
            h('span', {
              className: `oq-bar-fill oq-${row.bucket}`,
              style: { width: row.remaining === null ? '0%' : `${Math.round(row.remaining)}%` },
            }),
          ),
          h(
            'div',
            { className: 'oq-sub' },
            row.usedText,
            row.resetText === null ? null : ` · ${t('window.reset', { time: row.resetText })}`,
            row.statusText === null ? null : ` · ${row.statusText}`,
          ),
        )
        return index === 0
          ? [element]
          : [h('div', { key: `sep-${row.key}`, className: 'oq-sep' }), element]
      })
    }

    /**
     * Build the popover body: window rows, the error state, or the first-load note.
     * @param options - windows, load phase, rendered rows, translate and retry.
     * @returns the body element.
     */
    function buildBody({ windows, phase, rows, t, onRetry }) {
      if (windows !== null) return rows
      if (phase === 'error') {
        return h(
          'div',
          { className: 'oq-note oq-error' },
          h('div', { className: 'oq-error-title' }, t('panel.error')),
          h('div', { className: 'oq-error-hint' }, t('panel.errorHint')),
          h('button', { type: 'button', className: 'oq-retry', onClick: onRetry }, t('panel.retry')),
        )
      }
      return h('div', { className: 'oq-note' }, t('panel.loading'))
    }

    /**
     * Build the anchored popover.
     * @param options - placement, snapshot facts, body, panel ref and controls.
     * @returns the panel element, or null before placement.
     */
    function buildPanel({
      t,
      placement,
      phase,
      refreshing,
      data,
      windows,
      body,
      panelRef,
      onRefresh,
      onClose,
    }) {
      if (placement === null) return null
      return h(
        'div',
        {
          key: 'panel',
          ref: panelRef,
          className: 'oq-panel',
          role: 'dialog',
          'aria-label': t('panel.title'),
          style: {
            left: `${placement.left}px`,
            bottom: `${placement.bottom}px`,
            width: `${placement.width}px`,
            maxHeight: `${placement.maxHeight}px`,
          },
        },
        h(
          'div',
          { className: 'oq-head' },
          h('span', { className: 'oq-title' }, t('panel.title')),
          h(
            'button',
            {
              type: 'button',
              className: 'oq-tool',
              title: t('panel.refresh'),
              'aria-label': t('panel.refresh'),
              disabled: refreshing,
              onClick: onRefresh,
            },
            '↻',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'oq-tool',
              title: t('panel.close'),
              'aria-label': t('panel.close'),
              onClick: onClose,
            },
            '×',
          ),
        ),
        h('div', { className: 'oq-body' }, body),
        h(
          'div',
          { className: 'oq-foot' },
          h(
            'span',
            null,
            phase === 'error' && windows !== null
              ? t('panel.stale')
              : data === null
                ? t('panel.loading')
                : t('panel.updated', { time: formatTime(data.fetchedAt) }),
          ),
          h('span', null, t('panel.auto')),
        ),
      )
    }

    /**
     * Build the chip component for one Client context.
     * @param ctx - the Client plugin context (locale service).
     * @returns the slot component.
     */
    function createChip(ctx) {
      const localeNow = () => ctx.locale.getSnapshot().active

      return function OpenCodeQuotaChip(props) {
        // Subscribe to the locale registry so the chip follows a language switch.
        const localeId = React.useSyncExternalStore(
          (onStoreChange) => ctx.locale.subscribe(onStoreChange),
          localeNow,
          localeNow,
        )
        const t = (key, params) => translate(dictOf(localeId), key, params)

        const [snapshot, setSnapshot] = React.useState({ phase: 'loading', data: null, refreshing: false })
        const [open, setOpen] = React.useState(false)
        const [placement, setPlacement] = React.useState(null)
        const buttonRef = React.useRef(null)
        const panelRef = React.useRef(null)
        const busyRef = React.useRef(false)

        /** Read the Host route; keep the last good data on failure. */
        const load = React.useCallback(() => {
          if (busyRef.current) return
          busyRef.current = true
          setSnapshot((previous) => ({ ...previous, refreshing: true }))
          fetch(ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } })
            .then(async (response) => {
              const payload = await response.json().catch(() => null)
              if (!response.ok || payload === null || payload.ok !== true) {
                throw new Error(`opencode-quota: HTTP ${response.status}`)
              }
              setSnapshot({ phase: 'ready', data: payload, refreshing: false })
            })
            .catch(() => {
              setSnapshot((previous) => ({
                phase: 'error',
                data: previous.data,
                refreshing: false,
              }))
            })
            .finally(() => {
              busyRef.current = false
            })
        }, [])

        React.useEffect(() => {
          load()
          const id = window.setInterval(load, open ? POLL_OPEN_MS : POLL_IDLE_MS)
          return () => window.clearInterval(id)
        }, [open, load])

        /** Anchor the popover above the chip, kept inside the viewport. */
        const place = React.useCallback(() => {
          const anchor = buttonRef.current
          if (anchor === null) return
          const rect = anchor.getBoundingClientRect()
          const width = Math.max(140, Math.min(PANEL_WIDTH, window.innerWidth - 16))
          const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
          setPlacement({
            left,
            bottom: Math.max(8, window.innerHeight - rect.top + 4),
            width,
            maxHeight: Math.max(120, Math.min(rect.top - 16, window.innerHeight - 24)),
          })
        }, [])

        React.useEffect(() => {
          if (!open) return undefined
          place()
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          const onPointerDown = (event) => {
            const panel = panelRef.current
            const anchor = buttonRef.current
            if (panel !== null && panel.contains(event.target)) return
            if (anchor !== null && anchor.contains(event.target)) return
            setOpen(false)
          }
          const onReposition = () => place()
          document.addEventListener('keydown', onKeyDown)
          document.addEventListener('mousedown', onPointerDown, true)
          window.addEventListener('resize', onReposition)
          window.addEventListener('scroll', onReposition, true)
          return () => {
            document.removeEventListener('keydown', onKeyDown)
            document.removeEventListener('mousedown', onPointerDown, true)
            window.removeEventListener('resize', onReposition)
            window.removeEventListener('scroll', onReposition, true)
          }
        }, [open, place])

        const data = snapshot.data
        const windows = data !== null && data.windows !== undefined && data.windows !== null ? data.windows : null
        const summary = summarize(windows)
        const rounded = summary.remaining
        const severity = summary.severity
        const narrow = props.wide === false
        const stale = snapshot.phase === 'error'
        const now = Date.now()
        const resetAt = summary.resetsAt === null ? Number.NaN : Date.parse(summary.resetsAt)
        const resetDue = Number.isFinite(resetAt) && resetAt <= now
        const resetClock = resetDue ? null : formatResetClock(summary.resetsAt, localeId, now)
        const resetText = resetDue
          ? t('chip.resetSoon')
          : resetClock === null
            ? null
            : t('chip.reset', { time: resetClock })
        const chipTitle =
          (rounded === null ? t('chip.unknown') : t('chip.title', { remaining: rounded })) +
          (resetText === null ? '' : ` · ${resetText}`) +
          (stale ? ` · ${t('panel.error')}` : '')
        // The 56px rail has no room for the label or the reset clock: keep the
        // ring, the tooltip and the popover, and drop the text.
        const chipText = narrow ? null : rounded === null ? t('chip.label') : `${t('chip.label')} ${rounded}%`

        const ringRadius = 6.2
        const ringLength = 2 * Math.PI * ringRadius
        const ringArc = rounded === null ? 0 : (rounded / 100) * ringLength
        const ring = h(
          'svg',
          {
            key: 'ring',
            className: 'oq-ring',
            viewBox: '0 0 16 16',
            width: 16,
            height: 16,
            'aria-hidden': 'true',
            focusable: 'false',
          },
          h('circle', {
            cx: 8,
            cy: 8,
            r: ringRadius,
            fill: 'none',
            stroke: 'currentColor',
            strokeOpacity: 0.2,
            strokeWidth: 2.2,
          }),
          h('circle', {
            cx: 8,
            cy: 8,
            r: ringRadius,
            fill: 'none',
            stroke: 'currentColor',
            strokeWidth: 2.2,
            strokeLinecap: 'round',
            strokeDasharray: `${ringArc} ${ringLength - ringArc}`,
            transform: 'rotate(-90 8 8)',
          }),
        )

        const chip = h(
          'button',
          {
            key: 'chip',
            ref: buttonRef,
            type: 'button',
            className: `oq-chip oq-${severity}${narrow ? ' oq-compact' : ''}`,
            title: chipTitle,
            'aria-label': chipTitle,
            'aria-haspopup': 'dialog',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => {
              if (!open) place()
              setOpen(!open)
            },
          },
          ring,
          chipText === null ? null : h('span', { className: 'oq-chip-text' }, chipText),
          resetText === null || narrow ? null : h('span', { className: 'oq-chip-reset' }, resetText),
        )

        const rows = buildRowElements(rowModels(windows, t, localeId), t)

        const body = buildBody({
          windows,
          phase: snapshot.phase,
          rows,
          t,
          onRetry: () => load(),
        })

        const panel = open
          ? buildPanel({
              t,
              placement,
              phase: snapshot.phase,
              refreshing: snapshot.refreshing,
              data,
              windows,
              body,
              panelRef,
              onRefresh: () => load(),
              onClose: () => setOpen(false),
            })
          : null

        return h(React.Fragment, null, h('style', { key: 'css' }, CSS), chip, panel)
      }
    }

    const CSS = `
@keyframes oq-in{from{opacity:0}to{opacity:1}}
.oq-chip{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:24px;max-width:min(160px,100%);padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .15s}
.oq-chip:hover{background-color:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary)}
.oq-chip:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.oq-chip.oq-ok .oq-ring{color:var(--dsw-alias-brand-primary)}
.oq-chip.oq-warn .oq-ring{color:var(--dsw-alias-state-warn-primary)}
.oq-chip.oq-error .oq-ring{color:var(--dsw-alias-state-error-primary)}
.oq-chip.oq-compact{width:24px;height:24px;padding:0;justify-content:center;gap:0}
.oq-chip-text{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums}
.oq-chip-reset{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;font-variant-numeric:tabular-nums}
.oq-ring{flex:none;display:block}
.oq-panel{position:fixed;z-index:1100;box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;isolation:isolate;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,#fff);border-radius:var(--dsw-radius-lg,16px);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px rgba(0,0,0,.16),0 3px 8px rgba(0,0,0,.04),0 0 20px rgba(0,0,0,.05));font-size:13px;line-height:20px;padding:4px;animation:oq-in 40ms ease-out}
@media (prefers-reduced-motion:reduce){.oq-panel{animation:none}}
.oq-head{display:flex;align-items:center;gap:6px;flex:0 0 auto;height:34px;padding:0 4px 0 8px;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.oq-title{flex:1 1 auto;min-width:0;font-size:13px;line-height:20px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.oq-tool{width:28px;height:28px;flex:none;display:inline-flex;align-items:center;justify-content:center;margin:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:15px;line-height:1;cursor:pointer}
.oq-tool:hover{background-color:var(--dsw-alias-interactive-bg-hover,#2631480f);color:var(--dsw-alias-label-primary)}
.oq-tool:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.oq-tool:disabled{opacity:.4;cursor:default}
.oq-body{flex:1 1 auto;min-height:0;overflow-y:auto;padding:0 0 4px}
.oq-row{display:flex;flex-direction:column;gap:6px;box-sizing:border-box;min-height:34px;padding:6px 8px}
.oq-sep{height:.5px;margin:3px 8px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
.oq-row-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.oq-k{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:nowrap}
.oq-v{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-weight:500;font-variant-numeric:tabular-nums;white-space:nowrap}
.oq-v.oq-warn{color:var(--dsw-alias-state-warn-primary)}
.oq-v.oq-error{color:var(--dsw-alias-state-error-primary)}
.oq-bar{position:relative;height:2px;border-radius:1px;overflow:hidden;background:var(--dsw-alias-bg-skeleton,rgba(0,0,0,.04))}
.oq-bar-fill{display:block;height:100%;border-radius:1px;background:var(--dsw-alias-brand-primary);transition:width .3s cubic-bezier(.4,0,.2,1)}
.oq-bar-fill.oq-warn{background:var(--dsw-alias-state-warn-primary)}
.oq-bar-fill.oq-error{background:var(--dsw-alias-state-error-primary)}
.oq-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;font-variant-numeric:tabular-nums}
.oq-note{padding:8px 8px 10px;color:var(--dsw-alias-label-secondary)}
.oq-error-title{color:var(--dsw-alias-state-error-primary);font-size:13px;line-height:20px;font-weight:500}
.oq-error-hint{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
.oq-retry{margin-top:10px;display:inline-flex;align-items:center;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.oq-retry:hover{background-color:var(--dsw-alias-interactive-bg-hover,#2631480f)}
.oq-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px 4px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px}
`

    /** Client plugin entry. */
    const inject = ['slots', 'locale']

    /**
     * Register one locale namespace and one sidebar-foot chip.
     * @param ctx - the Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'opencode-quota: dictionaries')
      const Chip = createChip(ctx)
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'opencode-quota',
            order: 10,
          },
          Chip,
        ),
      )
    }

    // Pure helpers are exported for the pack's own tests; the module loader
    // only reads `apply` and `inject`.
    return {
      apply,
      inject,
      _internals: { translate, dictOf, severityOf, summarize, rowModels, buildRowElements, buildBody, buildPanel, formatReset, formatResetClock, formatTime },
    }
  },
})
