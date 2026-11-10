window.__ModuleLoader__.load({
  id: '@local/turn-duration',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'turn-duration';

    const CSS = [
      '.dsh-turn-duration{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;',
      'height:calc(28px + var(--dsh-content-font-delta,0px));padding:0 6px;',
      'border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);',
      'font-size:calc(12px + var(--dsh-content-font-delta,0px));font-variant-numeric:tabular-nums;',
      'white-space:nowrap;line-height:1;cursor:default;}',
      '.dsh-turn-duration:hover{color:var(--dsw-alias-label-secondary);}',
      '.dsh-turn-duration svg{flex:none;width:13px;height:13px;}',
    ].join('');

    const ZH = {
      'turn.seconds': '耗时 {seconds}秒',
      'turn.minutes': '耗时 {minutes}分{seconds}秒',
      'turn.hours': '耗时 {hours}时{minutes}分',
      'turn.title': '{duration}（{start} 开始，{end} 结束）',
      'turn.titleWithReason': '{duration}（{start} 开始，{end} 结束，{reason}）',
      'reason.aborted': '已中断',
      'reason.blocked': '被阻止',
      'reason.error': '出错',
      'reason.max-tokens': '达到长度上限',
      'reason.interrupted': '被打断',
      'reason.forked': '已分叉',
    };

    const EN = {
      'turn.seconds': 'Took {seconds}s',
      'turn.minutes': 'Took {minutes}m {seconds}s',
      'turn.hours': 'Took {hours}h {minutes}m',
      'turn.title': '{duration} ({start} – {end})',
      'turn.titleWithReason': '{duration} ({start} – {end}, {reason})',
      'reason.aborted': 'aborted',
      'reason.blocked': 'blocked',
      'reason.error': 'error',
      'reason.max-tokens': 'token limit',
      'reason.interrupted': 'interrupted',
      'reason.forked': 'forked',
    };

    /** Clock glyph: a 12-hour face with two hands, drawn in `currentColor`. */
    function ClockIcon() {
      return h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, focusable: 'false' },
        h('circle', {
          cx: 8, cy: 8, r: 5.7,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
        }),
        h('path', {
          d: 'M8 4.6V8l2.4 1.5',
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.3,
          strokeLinecap: 'round', strokeLinejoin: 'round',
        }),
      );
    }

    /** Local wall-clock `HH:MM:SS` for the tooltip, locale-independent digits. */
    function clock(time) {
      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return '--:--:--';
      const pad = (value) => String(value).padStart(2, '0');
      return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
    }

    /** Round to one decimal place without trailing `.0`. */
    function tenths(value) {
      const rounded = Math.round(value * 10) / 10;
      return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
    }

    /**
     * Split a duration into the dictionary key and its placeholders. The key
     * choice is magnitude-based, so every locale only formats its own units.
     */
    function durationParts(ms) {
      const totalSeconds = ms / 1000;
      if (totalSeconds < 60) {
        return { key: 'turn.seconds', params: { seconds: tenths(totalSeconds) } };
      }
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = Math.round(totalSeconds % 60);
      if (minutes < 60) {
        return seconds >= 60
          ? { key: 'turn.minutes', params: { minutes: String(minutes + 1), seconds: '0' } }
          : { key: 'turn.minutes', params: { minutes: String(minutes), seconds: String(seconds).padStart(2, '0') } };
      }
      const hours = Math.floor(minutes / 60);
      const restMinutes = minutes % 60;
      return {
        key: 'turn.hours',
        params: { hours: String(hours), minutes: String(restMinutes).padStart(2, '0') },
      };
    }

    /**
     * One chip under the assistant message that closes a Turn: how long the
     * whole round took, measured from `turn/start` to `turn/end`.
     *
     * Rendering nothing leaves the standard action row untouched for a Turn
     * that has not closed yet, or for an intermediate assistant message.
     */
    function TurnDuration(props) {
      const projected = props.useProjection('turnDuration');
      const t = props.t;
      if (projected === undefined || projected === null) return null;
      const byMessage = projected.byMessage;
      if (byMessage === undefined || byMessage === null) return null;
      const record = byMessage[props.messageId];
      if (record === undefined || record === null) return null;
      if (typeof record.ms !== 'number' || !(record.ms > 0)) return null;

      const tr = (key, params) => (typeof t === 'function' ? t(key, params) : key);
      const parts = durationParts(record.ms);
      const label = tr(parts.key, parts.params);
      const reasonKey = typeof record.reason === 'string' ? 'reason.' + record.reason : undefined;
      const reasonText = reasonKey === undefined ? '' : tr(reasonKey);
      const hasReason = reasonText !== '' && reasonText !== reasonKey;
      const title = hasReason
        ? tr('turn.titleWithReason', {
          duration: label,
          start: clock(record.start),
          end: clock(record.end),
          reason: reasonText,
        })
        : tr('turn.title', {
          duration: label,
          start: clock(record.start),
          end: clock(record.end),
        });

      return h('span', { className: 'dsh-turn-duration', title }, [
        h(ClockIcon, { key: 'icon' }),
        h('span', { className: 'dsh-turn-duration__label', key: 'label' }, label),
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'turn-duration: dictionaries');
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-turn-duration', '');
          style.textContent = CSS;
          document.head.append(style);
          return () => {
            style.remove();
          };
        }, 'turn-duration: styles');
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'turn-duration',
          order: 25,
          locale: NS,
        }, TurnDuration));
      },
    };
  },
});
