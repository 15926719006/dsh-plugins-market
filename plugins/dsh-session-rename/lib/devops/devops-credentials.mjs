/**
 * Where the DevOps credential comes from.
 *
 * The token is never written into code, a repository or a log line: it is read
 * from the environment, or from one of the credential files this machine
 * already has, in a fixed order. The same order the `devops-ops` CLI uses,
 * plus the two places this machine actually keeps the token (verified
 * 2026-11-10).
 *
 * | # | source | keys |
 * |---|---|---|
 * | 1 | environment | `DEVOPS_TOKEN` / `DEVOPS_API_KEY`, `DEVOPS_BASE_URL` |
 * | 2 | `$DEVOPS_CREDENTIALS_FILE` | JSON `{ "base_url", "token" }` |
 * | 3 | `~/.config/agents/credentials/devops.json` | JSON `{ "base_url", "token" }` |
 * | 4 | `~/.config/agents/credentials/onerway-devops.env` | `DEVOPS_BASE_URL=…`, `DEVOPS_API_KEY=…` |
 *
 * The first source that yields a token wins; a source that exists but is
 * unreadable does not stop the search (an unreadable file is not a credential
 * problem, it is one file). Nothing here throws: a missing credential is not an
 * error, it is a reason not to prefix the title.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The platform's address when no source names one. */
export const DEFAULT_BASE_URL = 'https://devops.ronhan.com'

/**
 * A resolved credential.
 *
 * @typedef {object} DevopsCredentials
 * @property {string} baseUrl - the platform's root address, without a trailing slash.
 * @property {string} token - the API key, sent as a bearer token. Never log it.
 * @property {string} source - which source it came from, for diagnostics: `env`, `file:<path>` or `none`.
 */

/**
 * The environment keys that carry the token, in the order the CLI reads them.
 * @type {string[]}
 */
const TOKEN_KEYS = ['DEVOPS_TOKEN', 'DEVOPS_API_KEY']

/**
 * The token out of a JSON credential file, if it has one.
 * @param {string} path - the file.
 * @returns {{ token: string, baseUrl: string }|null} the credential, or null.
 */
function readJsonCredentials(path) {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const token = String(parsed?.token ?? parsed?.apiKey ?? parsed?.api_key ?? '').trim()
    if (token.length === 0) return null
    return { token, baseUrl: String(parsed?.base_url ?? parsed?.baseUrl ?? '').trim() }
  } catch {
    return null
  }
}

/**
 * The token out of a `KEY=value` environment file, if it has one.
 * @param {string} path - the file.
 * @returns {{ token: string, baseUrl: string }|null} the credential, or null.
 */
function readEnvFileCredentials(path) {
  try {
    if (!existsSync(path)) return null
    const values = new Map()
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue
      const equals = trimmed.indexOf('=')
      if (equals <= 0) continue
      const key = trimmed.slice(0, equals).trim()
      let value = trimmed.slice(equals + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      values.set(key, value)
    }
    let token = ''
    for (const key of TOKEN_KEYS) {
      const value = String(values.get(key) ?? '').trim()
      if (value.length > 0) {
        token = value
        break
      }
    }
    if (token.length === 0) return null
    return { token, baseUrl: String(values.get('DEVOPS_BASE_URL') ?? '').trim() }
  } catch {
    return null
  }
}

/**
 * A trailing slash on the base URL would double up in every request path.
 * @param {string} value - the configured base URL.
 * @returns {string} the base URL without the trailing slashes.
 */
function trimBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

/**
 * Read the DevOps credential from the first source that has one.
 *
 * @param {{ env?: Record<string, string|undefined>, home?: string, refresh?: boolean }} [options] - where to look.
 *   `env` and `home` exist so tests can describe a machine without being on it.
 * @returns {DevopsCredentials} the credential; `token` is empty when none was found.
 */
export function loadDevopsCredentials(options = {}) {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const credentialsDir = join(home, '.config', 'agents', 'credentials')

  /** @type {string} */
  let token = ''
  /** @type {string} */
  let baseUrl = ''
  /** @type {string} */
  let source = 'none'

  const fromEnvBaseUrl = trimBaseUrl(env.DEVOPS_BASE_URL ?? '')
  for (const key of TOKEN_KEYS) {
    const value = String(env[key] ?? '').trim()
    if (value.length > 0) {
      token = value
      baseUrl = fromEnvBaseUrl
      source = 'env'
      break
    }
  }

  if (token.length === 0) {
    const explicit = String(env.DEVOPS_CREDENTIALS_FILE ?? '').trim()
    const candidates = [
      explicit.length > 0 ? explicit : null,
      join(credentialsDir, 'devops.json'),
    ].filter(Boolean)
    for (const path of candidates) {
      const found = readJsonCredentials(path)
      if (found) {
        token = found.token
        baseUrl = trimBaseUrl(found.baseUrl)
        source = `file:${path}`
        break
      }
    }
  }

  if (token.length === 0) {
    const path = join(credentialsDir, 'onerway-devops.env')
    const found = readEnvFileCredentials(path)
    if (found) {
      token = found.token
      baseUrl = trimBaseUrl(found.baseUrl)
      source = `file:${path}`
    }
  }

  return {
    baseUrl: baseUrl.length > 0 ? baseUrl : DEFAULT_BASE_URL,
    token,
    source,
  }
}

/**
 * A credential object that is safe to put in a log line or an error message.
 * @param {DevopsCredentials|null|undefined} credentials - the real credential.
 * @returns {{ baseUrl: string, hasToken: boolean, source: string }} the redacted view.
 */
export function describeCredentials(credentials) {
  return {
    baseUrl: trimBaseUrl(credentials?.baseUrl ?? '') || DEFAULT_BASE_URL,
    hasToken: String(credentials?.token ?? '').length > 0,
    source: String(credentials?.source ?? 'none'),
  }
}
