window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-export',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    const NS = 'pluginExport';

    /** Document-relative form of the Host's authenticated download route. */
    const ROUTE = 'api/plugin.export';

    const zh = {
      export: '导出插件',
      'export.aria': '导出插件 {name}',
      busy: '导出中…',
      done: '已导出',
      failed: '导出失败',
      'share.title': '【DSH 插件】{label}',
      'share.install': '安装：把收到的 {file} 存到本地，打开 DSH，点击左侧的「插件」→「添加插件」，粘贴该文件的绝对路径（例如 ~/Downloads/{file}）。',
    };
    const en = {
      export: 'Export plugin',
      'export.aria': 'Export plugin {name}',
      busy: 'Exporting…',
      done: 'Exported',
      failed: 'Export failed',
      'share.title': '[DSH plugin] {label}',
      'share.install': 'Install: save the received {file} locally, open DSH → Plugins → Add plugin, and paste that file\'s absolute path (for example ~/Downloads/{file}).',
    };

    /**
     * Reproduce the Host's archive file name so the browser download matches the
     * route's Content-Disposition.
     */
    function archiveFileName(packageName, version) {
      const bare = packageName.replace(/^@[^/]+\//, '');
      return `${bare}-${version ?? '0.0.0'}`.replace(/[^A-Za-z0-9._-]/g, '-') + '.tgz';
    }

    /** Hand one Host route to the browser download manager. */
    function saveDownload(url, fileName) {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.rel = 'noopener';
      anchor.click();
    }

    /** Copy the sharing blurb; the download already happened, so failure stays silent. */
    function copyShareText(text) {
      const fallback = () => {
        try {
          const area = document.createElement('textarea');
          area.value = text;
          area.setAttribute('readonly', '');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.append(area);
          area.select();
          document.execCommand('copy');
          area.remove();
        } catch {
          // Clipboard access is a convenience; the exported file remains the deliverable.
        }
      };
      const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
      if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
        fallback();
        return;
      }
      clipboard.writeText(text).catch(fallback);
    }

    /**
     * One Plugins-page bundle control: download the bundle as a shareable tarball
     * and copy the install blurb. Renders nothing for non-bundle subjects.
     */
    function ExportPluginAction({ subject, t }) {
      const [status, setStatus] = React.useState('idle');
      const pkg = subject !== undefined && subject.kind === 'bundle' ? subject.pkg : undefined;
      const installed = pkg !== undefined && pkg.installed === true;
      if (!installed) return null;
      const fileName = archiveFileName(pkg.name, pkg.version);
      const label = pkg.version === undefined ? pkg.name : `${pkg.name} v${pkg.version}`;
      const busy = status === 'busy';
      const onClick = () => {
        if (busy) return;
        setStatus('busy');
        const route = `${ROUTE}?${new URLSearchParams({ name: pkg.name }).toString()}`;
        fetch(route, { method: 'HEAD' })
          .then(async (response) => {
            if (!response.ok) throw new Error((await response.text().catch(() => '')).trim() || `HTTP ${response.status}`);
            saveDownload(route, fileName);
            copyShareText(`${t('share.title', { label })} ${t('share.install', { file: fileName })}`);
            setStatus('done');
          })
          .catch((error) => {
            console.error('plugin-export: could not export', pkg.name, error);
            setStatus('failed');
          })
          .finally(() => {
            window.setTimeout(() => setStatus('idle'), 2000);
          });
      };
      const text = busy ? t('busy') : status === 'done' ? t('done') : status === 'failed' ? t('failed') : t('export');
      return h(primitives.Button, {
        variant: 'outline',
        size: 'sm',
        icon: h(primitives.IconDownloadOutlineRegular, { size: 13 }),
        'aria-label': t('export.aria', { name: label }),
        disabled: busy,
        onClick,
        children: text,
      });
    }

    const inject = ['slots', 'locale'];

    /**
     * Register the dictionaries and the detail-page action seat.
     * @param ctx - the Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'plugin-export: dictionaries');
      ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
        name: 'plugins.detail.actions',
        id: 'plugin-export:export',
        order: 50,
        locale: NS,
      }, ExportPluginAction));
    }

    return { apply, inject };
  },
});
