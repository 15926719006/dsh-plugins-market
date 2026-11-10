/**
 * Host half of `@local/turn-duration`: the `turnDuration` Session projection.
 *
 * A Turn in the Session log is bracketed by `turn/start` and `turn/end`, and
 * every committed event carries an epoch-milliseconds `time`. Folding those two
 * events gives the wall-clock duration of one round of work — model steps,
 * tool calls and waiting included — which is exactly what a reply costs the
 * user in time.
 *
 * The wire view is keyed by the assistant message that closes the Turn, so the
 * browser half can render one chip under that message and nowhere else.
 */

/** Cordis plugin name. */
export const name = 'turn-duration';

/** The projection registry is the whole purpose of this plugin. */
export const inject = ['sessionProjections'];

const identitySchema = { parse: (value) => value };

/**
 * Register `turnDuration`. The registration is an effect on this fiber, so
 * unloading the plugin withdraws the key.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx) {
  ctx.sessionProjections.register({
    key: 'turnDuration',
    stateVersion: 1,
    stateSchema: identitySchema,
    init: () => ({
      turns: {},
      lastMessage: {},
      byMessage: {},
      view: { byMessage: {} },
    }),
    apply: (state, event) => {
      if (event.type === 'turn/start') {
        const turn = String(event.data.turn);
        return {
          ...state,
          turns: {
            ...state.turns,
            [turn]: { start: event.time },
          },
        };
      }

      if (event.type === 'assistant/message') {
        const turn = String(event.data.turn);
        const message = event.data.message;
        const messageId = message === undefined || message === null ? undefined : message.id;
        if (typeof messageId !== 'string') return state;
        if (state.lastMessage[turn] === messageId) return state;
        return {
          ...state,
          lastMessage: { ...state.lastMessage, [turn]: messageId },
        };
      }

      if (event.type !== 'turn/end') return state;

      const turn = String(event.data.turn);
      const opened = state.turns[turn];
      if (opened === undefined || typeof opened.start !== 'number') return state;

      const end = event.time;
      const ms = end - opened.start;
      if (!Number.isFinite(ms) || ms <= 0) return state;

      const reason = event.data.reason === undefined ? undefined : event.data.reason.kind;
      const turns = {
        ...state.turns,
        [turn]: { start: opened.start, end, ms, reason },
      };

      const messageId = state.lastMessage[turn];
      if (typeof messageId !== 'string') {
        return { ...state, turns };
      }

      // A fresh closed record plus a fresh wire view; an unchanged message key
      // can only be replaced by a newer final message of the same Turn.
      const byMessage = {
        ...state.byMessage,
        [messageId]: { ms, start: opened.start, end, turn: event.data.turn, reason },
      };
      return {
        ...state,
        turns,
        byMessage,
        view: { byMessage },
      };
    },
    wire: {
      viewSchema: identitySchema,
      view: (state) => state.view,
    },
  });
}
