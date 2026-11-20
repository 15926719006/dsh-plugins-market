/**
 * Browser half of `@local/dsh-autocomplete`.
 *
 * Draws the Codex-style hint **inside** the composer card: the sentence the Host
 * predicted for the conversation is painted at the text origin of the message
 * box, in the placeholder's own colour and metrics, so it reads as ghost text
 * rather than as another row of chrome. Nothing enters the draft until the user
 * accepts:
 *
 * - `Tab`, or a click on the hint, replaces the (empty) draft with the
 *   suggestion through the composer's own `inputActions.setDraft` when the slot
 *   exposes it, and through the browser's insert-text command otherwise;
 * - typing, sending, or a newer turn hides the previous hint;
 * - switching conversations drops the previous hint immediately and asks the
 *   Host for that conversation's own prediction.
 *
 * The ghost is painted over the composer's placeholder, which this module hides
 * for as long as the ghost is visible and restores afterwards.
 *
 * @module @local/dsh-autocomplete
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-autocomplete',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    /** Host route publishing the prediction for one session. */
    const STATE = '/plugins/autocomplete/state'

    /** Poll period for the Host prediction while the page is visible. */
    const POLL_MS = 1200

    /** Poll period for the composer's geometry and emptiness. */
    const DRAFT_MS = 300

    /** Slot hosting floating entries inside the resident composer card. */
    const SLOT = 'conversation.input.overlay'

    /** Diagnostic route: how an accept attempt actually resolved in this page. */
    const TAP = '/plugins/autocomplete/tap'

    const zh = { tab: 'Tab', accept: '补全', tap: '填入', acceptTitle: '把这句话填进输入框（不会发送）' }
    const en = { tab: 'Tab', accept: 'to fill', tap: 'Fill', acceptTitle: 'Fill this sentence into the message box (it does not send)' }

    /**
     * Is this a touch-first device without a hardware Tab key?
     * @returns true when the primary pointer is coarse.
     */
    function touchFirst() {
      try {
        return window.matchMedia('(pointer: coarse)').matches
      } catch {
        return false
      }
    }

    /**
     * Pick the dictionary matching the page language.
     * @returns the active dictionary.
     */
    function dict() {
      const declared = typeof document === 'undefined' ? '' : String(document.documentElement?.lang ?? '')
      const isChinese = declared.length > 0
        ? declared.toLowerCase().startsWith('zh')
        : String(navigator.language ?? '').toLowerCase().startsWith('zh')
      return isChinese ? zh : en
    }

    /**
     * The composer's plain-text editor, when the page currently has one.
     * @returns the editor element, or undefined.
     */
    function composerEditor() {
      const editors = document.querySelectorAll('[contenteditable="true"]')
      return editors.length === 0 ? undefined : editors[editors.length - 1]
    }

    /**
     * Is the focused element a plain-text editor the user is typing into?
     * @returns true when a composer editor holds the focus.
     */
    function editingDraft() {
      const active = document.activeElement
      if (active === null || active === undefined) return false
      if (active.tagName === 'TEXTAREA') return true
      const editable = active.getAttribute?.('contenteditable')
      if (editable !== 'true' && editable !== '') return false
      const editor = composerEditor()
      return editor === undefined || active === editor || editor.contains(active)
    }

    /**
     * Measure where the composer's first text line starts and how it is drawn.
     * @returns geometry and typography, or undefined without a composer.
     */
    function composerMetrics() {
      const editor = composerEditor()
      if (editor === undefined) return undefined
      const style = getComputedStyle(editor)
      const rect = editor.getBoundingClientRect()
      const paddingLeft = Number.parseFloat(style.paddingLeft) || 0
      const paddingTop = Number.parseFloat(style.paddingTop) || 0
      const placeholder = editor.parentElement?.querySelector('[class*="placeholder"]') ?? undefined
      const placeholderStyle = placeholder === undefined ? undefined : getComputedStyle(placeholder)
      return {
        editor,
        placeholder,
        x: rect.left + paddingLeft,
        y: rect.top + paddingTop,
        width: rect.width - paddingLeft - (Number.parseFloat(style.paddingRight) || 0),
        font: style.font,
        lineHeight: style.lineHeight === 'normal' ? '24px' : style.lineHeight,
        color: placeholderStyle?.color ?? 'rgb(173,178,184)',
        empty: String(editor.textContent ?? '').trim().length === 0,
      }
    }

    /**
     * Hide the composer's placeholder while a ghost line occupies its place.
     * @param placeholder - the placeholder element, when present.
     * @returns a function restoring the previous visibility.
     */
    function concealPlaceholder(placeholder) {
      if (placeholder === undefined || placeholder === null) return () => {}
      const previous = placeholder.style.visibility
      placeholder.style.visibility = 'hidden'
      return () => {
        placeholder.style.visibility = previous
      }
    }

    /**
     * The inline ghost.
     * @param props - the slot's standard props.
     * @returns the ghost element, or null.
     */
    function SuggestionGhost(props) {
      const sessionId = props?.sessionId
      const actions = props?.inputActions
      const [state, setState] = useState(null)
      const [placement, setPlacement] = useState(undefined)
      const [empty, setEmpty] = useState(true)
      const acceptedFor = useRef(null)
      const originRef = useRef(null)
      const justSentUntil = useRef(0)
      const wasEmpty = useRef(true)

      useEffect(() => {
        setState(null)
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
        let stopped = false
        let timer
        /**
         * Poll forever, never stop on a ready answer: a turn starting later must
         * be able to take the hint away again. Short backoff while a hint is
         * visible so a new turn clears it within a second.
         */
        const poll = async () => {
          let delay = POLL_MS
          try {
            const response = await fetch(`${STATE}?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store' })
            if (response.ok) {
              const next = await response.json()
              if (!stopped) setState(next)
              if (next?.status === 'pending') delay = POLL_MS
              else if (next?.status === 'ready') delay = 700
              else if (next?.status === 'running') delay = 800
              else delay = POLL_MS * 2
            }
          } catch {
            // A Host that is restarting simply keeps the previous hint.
          }
          if (!stopped) timer = setTimeout(poll, delay)
        }
        void poll()
        return () => {
          stopped = true
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [sessionId])

      useEffect(() => {
        const tick = () => {
          const next = composerMetrics()
          const nowEmpty = next === undefined ? true : next.empty
          // A draft that just became empty was sent: do not flash a stale hint.
          if (nowEmpty && wasEmpty.current === false) justSentUntil.current = Date.now() + 2000
          wasEmpty.current = nowEmpty
          setEmpty(nowEmpty)
          const origin = originRef.current
          if (next === undefined || origin === null) {
            setPlacement(undefined)
            return
          }
          const base = origin.getBoundingClientRect()
          setPlacement({
            placeholder: next.placeholder,
            x: next.x - base.left,
            y: next.y - base.top,
            width: next.width,
            font: next.font,
            color: next.color,
          })
        }
        tick()
        const timer = setInterval(tick, DRAFT_MS)
        const onScroll = () => tick()
        window.addEventListener('scroll', onScroll, true)
        window.addEventListener('resize', onScroll)
        // A software keyboard moves the visual viewport without resizing the window.
        const viewport = window.visualViewport
        viewport?.addEventListener('resize', onScroll)
        viewport?.addEventListener('scroll', onScroll)
        return () => {
          clearInterval(timer)
          window.removeEventListener('scroll', onScroll, true)
          window.removeEventListener('resize', onScroll)
          viewport?.removeEventListener('resize', onScroll)
          viewport?.removeEventListener('scroll', onScroll)
        }
      }, [])

      const text = typeof state?.text === 'string' ? state.text.trim() : ''
      const ready = state?.status === 'ready' && text.length > 0 && state?.running !== true
      const visible = ready && empty && placement !== undefined && placement.width > 40
      const token = `${sessionId ?? ''}:${state?.updatedAt ?? 0}`
      const words = dict()
      const tapMode = touchFirst()

      useEffect(() => {
        if (!visible || placement === undefined) return undefined
        return concealPlaceholder(placement.placeholder)
      }, [visible, placement?.placeholder])

      const accept = useCallback(() => {
        if (!ready) return
        const report = (detail) => {
          try {
            void fetch(TAP, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionId, tapMode: touchFirst(), ...detail }),
              keepalive: true,
            }).catch(() => {})
          } catch {
            // Diagnostics never block the accept path.
          }
        }
        const viaActions = typeof actions?.setDraft === 'function'
        if (viaActions) {
          actions.setDraft(text)
        } else if (editingDraft()) {
          document.execCommand('insertText', false, text)
        } else {
          report({ stage: 'no-writer', hasActions: viaActions, focused: editingDraft() })
          return
        }
        setTimeout(() => {
          const editor = composerEditor()
          report({ stage: 'accepted', hasActions: viaActions, draftLength: String(editor?.textContent ?? '').length })
        }, 250)
        acceptedFor.current = token
        setState((previous) => (previous === null ? previous : { ...previous, status: 'accepted', text: null }))
      }, [actions, ready, text, token])

      useEffect(() => {
        const onKeyDown = (event) => {
          if (!ready) return
          if (event.key !== 'Tab' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
          if (event.isComposing) return
          if (!editingDraft()) return
          const current = composerMetrics()
          if (current === undefined || !current.empty) return
          event.preventDefault()
          accept()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [ready, accept])

      const origin = React.createElement('div', {
        ref: originRef,
        'data-autocomplete-origin': '',
        style: { position: 'absolute', left: 0, top: 0, width: 0, height: 0, pointerEvents: 'none' },
      })

      const suppressed = Date.now() < justSentUntil.current
      if (!visible || suppressed || placement === undefined || acceptedFor.current === token) return origin

      const textLayer = React.createElement('div', {
        'data-plugin': 'autocomplete',
        className: 'dsh-autocomplete',
        style: {
          position: 'absolute',
          left: `${placement.x}px`,
          top: `${placement.y}px`,
          /* On touch, leave room for the sibling accept control. */
          width: `${tapMode ? Math.max(80, placement.width - 68) : placement.width}px`,
          height: '24px',
          /* The composer's editor is a later sibling and covers this overlay for
             hit-testing, so lift the ghost into the card's stacking context. */
          zIndex: 5,
          font: placement.font,
          lineHeight: '24px',
          color: placement.color,
          pointerEvents: 'none',
        },
      }, React.createElement('span', { className: 'dsh-autocomplete__text' }, text))

      // The accept control is a SIBLING of the text layer, never a child: Safari
      // does not deliver taps to an `auto` element inside a `none` ancestor.
      const acceptControl = tapMode
        ? React.createElement('button', {
          type: 'button',
          'data-plugin': 'autocomplete-accept',
          className: 'dsh-autocomplete__accept',
          title: words.acceptTitle,
          onPointerDown: (event) => {
            event.preventDefault()
            event.stopPropagation()
            accept()
          },
          onClick: (event) => {
            event.preventDefault()
            accept()
          },
          style: {
            position: 'absolute',
            left: `${placement.x + placement.width - 56}px`,
            top: `${placement.y - 6}px`,
            zIndex: 6,
            pointerEvents: 'auto',
          },
        }, words.tap)
        : null

      return React.createElement(React.Fragment, null, origin, textLayer, acceptControl)
    }

    /** Scoped styles; removed with the component. */
    function Styles() {
      return React.createElement('style', null, `
        .dsh-autocomplete {
          display: flex; align-items: center; gap: 8px;
          min-width: 0; user-select: none;
        }
        .dsh-autocomplete__text {
          flex: 1 1 auto; min-width: 0;
          overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
        }
        .dsh-autocomplete__accept {
          display: inline-flex; align-items: center; justify-content: center;
          height: 32px; min-width: 52px; padding: 0 12px; border-radius: 10px;
          cursor: pointer; font-size: 12.5px; line-height: 1;
          color: var(--dsw-alias-label-secondary, #6f6f6f);
          background: var(--dsw-alias-bg-elevated, rgba(127,127,127,.10));
          border: 1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.22));
          touch-action: manipulation; -webkit-tap-highlight-color: transparent;
        }
        .dsh-autocomplete__accept:active { filter: brightness(0.96); }
        .dsh-autocomplete__key {
          font: inherit; font-size: 10px;
          padding: 2px 4px; border-radius: 4px;
          background: var(--dsw-alias-bg-base, rgba(127,127,127,.14));
        }
      `)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register({ name: SLOT, id: 'autocomplete', order: 40 }, (props) =>
            React.createElement(
              React.Fragment,
              null,
              React.createElement(Styles, null),
              React.createElement(SuggestionGhost, props),
            )),
        )
      },
    }
  },
})
