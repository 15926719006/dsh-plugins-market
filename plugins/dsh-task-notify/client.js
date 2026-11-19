/**
 * Browser half of `@local/dsh-task-notify`.
 *
 * Subscribes to the Host's Server-Sent Events stream
 * (`GET /plugins/task-notify/events`) and turns every record into a native macOS
 * notification, attributed to this app. Nothing is drawn on the page: the
 * system notification is the whole message.
 *
 * A record becomes exactly one system notification: no in-page banner, no
 * custom toast, nothing drawn anywhere in the app.
 *
 * Clicking a notification selects the Session that produced it, so the window
 * that comes forward shows the conversation that finished instead of whichever
 * one happened to be open. A browser notification carries that click directly;
 * a card the Host posted through `osascript` has no click action, so the same
 * navigation happens on the next activation of this window, which is what
 * clicking the card does.
 *
 * When the browser refuses notifications the Host posts the same record through
 * macOS Notification Center instead, so the page only reports its permission
 * and stays out of the way.
 *
 * @module @local/dsh-task-notify
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-task-notify',
  factory(require) {
    /** Event stream published by the Host half. */
    const EVENTS = '/plugins/task-notify/events'

    /** Handshake that tells the Host what this page may do. */
    const HELLO = '/plugins/task-notify/hello'

    /** Manual trigger, kept for verification. */
    const TEST = '/plugins/task-notify/test?force=1'

    /** Delay before rebuilding a stream the Host closed underneath us. */
    const RECONNECT_MS = 3000

    /**
     * How long a card the Host posted itself stays clickable.
     *
     * Such a card only reaches this page as the window coming to the front, so
     * a stale record would otherwise pull the user into an old Session the next
     * time the window is activated for an unrelated reason.
     */
    const ACTIVATE_WINDOW_MS = 10 * 60 * 1000

    /**
     * Identity of this page inside the Host's per-page permission table.
     *
     * Several windows can watch one Host, and only some of them may be allowed
     * to show browser notifications; the Host needs to tell them apart to know
     * whether it still has to post a card of its own.
     */
    const PAGE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

    const zh = {
      completed: '任务完成',
      error: '任务出错',
      aborted: '任务已中止',
      interrupted: '任务被打断',
      'max-tokens': '任务到达长度上限',
      blocked: '任务被阻塞',
      question: '需要你回答',
      approval: '需要你审批',
      unknown: '任务有新进展',
      waiting: '有一个操作在等你处理。',
    }

    const en = {
      completed: 'Task finished',
      error: 'Task failed',
      aborted: 'Task stopped',
      interrupted: 'Task interrupted',
      'max-tokens': 'Task hit the length limit',
      blocked: 'Task blocked',
      question: 'Your answer is needed',
      approval: 'Your approval is needed',
      unknown: 'Task has an update',
      waiting: 'Something is waiting for you.',
    }

    /**
     * Pick the language this page is actually rendered in.
     *
     * The page's own `lang` attribute is authoritative: this app can run with a
     * Chinese UI on an English macOS, and `navigator.language` follows the OS.
     * @returns `'zh'` or `'en'`.
     */
    function activeLanguage() {
      const declared =
        typeof document === 'undefined' || document.documentElement === null
          ? ''
          : String(document.documentElement.lang === undefined ? '' : document.documentElement.lang)
      if (declared.length > 0) return declared.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      const candidates = []
      const languages = navigator.languages === undefined ? [] : Array.from(navigator.languages)
      for (const language of languages) candidates.push(language)
      if (navigator.language !== undefined) candidates.push(navigator.language)
      const chinese = candidates.find((candidate) => String(candidate).toLowerCase().startsWith('zh'))
      return chinese === undefined ? 'en' : 'zh'
    }

    /**
     * Pick the dictionary matching the page language.
     * @returns the active dictionary.
     */
    function dict() {
      return activeLanguage() === 'zh' ? zh : en
    }

    /**
     * The Session identity a record points at.
     * @param record - the Host record.
     * @returns the id, or an empty string when the record names none.
     */
    function sessionIdOf(record) {
      const value = record !== null && typeof record === 'object' ? record.sessionId : undefined
      return typeof value === 'string' ? value.trim() : ''
    }

    /**
     * Compose one notification's title and body.
     * @param record - the Host record.
     * @returns `{ title, body }`.
     */
    function compose(record) {
      const words = dict()
      const kind = typeof record.kind === 'string' ? record.kind : 'unknown'
      const label = words[kind] === undefined ? words.unknown : words[kind]
      const waiting = kind === 'question' || kind === 'approval'
      const body = typeof record.body === 'string' ? record.body.trim() : ''
      const sessionTitle = typeof record.title === 'string' ? record.title.trim() : ''
      const title = sessionTitle.length > 0 ? `${label} · ${sessionTitle}` : label
      if (waiting) return { title, body: body.length > 0 ? body : words.waiting }
      return { title, body }
    }

    /**
     * Report this page's notification permission to the Host.
     */
    function report() {
      const permission =
        typeof Notification === 'undefined' ? 'unsupported' : String(Notification.permission)
      try {
        fetch(HELLO, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ permission, page: PAGE, lang: activeLanguage() }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        // The stream keeps working even if the handshake does not.
      }
    }

    /**
     * Ask for permission once when the browser has not decided yet.
     */
    function requestOnce() {
      if (typeof Notification === 'undefined') return
      if (Notification.permission !== 'default') return
      try {
        const pending = Notification.requestPermission()
        if (pending !== undefined && typeof pending.then === 'function') {
          pending.then(() => report()).catch(() => {})
        }
      } catch {
        // Older Electron builds only offer the callback form.
      }
    }

    /**
     * Select one Session in this page, exactly as clicking its sidebar row does.
     *
     * Navigation belongs to the Workspace layer, so this asks for the
     * `uiWorkspace` service rather than moving any state of its own. A Session
     * another window has just created may not be in this page's catalog yet;
     * that one failure is worth one refresh and retry instead of a dead click.
     * @param ctx - the Client plugin context.
     * @param sessionId - identity carried by the record.
     */
    function openSession(ctx, sessionId) {
      const id = sessionIdOf({ sessionId })
      if (id.length === 0) return
      const open = () => {
        const workspace = ctx.get('uiWorkspace')
        if (workspace === undefined || typeof workspace.openSession !== 'function') return false
        workspace.openSession(id)
        return true
      }
      try {
        if (open()) return
      } catch {
        const sessions = ctx.get('sessions')
        if (sessions === undefined || typeof sessions.refresh !== 'function') return
        sessions
          .refresh()
          .then(() => {
            try {
              open()
            } catch {
              // The Host no longer lists that Session; leave the view alone.
            }
          })
          .catch(() => {})
      }
    }

    /**
     * Show one record as a native notification, or leave it to the Host.
     *
     * A record the Host posted itself (`record.native`) must not become a second
     * browser card: the page only remembers which Session that card is about.
     * @param record - the Host record.
     * @param hooks - where a click and an activation lead.
     */
    function present(record, hooks) {
      const { title, body } = compose(record)
      const sessionId = sessionIdOf(record)
      const canNotify = typeof Notification !== 'undefined' && Notification.permission === 'granted'
      if (record.native !== true && canNotify) {
        try {
          const notification = new Notification(title, {
            body,
            // One card per Session: a later completion in another Session must
            // not replace the card that points at a different conversation.
            tag: `dsh-task-notify:${sessionId.length === 0 ? 'any' : sessionId}`,
          })
          notification.onclick = () => {
            hooks.focusWindow()
            hooks.navigate(sessionId)
            try {
              notification.close()
            } catch {
              // Closing is a courtesy; the navigation already happened.
            }
          }
          return
        } catch {
          // A refused notification must never break the page; the Host's
          // osascript fallback covers the case where nothing can be shown.
        }
      }
      hooks.remember(sessionId)
    }

    /** Client plugin entry; it renders nothing and only listens. */
    const inject = []

    /**
     * Start the event stream and the permission handshake.
     * @param ctx - the Client plugin context.
     */
    function apply(ctx) {
      requestOnce()
      report()

      /** @type {EventSource | undefined} */
      let source
      /** @type {number | undefined} */
      let retry
      /** Session a Host-posted card points at, waiting for this window to come forward. */
      let pending

      /** Is this page in front, so the user is already looking at it? */
      const inFront = () =>
        typeof document === 'undefined' ||
        (document.visibilityState !== 'hidden' && document.hasFocus())

      /**
       * Hold a Session for the activation that clicking a card causes.
       * @param sessionId - Session the card is about.
       */
      const remember = (sessionId) => {
        if (typeof sessionId !== 'string' || sessionId.length === 0) return
        // A visible, focused window is never activated by a card click; a target
        // remembered here would hijack the next unrelated focus instead.
        if (inFront()) return
        pending = { sessionId, at: Date.now() }
      }

      /** Follow the remembered card once this window is in front again. */
      const flush = () => {
        const target = pending
        if (target === undefined || target === null) return
        if (Date.now() - target.at > ACTIVATE_WINDOW_MS) {
          pending = undefined
          return
        }
        if (!inFront()) return
        pending = undefined
        openSession(ctx, target.sessionId)
      }

      // The Host closes this stream when the plugin row is unloaded (an
      // upgrade, a reinstall, a profile edit). EventSource only retries
      // connection failures, so rebuild it ourselves after a real close.
      const connect = () => {
        source = new EventSource(`${EVENTS}?page=${PAGE}`)
        source.onmessage = (message) => {
          try {
            present(JSON.parse(message.data), {
              focusWindow: () => {
                try {
                  window.focus()
                } catch {
                  // Focus is a best effort.
                }
              },
              navigate: (sessionId) => openSession(ctx, sessionId),
              remember,
            })
          } catch {
            // One malformed record never stops the stream.
          }
        }
        // A fresh Host instance starts with no idea what this page may do.
        source.onopen = () => report()
        source.onerror = () => {
          report()
          if (source !== undefined && source.readyState === EventSource.CLOSED) {
            source.close()
            if (retry !== undefined) clearTimeout(retry)
            retry = window.setTimeout(connect, RECONNECT_MS)
          }
        }
      }
      connect()

      ctx.effect(
        () => {
          window.addEventListener('focus', flush)
          const onVisibility = () => {
            if (document.visibilityState !== 'hidden') flush()
          }
          document.addEventListener('visibilitychange', onVisibility)
          return () => {
            window.removeEventListener('focus', flush)
            document.removeEventListener('visibilitychange', onVisibility)
          }
        },
        'task-notify: card navigation',
      )

      ctx.effect(
        () => () => {
          if (retry !== undefined) clearTimeout(retry)
          if (source !== undefined) source.close()
        },
        'task-notify: stream teardown',
      )

      ctx.effect(
        () => {
          window.__dshTaskNotifyTest = () => {
            fetch(TEST, { method: 'POST' }).catch(() => {})
          }
          return () => {
            delete window.__dshTaskNotifyTest
          }
        },
        'task-notify: manual trigger',
      )
    }

    return { inject, apply, _internals: { compose, dict, sessionIdOf, present, openSession } }
  },
})
