window.__ModuleLoader__.load({
  id: '@local/cost-stat',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'cost-stat';

    /**
     * Fallback price table in CNY per 1,000,000 tokens, used only when the Host
     * `costUsage` projection is unavailable. The projection prices every request
     * at its own timestamp; this table can only price the whole Session at the
     * period in force now, which is why such a reading is shown with a "≈".
     */
    const RATES = {
      peak: { miss: 2, hit: 0.04, output: 8 },
      offPeak: { miss: 1, hit: 0.02, output: 4 },
    };
    const CURRENCY = '¥';

    const CSS = [
      '.dsh-cost-stat__anchor{min-width:0;display:inline-flex;',
      'font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);',
      'line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));}',
      '.dsh-cost-stat__pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;',
      'padding:1px 8px;max-width:100%;border:none;border-radius:var(--dsw-radius-sm);background:0 0;',
      'color:var(--dsw-alias-label-tertiary);font:inherit;line-height:inherit;',
      'font-variant-numeric:tabular-nums;white-space:nowrap;}',
      '.dsh-cost-stat__pill:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-secondary);}',
      '.dsh-cost-stat__pill svg{flex:none;width:14px;height:14px;}',
      '.dsh-cost-stat__label{min-width:0;overflow:hidden;text-overflow:ellipsis;}',
      '.dsh-cost-stat__turn{display:inline-flex;align-items:center;',
      'height:calc(28px + var(--dsh-content-font-delta,0px));padding:0 6px;',
      'border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);',
      'font-size:calc(12px + var(--dsh-content-font-delta,0px));font-variant-numeric:tabular-nums;',
      'white-space:nowrap;line-height:1;cursor:default;}',
      '.dsh-cost-stat__turn:hover{color:var(--dsw-alias-label-secondary);}',
    ].join('');

    const ZH = {
      'tip.head': '本任务花费 {cost}',
      'tip.uncached': '输入（未命中缓存）{tokens} tok × {price}/M = {cost}',
      'tip.cacheRead': '输入（命中缓存）{tokens} tok × {price}/M = {cost}',
      'tip.cacheWrite': '缓存写入 {tokens} tok × {price}/M = {cost}',
      'tip.output': '输出 {tokens} tok × {price}/M = {cost}',
      'tip.peak': '当前为高峰时段：¥{miss}（未命中）· ¥{hit}（命中）· ¥{out}（输出）每百万 tok',
      'tip.offPeak': '当前为空闲时段（半价）：¥{miss} · ¥{hit} · ¥{out} 每百万 tok',
      'tip.estimateNote': '近似值：按当前时段单价折算整条会话',
      'exact.uncached': '输入（未命中缓存）{tokens} tok = {cost}',
      'exact.cacheRead': '输入（命中缓存）{tokens} tok = {cost}',
      'exact.cacheWrite': '缓存写入 {tokens} tok = {cost}',
      'exact.output': '输出 {tokens} tok = {cost}',
      'exact.split': '按每条请求的时段计价：高峰 {peak} · 空闲 {off}',
      'exact.note': '依据会话日志中每条请求的用量与时间戳',
      'turn.title': '本轮花费 {cost}',
    };

    const EN = {
      'tip.head': 'Spent on this task: {cost}',
      'tip.uncached': 'Input (cache miss) {tokens} tok × {price}/M = {cost}',
      'tip.cacheRead': 'Input (cache hit) {tokens} tok × {price}/M = {cost}',
      'tip.cacheWrite': 'Cache write {tokens} tok × {price}/M = {cost}',
      'tip.output': 'Output {tokens} tok × {price}/M = {cost}',
      'tip.peak': 'Peak hours: ¥{miss} miss · ¥{hit} hit · ¥{out} output per 1M tok',
      'tip.offPeak': 'Off-peak (half price): ¥{miss} · ¥{hit} · ¥{out} per 1M tok',
      'tip.estimateNote': 'Approximate: the whole Session priced at the current period',
      'exact.uncached': 'Input (cache miss) {tokens} tok = {cost}',
      'exact.cacheRead': 'Input (cache hit) {tokens} tok = {cost}',
      'exact.cacheWrite': 'Cache write {tokens} tok = {cost}',
      'exact.output': 'Output {tokens} tok = {cost}',
      'exact.split': 'Priced per request: peak {peak} · off-peak {off}',
      'exact.note': 'From each request usage and timestamp in the Session log',
      'turn.title': 'Spent on this turn: {cost}',
    };

    /** Beijing is UTC+8 with no daylight saving, so wall-clock math needs no tz table. */
    function beijingHourWeekday(now) {
      const shifted = new Date(now.getTime() + 8 * 3600000);
      return { weekday: shifted.getUTCDay(), hour: shifted.getUTCHours() };
    }

    /** Fallback period only: the Host projection prices each request itself. */
    function isPeak(now) {
      const { weekday, hour } = beijingHourWeekday(now);
      if (weekday === 0 || weekday === 6) return false;
      return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
    }

    /** Compact money text: two decimals from one unit up, more precision below. */
    function money(value) {
      if (!Number.isFinite(value) || value <= 0) return CURRENCY + '0.00';
      if (value >= 100) return CURRENCY + value.toFixed(1);
      if (value >= 1) return CURRENCY + value.toFixed(2);
      if (value >= 0.01) return CURRENCY + value.toFixed(3);
      if (value >= 0.0001) return CURRENCY + value.toFixed(4);
      return '<' + CURRENCY + '0.0001';
    }

    function exactTokens(count) {
      return Math.round(count).toLocaleString('en-US');
    }

    function priceText(value) {
      return CURRENCY + String(value);
    }

    /** Receipt glyph: a bill with two ruled lines, drawn in `currentColor`. */
    function ReceiptIcon() {
      return h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, focusable: 'false' },
        h('path', {
          d: 'M4.4 2.4h7.2v11.2l-1.2-.8-1.2.8-1.2-.8-1.2.8-1.2-.8-1.2.8z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M6.4 6h3.2M6.4 8.4h3.2',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
        }),
      );
    }

    function cell(title, label) {
      return h('span', { className: 'dsh-cost-stat__anchor', 'data-composer-stat': 'cost' },
        h('span', { className: 'dsh-cost-stat__pill', title },
          h(ReceiptIcon, null),
          h('span', { className: 'dsh-cost-stat__label' }, label),
        ),
      );
    }

    /**
     * Completed-Turn footer chip: what this Turn cost, taken from the Host
     * projection's per-message figure. Rendering nothing leaves the standard
     * action row untouched for a Turn whose final message is not priced yet.
     */
    function TurnCostAction(props) {
      const projected = props.useProjection('costUsage');
      const messageId = props.messageId;
      const t = props.t;
      if (projected === undefined || projected === null) return null;
      if (typeof messageId !== 'string') return null;
      const byMessage = projected.byMessage;
      if (byMessage === undefined || byMessage === null) return null;
      const cost = byMessage[messageId];
      if (typeof cost !== 'number' || cost <= 0) return null;
      const costText = money(cost);
      const title = typeof t === 'function' ? t('turn.title', { cost: costText }) : costText;
      return h('span', { className: 'dsh-cost-stat__turn', title }, costText);
    }

    /**
     * One stat cell after the token count: the spend of this Session.
     *
     * The Host `costUsage` projection prices every request in the log at the
     * rate in force at that request's timestamp, so the reading stays exact
     * across a peak/off-peak boundary. Without it the cell falls back to the
     * shipped `tokenUsage` total priced at the current period and marks the
     * figure with "≈".
     */
    function CostPill(props) {
      const usage = props.useProjection('tokenUsage');
      const projected = props.useProjection('costUsage');
      const t = props.t;
      const [, tick] = React.useState(0);

      // The fallback reading depends on the period in force, which changes
      // while a Session sits idle at a boundary.
      React.useEffect(() => {
        const timer = setInterval(() => tick((value) => value + 1), 30000);
        return () => clearInterval(timer);
      }, []);

      const tr = (key, params) => (typeof t === 'function' ? t(key, params) : key);

      // Exact reading: the Host folded the whole log with per-request pricing.
      if (projected !== undefined && projected !== null && typeof projected.cost === 'number' && projected.cost > 0) {
        const totalText = money(projected.cost);
        const lines = [tr('tip.head', { cost: totalText })];
        if (projected.uncachedInputTokens > 0) {
          lines.push(tr('exact.uncached', {
            tokens: exactTokens(projected.uncachedInputTokens),
            cost: money(projected.uncachedCost),
          }));
        }
        if (projected.cacheReadTokens > 0) {
          lines.push(tr('exact.cacheRead', {
            tokens: exactTokens(projected.cacheReadTokens),
            cost: money(projected.cacheReadCost),
          }));
        }
        if (projected.cacheWriteTokens > 0) {
          lines.push(tr('exact.cacheWrite', {
            tokens: exactTokens(projected.cacheWriteTokens),
            cost: money(projected.cacheWriteCost),
          }));
        }
        if (projected.outputTokens > 0) {
          lines.push(tr('exact.output', {
            tokens: exactTokens(projected.outputTokens),
            cost: money(projected.outputCost),
          }));
        }
        lines.push(tr('exact.split', {
          peak: money(projected.peakCost),
          off: money(projected.offPeakCost),
        }));
        lines.push(tr('exact.note'));
        return cell(lines.join('\n'), totalText);
      }

      // Fallback: price the whole-log token total at the period in force now.
      if (usage === undefined || usage === null) return null;

      const uncached = usage.uncachedInputTokens ?? 0;
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheWrite = usage.cacheWriteTokens ?? 0;
      const output = usage.outputTokens ?? 0;
      if (uncached + cacheRead + cacheWrite + output === 0) return null;

      const peak = isPeak(new Date());
      const rate = peak ? RATES.peak : RATES.offPeak;
      const uncachedCost = (uncached / 1e6) * rate.miss;
      const cacheReadCost = (cacheRead / 1e6) * rate.hit;
      const cacheWriteCost = (cacheWrite / 1e6) * rate.miss;
      const outputCost = (output / 1e6) * rate.output;
      const totalText = money(uncachedCost + cacheReadCost + cacheWriteCost + outputCost);

      const lines = [tr('tip.head', { cost: totalText })];
      if (uncached > 0) {
        lines.push(tr('tip.uncached', {
          tokens: exactTokens(uncached),
          price: priceText(rate.miss),
          cost: money(uncachedCost),
        }));
      }
      if (cacheRead > 0) {
        lines.push(tr('tip.cacheRead', {
          tokens: exactTokens(cacheRead),
          price: priceText(rate.hit),
          cost: money(cacheReadCost),
        }));
      }
      if (cacheWrite > 0) {
        lines.push(tr('tip.cacheWrite', {
          tokens: exactTokens(cacheWrite),
          price: priceText(rate.miss),
          cost: money(cacheWriteCost),
        }));
      }
      if (output > 0) {
        lines.push(tr('tip.output', {
          tokens: exactTokens(output),
          price: priceText(rate.output),
          cost: money(outputCost),
        }));
      }
      lines.push(tr(peak ? 'tip.peak' : 'tip.offPeak', {
        miss: rate.miss,
        hit: rate.hit,
        out: rate.output,
      }));
      lines.push(tr('tip.estimateNote'));
      return cell(lines.join('\n'), '≈' + totalText);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'cost-stat: dictionaries');
        ctx.effect(() => {
          const style = document.createElement('style');
          style.setAttribute('data-cost-stat', '');
          style.textContent = CSS;
          document.head.append(style);
          return () => {
            style.remove();
          };
        }, 'cost-stat: styles');
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'cost',
          order: 2,
          locale: NS,
        }, CostPill));
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'turn-cost',
          order: 20,
          locale: NS,
        }, TurnCostAction));
      },
    };
  },
});
