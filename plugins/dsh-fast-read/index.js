/**
 * Host half of `@local/dsh-fast-read`.
 *
 * Deterministic work lives here: parse a book, split it into chapters, write
 * the library under `<workspace>/.dsh-books/`, and validate every node and edge
 * the model proposes against the chapter text it claims to come from. The
 * model does the understanding, chapter by chapter; this half refuses anything
 * it cannot trace back to a real sentence.
 *
 * @module @local/dsh-fast-read
 */

import { FastRead } from './src/host/service.js'
import { TOOL_NAMES, createTool } from './src/host/tool.js'

/** Cordis plugin name. */
export const name = 'fast-read'

/** Model-facing tools need nothing but the tool registry. */
export const inject = ['tools']

/**
 * Mount the Host half: one service shared by the four tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const service = new FastRead(ctx)
  ctx.effect(() => {
    const disposers = TOOL_NAMES.map((toolName) =>
      ctx.tools.register(createTool(toolName, service, ctx)))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* a tool that is already gone is not a problem */
        }
      }
    }
  }, 'fast-read: tools')
}
