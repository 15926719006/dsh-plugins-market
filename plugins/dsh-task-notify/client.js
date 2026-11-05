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
      if (waiting) {
        return { title: label, body: body.length > 0 ? body : words.waiting }
      }
      return { title: sessionTitle.length > 0 ? `${label} · ${sessionTitle}` : label, body }
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
          body: JSON.stringify({ permission }),
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
     * Show one record as a native notification.
     * @param record - the Host record.
     */
    function present(record) {
      const { title, body } = compose(record)
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      try {
        const notification = new Notification(title, { body, tag: 'dsh-task-notify' })
        notification.onclick = () => {
          try {
            window.focus()
          } catch {
            // Focus is a best effort.
          }
          notification.close()
        }
      } catch {
        // A refused notification must never break the page; the Host's
        // osascript fallback covers the case where nothing can be shown.
      }
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

      // The Host closes this stream when the plugin row is unloaded (an
      // upgrade, a reinstall, a profile edit). EventSource only retries
      // connection failures, so rebuild it ourselves after a real close.
      const connect = () => {
        source = new EventSource(EVENTS)
        source.onmessage = (message) => {
          try {
            present(JSON.parse(message.data))
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
        () => () => {
          if (retry !== undefined) clearTimeout(retry)
          if (source !== undefined) source.close()
        },
        'task-notify: stream teardown',
      )

      ctx.effect(
        () => () => {
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

    return { inject, apply, _internals: { compose, dict } }
  },
})
