/**
 * Client half of `@local/session-rename`.
 *
 * Adds a hover action to every Session row in the sidebar: one click asks the
 * Host to summarize the whole conversation into a one-line title and rename the
 * Session in place. A small toast at the top center reports the outcome.
 *
 * Loaded by the shell's dynamic ModuleLoader, so this file only relies on
 * `react` and the official UI primitives; it reuses the official list slot
 * `sidebar.workspaces.session.row.action` instead of forking the sidebar.
 */
window.__ModuleLoader__.load({
  id: '@local/session-rename',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const {
      Tooltip,
      Switch,
      SettingsForm,
      Tag,
      IconSparkleRegular,
      IconCheckOutlineRegular,
      IconWarningOutlineRegular,
    } = require('@deepseek-ai/dsh-client-ui-primitives');

    /** Locale namespace shared with the Host half's dictionaries. */
    const NS = 'session-rename';
    /** Same-origin Host route, registered by this bundle's Host half. */
    const ROUTE = '/api/session-rename';
    /** How long the success check stays on the button before returning to idle. */
    const DONE_MS = 1500;
    /** How long a toast stays before it dismisses itself. */
    const TOAST_MS = 3000;
    /** Client-side ceiling, slightly longer than the Host's own 30s deadline. */
    const REQUEST_TIMEOUT_MS = 45000;

    const ZH = {
      'action.tip': '总结并重命名',
      'action.aria': '总结当前任务并重命名会话',
      'toast.renamed': '已重命名为「{title}」',
      'toast.failed': '总结失败：{message}',
      'toast.network': '网络错误，请稍后重试',
      'toast.unknown': '未知错误',
      'error.sessionMissing': '找不到这个会话，可能已被删除，刷新页面后再试',
      'error.noMessages': '这个会话还没有用户消息，暂时无法总结',
      'error.noRoute': '这个会话还没有可用的模型路由，先发一条消息再试',
      'error.modelError': '模型调用失败，请重试',
      'error.emptyTitle': '模型没有输出可用的标题，请重试',
      'error.timeout': '总结超时，请稍后重试',
      'error.cancelled': '总结已取消，请重试',
      'error.busy': '这个会话正在总结中，请稍候再试',
      'error.unavailable': '这个会话由子智能体管理，暂时无法重命名',
      'error.locked': '这个会话正被另一处占用，暂时无法重命名',
    };

    /** Bundle-page configuration copy; merged into the namespace dictionaries. */
    const CONFIG_ZH = {
      'config.heading': '功能开关',
      'config.description':
        '开启后，含 devops 链接的会话点「总结并重命名」时，标题会变成「编号 平台标题｜总结」，例如「RO-20261027-008 收银台倒计时修复｜修复跳转」。只对对话里出现 devops 链接的会话生效；没有链接、没有凭据或查不到平台记录时，退回普通总结。',
      'config.toggleLabel': '标题带 devops 编号前缀',
      'config.toggleHint':
        '按 profile 保存，对所有浏览器生效；保存后立即生效，不需要重启 DSH。标题上限已按本部署放宽，侧栏会截断显示，悬停可看全文（当前值见下方状态）。',
      'config.summary': '控制总结重命名生成的新标题是否带 devops 编号前缀。',
      'config.readOnly': '本部署的设置为只读。',
      'config.unavailable': '该插件当前未加载，暂时无法配置。',
      'config.loading': '正在读取配置…',
      'config.save': '保存',
      'config.saving': '保存中…',
      'config.saveFailed': '保存失败，设置没有写入；请稍后重试。',
      'config.overridden': '已覆盖',
      'config.reset': '恢复默认',
      'config.applied': '已保存',
      'config.credentials.ok': '已检测到 devops 凭据：{source}',
      'config.credentials.missing':
        '未检测到 devops 凭据：开启后不会加前缀。请配置 ~/.config/agents/credentials/devops.json，或设置 DEVOPS_TOKEN。',
      'config.credentials.unknown': '暂时无法读取 devops 凭据状态。',
      'config.budget': '当前标题预算：{bytes} 字节',
    };

    const CONFIG_EN = {
      'config.heading': 'Feature switch',
      'config.description':
        'When on, a Session whose conversation contains a devops link gets "number platform title｜summary" as its title when you click Summarize & rename, e.g. "RO-20261027-008 Fix checkout countdown｜Fix redirect". Sessions without a devops link, without credentials, or whose record cannot be read fall back to the plain summary.',
      'config.toggleLabel': 'Prefix titles with the devops number',
      'config.toggleHint':
        'Stored in this profile for every browser and applied immediately after saving — no DSH restart needed. The title budget is widened for this deployment; the sidebar truncates the display and hover shows it in full (see the status line below).',
      'config.summary': 'Whether generated titles carry the devops number prefix.',
      'config.readOnly': 'This deployment stores settings read-only.',
      'config.unavailable': 'This plugin is not loaded, so it cannot be configured right now.',
      'config.loading': 'Reading configuration…',
      'config.save': 'Save',
      'config.saving': 'Saving…',
      'config.saveFailed': 'The deployment did not accept the change; nothing was written. Try again.',
      'config.overridden': 'Overridden',
      'config.reset': 'Reset to default',
      'config.applied': 'Saved',
      'config.credentials.ok': 'devops credential found: {source}',
      'config.credentials.missing':
        'No devops credential found, so no prefix will be added. Configure ~/.config/agents/credentials/devops.json or set DEVOPS_TOKEN.',
      'config.credentials.unknown': 'The devops credential status could not be read.',
      'config.budget': 'Current title budget: {bytes} bytes',
    };

    const EN = {
      'action.tip': 'Summarize & rename',
      'action.aria': 'Summarize this task and rename the Session',
      'toast.renamed': 'Renamed to “{title}”',
      'toast.failed': 'Summarize failed: {message}',
      'toast.network': 'Network error. Please try again.',
      'toast.unknown': 'Unknown error',
      'error.sessionMissing': 'This Session could not be found; it may have been deleted. Reload the page and try again.',
      'error.noMessages': 'This Session has no user message yet, so there is nothing to summarize.',
      'error.noRoute': 'This Session has no model route yet. Send one message and try again.',
      'error.modelError': 'The model call failed. Please try again.',
      'error.emptyTitle': 'The model returned no usable title. Please try again.',
      'error.timeout': 'Summarizing timed out. Please try again later.',
      'error.cancelled': 'Summarizing was cancelled. Please try again.',
      'error.busy': 'This Session is already being summarized. Please wait and try again.',
      'error.unavailable': 'This Session is managed by a subagent and cannot be renamed right now.',
      'error.locked': 'This Session is held elsewhere and cannot be renamed right now.',
    };

    /**
     * Row-button and toast styles. The button matches the official row hover
     * actions (24px hit area, 14px icon, transparent background, currentColor),
     * and the toast borrows the host's own toast and shadow tokens.
     */
    const CSS = [
      '.dsh-session-rename__button{box-sizing:border-box;',
      'display:inline-flex;align-items:center;justify-content:center;',
      'flex:none;width:24px;height:24px;margin:-4px;padding:0;',
      'border:none;border-radius:var(--dsw-radius-xs);background:0 0;',
      'color:var(--dsw-alias-label-tertiary);cursor:pointer;}',
      '.dsh-session-rename__button:focus-visible{',
      'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));',
      'outline-offset:-2px;}',
      '@media (hover:hover){',
      '.dsh-session-rename__button:hover{color:var(--dsw-alias-label-primary);}}',
      '.dsh-session-rename__button:disabled{cursor:default;}',
      '.dsh-session-rename__button--done:disabled{',
      'color:var(--dsw-alias-state-success-primary);}',
      '.dsh-session-rename__spin{',
      'animation:dsh-session-rename-spin .9s linear infinite;}',
      '@keyframes dsh-session-rename-spin{',
      'from{transform:rotate(0deg);}to{transform:rotate(360deg);}}',
      '.dsh-session-rename__toast{position:fixed;top:16px;left:50%;',
      'transform:translateX(-50%);',
      'z-index:1100;box-sizing:border-box;display:flex;align-items:center;',
      'gap:10px;max-width:min(420px,calc(100vw - 32px));padding:10px 14px;',
      'border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-toast-bg);',
      'color:var(--dsw-alias-toast-label);font-size:13px;line-height:20px;',
      'box-shadow:var(--dsw-shadow-lv3);pointer-events:none;',
      'animation:dsh-session-rename-toast-in .16s ease-out;}',
      '.dsh-session-rename__toast-icon{display:grid;place-items:center;flex:none;}',
      '.dsh-session-rename__toast--success .dsh-session-rename__toast-icon{',
      'color:var(--dsw-alias-state-success-primary);}',
      '.dsh-session-rename__toast--error .dsh-session-rename__toast-icon{',
      'color:var(--dsw-alias-state-error-primary);}',
      '.dsh-session-rename__toast-text{min-width:0;overflow-wrap:anywhere;}',
      '@keyframes dsh-session-rename-toast-in{',
      'from{opacity:0;transform:translate(-50%,-4px);}to{opacity:1;transform:translate(-50%,0);}}',
      '@media (prefers-reduced-motion:reduce){',
      '.dsh-session-rename__spin{animation:none;}',
      '.dsh-session-rename__toast{animation:none;}}',
    ].join('');

    /** Bundle-page styles; appended to the plugin stylesheet. */
    const CONFIG_CSS = [
      '.dsh-session-rename__cfg{display:flex;flex-direction:column;gap:12px;',
      'color:var(--dsw-alias-label-primary);}',
      '.dsh-session-rename__cfgHeading{margin:0;font-size:14px;font-weight:500;',
      'line-height:20px;}',
      '.dsh-session-rename__cfgDesc{margin:0;color:var(--dsw-alias-label-secondary);',
      'font-size:13px;line-height:20px;}',
      '.dsh-session-rename__cfgRow{display:flex;align-items:flex-start;',
      'justify-content:space-between;gap:16px;padding:12px 0;',
      'border-bottom:.5px solid var(--dsw-alias-border-l2);}',
      '.dsh-session-rename__cfgRow:last-child{border-bottom:0;}',
      '.dsh-session-rename__cfgMain{display:flex;flex-direction:column;gap:4px;',
      'min-width:0;}',
      '.dsh-session-rename__cfgLabelRow{display:flex;align-items:center;gap:8px;',
      'flex-wrap:wrap;}',
      '.dsh-session-rename__cfgLabel{font-size:13px;line-height:20px;font-weight:500;',
      'color:var(--dsw-alias-label-primary);}',
      '.dsh-session-rename__cfgHint{margin:0;color:var(--dsw-alias-label-tertiary);',
      'font-size:12px;line-height:18px;overflow-wrap:anywhere;}',
      '.dsh-session-rename__cfgReset{font:inherit;color:var(--dsw-alias-label-secondary);',
      'background:0 0;border:0;padding:0;cursor:pointer;font-size:12px;line-height:18px;',
      'text-decoration:underline;text-underline-offset:2px;}',
      '@media (hover:hover){.dsh-session-rename__cfgReset:hover{',
      'color:var(--dsw-alias-label-primary);}}',
      '.dsh-session-rename__cfgReset:focus-visible{',
      'outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,',
      'var(--dsw-alias-state-business-primary));outline-offset:2px;}',
      '.dsh-session-rename__cfgSwitch{flex:none;display:inline-flex;align-items:center;',
      'gap:8px;padding-top:2px;}',
      '.dsh-session-rename__cfgStatus{margin:0;color:var(--dsw-alias-label-tertiary);',
      'font-size:12px;line-height:18px;}',
      '.dsh-session-rename__cfgStatus--warn{color:var(--dsw-alias-state-warn-primary);}',
    ].join('');

    /** Same-origin Host route that reports devops credential readiness. */
    const STATUS_ROUTE = '/api/session-rename/devops-status';
    /** Package name of this bundle — the exact `plugins.bundle.config` key. */
    const BUNDLE_ID = '@local/session-rename';
    /** Profile Loader entry id of the Host half — the settings namespace. */
    const CONFIG_ENTRY = 'session-rename';
    /** The Host Config field this page edits. */
    const CONFIG_FIELD = 'prefixDevops';

    /**
     * Tiny module-level store shared by the row button (writer) and the
     * `shell.overlay` toast (reader): the two live in different slot trees.
     */
    const toastStore = {
      value: null,
      seq: 0,
      listeners: new Set(),
      /** Publish one toast, or `null` to dismiss the current one. */
      set(value) {
        this.value = value;
        for (const listener of this.listeners) listener(value);
      },
    };

    /** Show one toast; the object identity changes even when the text repeats. */
    function showToast(tone, text) {
      toastStore.seq += 1;
      toastStore.set({ tone, text, id: toastStore.seq });
    }

    /**
     * The `shell.overlay` entry: nothing while no toast is pending, otherwise
     * one line at the top center that dismisses itself after {@link TOAST_MS}.
     */
    function Toast() {
      const [value, setValue] = React.useState(toastStore.value);
      React.useEffect(() => {
        const listener = (next) => setValue(next);
        toastStore.listeners.add(listener);
        setValue(toastStore.value);
        return () => {
          toastStore.listeners.delete(listener);
        };
      }, []);
      React.useEffect(() => {
        if (value === null) return undefined;
        const timer = window.setTimeout(() => {
          toastStore.set(null);
        }, TOAST_MS);
        return () => {
          window.clearTimeout(timer);
        };
      }, [value]);
      if (value === null) return null;
      const success = value.tone === 'success';
      return h('div', {
        className: `dsh-session-rename__toast dsh-session-rename__toast--${value.tone}`,
        role: 'status',
        'aria-live': 'polite',
      },
        h('span', { className: 'dsh-session-rename__toast-icon', 'aria-hidden': true },
          success ? h(IconCheckOutlineRegular, { size: 14 }) : h(IconWarningOutlineRegular, { size: 14 })),
        h('span', { className: 'dsh-session-rename__toast-text' }, value.text),
      );
    }

    /** A failed rename request: the Host's code and wording, plus how it failed. */
    class RenameFailure extends Error {
      constructor(message, { status, code, network = false } = {}) {
        super(message);
        this.name = 'RenameFailure';
        this.status = status;
        this.code = code;
        this.network = network;
      }
    }

    /**
     * Ask the Host to summarize and rename one Session.
     * @param {string} sessionId - the Session whose conversation is summarized.
     * @returns {Promise<string>} the new title on success.
     */
    async function requestRename(sessionId) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
          signal: controller.signal,
        });
      } catch {
        if (controller.signal.aborted) throw new RenameFailure('', { code: 'timeout' });
        // Network-level failure: no HTTP status to report.
        throw new RenameFailure('', { network: true });
      } finally {
        window.clearTimeout(timer);
      }
      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      // Any non-200 status, or a 200 that refuses, is a failure with a code.
      if (!response.ok || payload === null || payload.ok !== true) {
        throw new RenameFailure(payload?.error?.message ?? '', {
          status: response.status,
          code: payload?.error?.code,
        });
      }
      return typeof payload.title === 'string' ? payload.title : '';
    }

    /** Host error code → localized message key. */
    const ERROR_KEYS = {
      'session-missing': 'error.sessionMissing',
      'no-messages': 'error.noMessages',
      'no-route': 'error.noRoute',
      'model-error': 'error.modelError',
      'empty-title': 'error.emptyTitle',
      timeout: 'error.timeout',
      cancelled: 'error.cancelled',
      busy: 'error.busy',
      unavailable: 'error.unavailable',
      locked: 'error.locked',
    };

    /** Human-readable failure text: the code's own wording, then the Host's. */
    function failureMessage(error, t) {
      if (error instanceof RenameFailure) {
        const key = error.code === undefined ? undefined : ERROR_KEYS[error.code];
        if (key !== undefined) {
          const base = t(key);
          // Keep the Host's specific reason for model failures (truncated output,
          // tool-call answer, adapter error) instead of flattening it.
          if (error.code === 'model-error' && error.message !== '') {
            const separator = /[\u3400-\u9fff]/u.test(base) ? '：' : ': ';
            return `${base}${separator}${error.message}`;
          }
          return base;
        }
        if (error.message !== '') return error.message;
        if (error.network) return t('toast.network');
        if (error.status !== undefined) return `HTTP ${error.status}`;
        return t('toast.unknown');
      }
      if (error instanceof Error && error.message !== '') return error.message;
      return t('toast.unknown');
    }

    /**
     * Hover action for one Session row (order 300, right of the official pin
     * action): summarize the whole conversation into a title and rename it.
     * @param {{ sessionId: string, displayTitle: string, t: Function }} props -
     * the row slot's Session, its current title, and the locale seat.
     * @returns the tooltip-wrapped button.
     */
    function SummarizeRenameButton({ sessionId, t }) {
      const [status, setStatus] = React.useState('idle');
      const doneTimer = React.useRef(0);

      React.useEffect(() => () => {
        window.clearTimeout(doneTimer.current);
      }, []);

      const summarize = React.useCallback((event) => {
        // Never open the Session or trigger the row's own click handling.
        event.stopPropagation();
        if (status !== 'idle') return;
        setStatus('busy');
        requestRename(sessionId).then((title) => {
          showToast('success', t('toast.renamed', { title }));
          setStatus('done');
          window.clearTimeout(doneTimer.current);
          doneTimer.current = window.setTimeout(() => setStatus('idle'), DONE_MS);
        }, (error) => {
          showToast('error', t('toast.failed', { message: failureMessage(error, t) }));
          setStatus('idle');
        });
      }, [sessionId, status, t]);

      const busy = status === 'busy';
      const done = status === 'done';
      return h(Tooltip, {
        label: t('action.tip'),
        side: 'bottom',
        align: 'end',
        delayMs: 500,
        portal: true,
      }, h('button', {
        type: 'button',
        className: done
          ? 'dsh-session-rename__button dsh-session-rename__button--done'
          : 'dsh-session-rename__button',
        'aria-label': t('action.aria'),
        'aria-busy': busy ? 'true' : undefined,
        disabled: status !== 'idle',
        onClick: summarize,
      },
        busy
          ? h(IconSparkleRegular, { size: 14, className: 'dsh-session-rename__spin' })
          : done
            ? h(IconCheckOutlineRegular, { size: 14 })
            : h(IconSparkleRegular, { size: 14 }),
      ));
    }

    /** Short one-liner for `view: 'summary'` (defensive; this slot is page-only). */
    function BundleConfigSummary(props) {
      return props.t('config.summary');
    }

    /** One status line: whether a devops credential is readable, plus the budget. */
    function ConfigStatus(props) {
      const { t, status } = props;
      if (status === null) {
        return h('p', { className: 'dsh-session-rename__cfgStatus', role: 'status' },
          t('config.loading'));
      }
      if (status.error === true) {
        return h('p', { className: 'dsh-session-rename__cfgStatus', role: 'status' },
          t('config.credentials.unknown'));
      }
      const hasToken = status.devops?.hasToken === true;
      return h('div', null,
        h('p', {
          className: hasToken
            ? 'dsh-session-rename__cfgStatus'
            : 'dsh-session-rename__cfgStatus dsh-session-rename__cfgStatus--warn',
          role: 'status',
        }, hasToken
          ? t('config.credentials.ok', { source: status.devops?.source ?? '' })
          : t('config.credentials.missing')),
        Number.isInteger(status.titleBudget)
          ? h('p', { className: 'dsh-session-rename__cfgStatus' },
            t('config.budget', { bytes: status.titleBudget }))
          : null,
      );
    }

    /** The bundle's configuration page: one staged switch over one volatile field. */
    function BundleConfigForm(props) {
      const t = props.t;
      const snapshot = props.useConfigForm((value) => value);
      const form = props.form;

      const [draft, setDraft] = React.useState(null);
      const draftRef = React.useRef(null);
      const [saving, setSaving] = React.useState(false);
      const [failed, setFailed] = React.useState(false);
      const [applied, setApplied] = React.useState(false);
      const [status, setStatus] = React.useState(null);

      const ready = snapshot.status === 'ready';
      const stored = ready ? snapshot.value?.[CONFIG_FIELD] === true : false;
      const shown = draft === null ? stored : draft;
      const dirty = draft !== null && draft !== stored;
      const overridden = ready && snapshot.user !== undefined
        && Object.hasOwn(snapshot.user, CONFIG_FIELD);

      React.useEffect(() => {
        draftRef.current = draft;
      }, [draft]);

      // Credential readiness is shown next to the description so the reader
      // knows whether turning the switch on can actually produce a prefix.
      React.useEffect(() => {
        let live = true;
        fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } })
          .then((response) => (response.ok ? response.json() : null))
          .then((payload) => {
            if (!live) return;
            setStatus(payload !== null && payload.ok === true ? payload : { error: true });
          })
          .catch(() => {
            if (live) setStatus({ error: true });
          });
        return () => {
          live = false;
        };
      }, []);

      React.useEffect(() => {
        if (!applied) return undefined;
        const timer = window.setTimeout(() => { setApplied(false); }, 2000);
        return () => { window.clearTimeout(timer); };
      }, [applied]);

      const onToggle = (next) => {
        setFailed(false);
        setApplied(false);
        setDraft(next === true);
      };

      const onSave = () => {
        if (!dirty || saving) return;
        setSaving(true);
        setFailed(false);
        Promise.resolve(form.set(CONFIG_FIELD, draft)).then(
          (accepted) => {
            if (accepted) {
              setDraft(null);
              setApplied(true);
            } else {
              setFailed(true);
            }
          },
          () => { setFailed(true); },
        ).then(() => { setSaving(false); });
      };

      const onResetDefault = () => {
        if (saving) return;
        setSaving(true);
        setFailed(false);
        Promise.resolve(form.unset(CONFIG_FIELD)).then(
          (accepted) => {
            if (!accepted) {
              setFailed(true);
              return;
            }
            setDraft(null);
            setApplied(true);
          },
          () => { setFailed(true); },
        ).then(() => { setSaving(false); });
      };

      // SettingsForm discards staged edits on unmount (official page semantics).
      const onDiscard = () => { draftRef.current = null; };

      if (snapshot.status === 'unavailable') {
        return h('p', { className: 'dsh-session-rename__cfgStatus', role: 'status' },
          t('config.unavailable'));
      }

      const state = {
        available: true,
        writable: snapshot.writable !== false,
        dirty,
        invalid: false,
        saving,
        failed,
      };
      const labels = {
        unavailable: t('config.unavailable'),
        readOnly: t('config.readOnly'),
        saveFailed: t('config.saveFailed'),
        save: t('config.save'),
        saving: t('config.saving'),
      };

      return h('div', { className: 'dsh-session-rename__cfg' },
        h('h4', { className: 'dsh-session-rename__cfgHeading' }, t('config.heading')),
        h('p', { className: 'dsh-session-rename__cfgDesc' }, t('config.description')),
        h(SettingsForm, { labels, state, onSave, onDiscard },
          h('div', { className: 'dsh-session-rename__cfgRow' },
            h('div', { className: 'dsh-session-rename__cfgMain' },
              h('div', { className: 'dsh-session-rename__cfgLabelRow' },
                h('span', { className: 'dsh-session-rename__cfgLabel' }, t('config.toggleLabel')),
                overridden ? h(Tag, { tone: 'neutral' }, t('config.overridden')) : null,
                overridden
                  ? h('button', {
                    type: 'button',
                    className: 'dsh-session-rename__cfgReset',
                    disabled: saving || !state.writable,
                    onClick: onResetDefault,
                  }, t('config.reset'))
                  : null,
              ),
              h('p', { className: 'dsh-session-rename__cfgHint' }, t('config.toggleHint')),
            ),
            h('span', { className: 'dsh-session-rename__cfgSwitch' },
              h(Switch, {
                checked: shown,
                label: t('config.toggleLabel'),
                disabled: !ready || saving || !state.writable,
                onChange: onToggle,
              }),
            ),
          ),
          h(ConfigStatus, { t, status }),
          applied
            ? h('p', { className: 'dsh-session-rename__cfgStatus', role: 'status' },
              t('config.applied'))
            : null,
        ),
      );
    }

    /** The registered component: summary or page. */
    function BundleConfigPage(props) {
      return props.view === 'summary'
        ? h(BundleConfigSummary, props)
        : h(BundleConfigForm, props);
    }

    /**
     * Register the bundle's page. `ctx.inject` keeps settings optional: a
     * deployment without the settings client still runs the sidebar button and
     * simply never shows this section.
     */
    function applyConfigPage(ctx) {
      ctx.inject(['configForms'], (child) => {
        const form = child.configForms.get(CONFIG_ENTRY);
        child.slots.inject('plugins.bundle.config', () => child.slots.register({
          name: 'plugins.bundle.config',
          key: BUNDLE_ID,
          locale: NS,
          inject: () => ({
            hooks: { configForm: form },
            form,
          }),
        }, BundleConfigPage));
      });
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: { ...ZH, ...CONFIG_ZH },
          en: { ...EN, ...CONFIG_EN },
        }), 'session-rename: dictionaries');
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-session-rename', '');
          style.textContent = CSS + CONFIG_CSS;
          document.head.append(style);
          return () => {
            style.remove();
          };
        }, 'session-rename: styles');
        applyConfigPage(ctx);
        ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.row.action',
          id: 'session-rename',
          order: 300,
          locale: NS,
        }, SummarizeRenameButton));
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-rename-toast',
          locale: NS,
        }, Toast));
      },
    };
  },
});
