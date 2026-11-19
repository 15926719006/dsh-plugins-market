/**
 * Browser half of `@local/dsh-remote-pair`：设置页里的「手机访问」。
 *
 * 面板只需要展示一条**长期访问链接**：任何浏览器打开它都会拿到 DSH 的会话
 * cookie（10 年），所以扫一次码 / 存一次书签就够了。链接本身等同于凭据，
 * 想作废就点「换一个新链接」。
 *
 * @module @local/dsh-remote-pair
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-remote-pair',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'remote-pair';

    const STATE = '/plugins/remote-pair/state';
    const ROTATE = '/plugins/remote-pair/rotate';
    const QR = '/plugins/remote-pair/qr.svg';

    const ZH = {
      title: '手机访问',
      intro: '手机相机扫码，或直接打开下面这个链接。这个链接长期有效，任何浏览器都行。',
      linkLabel: '长期访问链接',
      copy: '复制链接',
      copied: '已复制',
      rotate: '换一个新链接',
      rotating: '正在换…',
      rotateHint: '换新后，旧链接立刻失效（已经登录的浏览器不受影响）。',
      notConfigured: '还没有配置公网地址，请在插件配置里填 publicBaseUrl。',
      tip: '链接本身就是钥匙：别发到群里。iCloud/安卓都可以把页面「添加到主屏幕」，之后点图标直接进，不用再扫码。',
      install: '安装到主屏幕：iPhone 用 Safari 打开后点「分享 → 添加到主屏幕」；安卓用 Chrome 菜单里的「安装应用」。装之前先在这个浏览器登录一次，iOS 会把登录态复制进桌面应用。',
      loadFailed: '读不到状态：{0}',
    };

    const EN = {
      title: 'Phone access',
      intro: 'Scan with the phone camera, or open the link below. The link lasts; any browser works.',
      linkLabel: 'Long-lived link',
      copy: 'Copy link',
      copied: 'Copied',
      rotate: 'New link',
      rotating: 'Rotating…',
      rotateHint: 'The old link stops working immediately; browsers already signed in stay signed in.',
      notConfigured: 'No public URL configured yet. Set publicBaseUrl in the plugin config.',
      tip: 'The link is a credential — do not share it. Add the page to your Home Screen for one-tap access later.',
      install: 'To install: on iPhone open in Safari → Share → Add to Home Screen; on Android use Chrome → Install app. Sign in first: iOS copies the login state into the Home Screen app.',
      loadFailed: 'Cannot read state: {0}',
    };

    const styles = {
      wrap: { padding: '24px 0', display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '560px' },
      title: { fontSize: '16px', fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)' },
      intro: { fontSize: '13px', lineHeight: '20px', margin: 0, color: 'var(--dsw-alias-label-secondary)' },
      row: { display: 'flex', gap: '20px', alignItems: 'flex-start', flexWrap: 'wrap' },
      qrBox: {
        padding: '10px', borderRadius: '10px', background: '#fff',
        boxShadow: 'var(--dsw-shadow-sm, 0 1px 2px rgba(0,0,0,.12))', lineHeight: 0,
      },
      qr: { width: '208px', height: '208px', display: 'block' },
      side: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '220px', flex: '1 1 220px' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
      link: {
        margin: 0, padding: '8px 10px', borderRadius: '8px', fontSize: '12px', lineHeight: '18px',
        wordBreak: 'break-all', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-interactive-bg, rgba(127,127,127,.10))',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.24))',
      },
      actions: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
      button: {
        padding: '6px 12px', fontSize: '13px', borderRadius: '8px', cursor: 'pointer',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-interactive-bg, rgba(127,127,127,.12))',
        border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,.24))',
      },
      tip: { fontSize: '12px', lineHeight: '18px', margin: 0, color: 'var(--dsw-alias-label-tertiary)' },
      install: { fontSize: '12px', lineHeight: '18px', margin: 0, color: 'var(--dsw-alias-label-tertiary)' },
      error: { fontSize: '13px', margin: 0, color: 'var(--dsw-alias-label-error, #d33)' },
      empty: { fontSize: '13px', margin: 0, color: 'var(--dsw-alias-label-secondary)' },
    };

    function format(template, value) {
      return String(template).replace('{0}', String(value));
    }

    function PhoneAccess(props) {
      const t = props.t;
      const [phase, setPhase] = React.useState('loading');
      const [data, setData] = React.useState(null);
      const [error, setError] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [copied, setCopied] = React.useState(false);

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(STATE, { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setData(await response.json());
          setPhase('ready');
          setError('');
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
          setPhase('error');
        }
      }, []);

      const rotate = React.useCallback(async () => {
        setBusy(true);
        setCopied(false);
        try {
          const response = await fetch(ROTATE, { method: 'POST', headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setData(await response.json());
          setPhase('ready');
        } catch (cause) {
          setError(String(cause && cause.message ? cause.message : cause));
          setPhase('error');
        } finally {
          setBusy(false);
        }
      }, []);

      React.useEffect(() => {
        void load();
        const timer = setInterval(() => void load(), 10000);
        return () => clearInterval(timer);
      }, [load]);

      const copy = React.useCallback(async () => {
        if (!data || !data.accessUrl) return;
        try {
          await navigator.clipboard.writeText(data.accessUrl);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }, [data]);

      if (phase === 'loading') {
        return h('div', { style: styles.wrap }, h('h2', { style: styles.title }, t('title')));
      }

      if (phase === 'error') {
        return h('div', { style: styles.wrap }, [
          h('h2', { key: 'title', style: styles.title }, t('title')),
          h('p', { key: 'error', style: styles.error }, format(t('loadFailed'), error)),
        ]);
      }

      if (!data || !data.ready) {
        return h('div', { style: styles.wrap }, [
          h('h2', { key: 'title', style: styles.title }, t('title')),
          h('p', { key: 'empty', style: styles.empty }, t('notConfigured')),
        ]);
      }

      const qrSrc = `${QR}?c=${encodeURIComponent((data.accessUrl || '').slice(-12))}`;

      return h('div', { style: styles.wrap }, [
        h('h2', { key: 'title', style: styles.title }, t('title')),
        h('p', { key: 'intro', style: styles.intro }, t('intro')),
        h('div', { key: 'row', style: styles.row }, [
          h('div', { key: 'qr', style: styles.qrBox },
            h('img', { style: styles.qr, src: qrSrc, alt: 'access QR', width: 208, height: 208 })),
          h('div', { key: 'side', style: styles.side }, [
            h('p', { key: 'label', style: styles.label }, t('linkLabel')),
            h('p', { key: 'link', style: styles.link }, data.accessUrl || '—'),
            h('div', { key: 'actions', style: styles.actions }, [
              h('button', {
                key: 'copy', type: 'button', style: styles.button, onClick: () => void copy(),
              }, copied ? t('copied') : t('copy')),
              h('button', {
                key: 'rotate', type: 'button', style: styles.button, disabled: busy,
                onClick: () => void rotate(),
              }, busy ? t('rotating') : t('rotate')),
            ]),
            h('p', { key: 'hint', style: styles.tip }, t('rotateHint')),
          ]),
        ]),
        h('p', { key: 'tip', style: styles.tip }, t('tip')),
        h('p', { key: 'install', style: styles.install }, t('install')),
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'remote-pair: dictionaries');
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'remote-pair',
          order: 18,
          locale: NS,
          label: () => '手机访问',
        }, PhoneAccess));
      },
    };
  },
});
