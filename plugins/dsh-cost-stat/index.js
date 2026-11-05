/**
 * Host half of `@local/cost-stat`: the `costUsage` session projection.
 *
 * The unit folds every billed model request in the Session log into a CNY cost,
 * pricing each request at the rate in force at that request's own timestamp, so
 * a Session that spans a peak/off-peak boundary stays exact. The wire view is a
 * plain JSON snapshot that the composer stat cell reads through `useProjection`.
 */

/** Cordis plugin name. */
export const name = 'cost-stat';

/** The projection registry is the whole purpose of this plugin. */
export const inject = ['sessionProjections'];

/**
 * `deepseek-flash` (DeepSeek-V4.1-Flash-1017) list price in CNY per 1,000,000
 * tokens. Peak runs on Beijing-time workdays 09:00-12:00 and 14:00-18:00,
 * excluding Chinese statutory holidays; every other hour, weekend, and holiday
 * bills at half price.
 */
const RATES = {
  peak: { miss: 2, hit: 0.04, output: 8 },
  offPeak: { miss: 1, hit: 0.02, output: 4 },
};

/**
 * Chinese statutory holidays bill at the off-peak rate all day, so they need no
 * hour check. Shifted weekend workdays need no entry either: the price table
 * says weekends are off-peak regardless. Dates are Beijing calendar days, from
 * the State Council 2026 arrangement (holiday-cn dataset, papers:
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm). Extend this
 * set each new year; an unlisted holiday over-charges that day by 2x rather
 * than breaking anything.
 */
const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07',
]);

/** Beijing is UTC+8 with no daylight saving, so wall-clock math needs no tz table. */
function beijingDay(timeMs) {
  const shifted = new Date(timeMs + 8 * 3600000);
  return {
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    date: shifted.toISOString().slice(0, 10),
  };
}

/**
 * The price period one request was billed in.
 * @param timeMs - the request event's epoch milliseconds.
 * @returns the rate row for that instant.
 */
function rateAt(timeMs) {
  const { weekday, hour, date } = beijingDay(timeMs);
  if (weekday === 0 || weekday === 6) return RATES.offPeak;
  if (HOLIDAYS.has(date)) return RATES.offPeak;
  if (hour >= 9 && hour < 12) return RATES.peak;
  if (hour >= 14 && hour < 18) return RATES.peak;
  return RATES.offPeak;
}

/** Count one provider-reported bucket, treating absent or invalid values as zero. */
function tokensOf(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The registry validates persisted-cache rows and wire views through the
 * unit's schemas. This unit owns plain numeric state, so an identity schema is
 * both sufficient and exact; it keeps the plugin dependency-free.
 */
const identitySchema = { parse: (value) => value };

const EMPTY = {
  cost: 0,
  peakCost: 0,
  offPeakCost: 0,
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  uncachedCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  outputCost: 0,
  /** Turn number → that Turn's running spend. */
  byTurn: {},
  /** Final message id of each Turn → that Turn's total spend, for the footer. */
  byMessage: {},
  /** Turn number → the message id currently held in `byMessage`. */
  lastMessage: {},
};

/**
 * Register `costUsage`. The registration is an effect on this fiber, so
 * unloading the plugin withdraws the key.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register({
    key: 'costUsage',
    stateVersion: 2,
    stateSchema: identitySchema,
    init: () => ({ ...EMPTY }),
    apply: (state, event) => {
      if (event.type !== 'assistant/message') return state;
      const usage = event.data === undefined ? undefined : event.data.usage;
      if (usage === undefined || usage === null || typeof usage !== 'object') return state;

      const miss = tokensOf(usage.inputTokens);
      const hit = tokensOf(usage.cacheReadTokens);
      const write = tokensOf(usage.cacheWriteTokens);
      const output = tokensOf(usage.outputTokens);
      if (miss + hit + write + output === 0) return state;

      const rate = rateAt(event.time);
      const uncachedCost = (miss / 1e6) * rate.miss;
      const cacheReadCost = (hit / 1e6) * rate.hit;
      const cacheWriteCost = (write / 1e6) * rate.miss;
      const outputCost = (output / 1e6) * rate.output;
      const delta = uncachedCost + cacheReadCost + cacheWriteCost + outputCost;
      const peak = rate === RATES.peak;

      // Turn-scoped spend, so the completed-Turn footer can show its own figure.
      const turnKey = String(event.data.turn);
      const nextTurnCost = (state.byTurn[turnKey] ?? 0) + delta;
      const byTurn = { ...state.byTurn, [turnKey]: nextTurnCost };
      const message = event.data.message;
      const messageId = message === undefined || message === null ? undefined : message.id;
      let byMessage = state.byMessage;
      let lastMessage = state.lastMessage;
      if (typeof messageId === 'string') {
        const previous = lastMessage[turnKey];
        byMessage = { ...byMessage };
        if (previous !== undefined) delete byMessage[previous];
        byMessage[messageId] = nextTurnCost;
        lastMessage = { ...lastMessage, [turnKey]: messageId };
      }

      return {
        cost: state.cost + delta,
        peakCost: state.peakCost + (peak ? delta : 0),
        offPeakCost: state.offPeakCost + (peak ? 0 : delta),
        uncachedInputTokens: state.uncachedInputTokens + miss,
        cacheReadTokens: state.cacheReadTokens + hit,
        cacheWriteTokens: state.cacheWriteTokens + write,
        outputTokens: state.outputTokens + output,
        uncachedCost: state.uncachedCost + uncachedCost,
        cacheReadCost: state.cacheReadCost + cacheReadCost,
        cacheWriteCost: state.cacheWriteCost + cacheWriteCost,
        outputCost: state.outputCost + outputCost,
        byTurn,
        byMessage,
        lastMessage,
      };
    },
    wire: {
      viewSchema: identitySchema,
      view: (state) => ({
        cost: state.cost,
        peakCost: state.peakCost,
        offPeakCost: state.offPeakCost,
        uncachedInputTokens: state.uncachedInputTokens,
        cacheReadTokens: state.cacheReadTokens,
        cacheWriteTokens: state.cacheWriteTokens,
        outputTokens: state.outputTokens,
        uncachedCost: state.uncachedCost,
        cacheReadCost: state.cacheReadCost,
        cacheWriteCost: state.cacheWriteCost,
        outputCost: state.outputCost,
        byTurn: state.byTurn,
        byMessage: state.byMessage,
      }),
    },
  });
}
