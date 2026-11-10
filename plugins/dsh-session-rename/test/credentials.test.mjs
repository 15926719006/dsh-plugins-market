/**
 * The credential tests: where the token is looked for, in what order, and that
 * nothing about it leaks into a log line.
 *
 * The precedence cases run against a fake home directory, so they describe any
 * machine; the last test reads this machine's real credential files and only
 * asserts whether a token was found, never what it is.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  loadDevopsCredentials,
  describeCredentials,
  DEFAULT_BASE_URL,
} from '../lib/devops/devops-credentials.mjs'

/**
 * A throwaway home directory with the credential files written into it.
 * @param {{ json?: string, envFile?: string }} [files] - the file bodies.
 * @returns {{ home: string, cleanup: () => void }} the fake home.
 */
function fakeHome(files = {}) {
  const home = mkdtempSync(join(tmpdir(), 'devops-lookup-'))
  const dir = join(home, '.config', 'agents', 'credentials')
  mkdirSync(dir, { recursive: true })
  if (files.json !== undefined) writeFileSync(join(dir, 'devops.json'), files.json)
  if (files.envFile !== undefined) writeFileSync(join(dir, 'onerway-devops.env'), files.envFile)
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('the environment wins over every file', () => {
  const { home, cleanup } = fakeHome({
    json: JSON.stringify({ base_url: 'https://from-json.example', token: 'rhk_from_json' }),
    envFile: 'DEVOPS_BASE_URL=https://from-env-file.example\nDEVOPS_API_KEY=rhk_from_env_file\n',
  })
  try {
    const credentials = loadDevopsCredentials({
      home,
      env: { DEVOPS_TOKEN: 'rhk_from_env', DEVOPS_BASE_URL: 'https://from-env.example/' },
    })
    assert.deepEqual(
      { baseUrl: credentials.baseUrl, token: credentials.token, source: credentials.source },
      { baseUrl: 'https://from-env.example', token: 'rhk_from_env', source: 'env' },
    )
  } finally {
    cleanup()
  }
})

test('DEVOPS_API_KEY is accepted as an alias for DEVOPS_TOKEN', () => {
  const { home, cleanup } = fakeHome()
  try {
    const credentials = loadDevopsCredentials({ home, env: { DEVOPS_API_KEY: 'rhk_alias' } })
    assert.equal(credentials.token, 'rhk_alias')
    assert.equal(credentials.source, 'env')
    assert.equal(credentials.baseUrl, DEFAULT_BASE_URL)
  } finally {
    cleanup()
  }
})

test('DEVOPS_CREDENTIALS_FILE wins over the standard devops.json', () => {
  const { home, cleanup } = fakeHome({
    json: JSON.stringify({ base_url: 'https://from-json.example', token: 'rhk_from_json' }),
  })
  const explicit = join(home, 'elsewhere.json')
  writeFileSync(explicit, JSON.stringify({ base_url: 'https://from-explicit.example', token: 'rhk_from_explicit' }))
  try {
    const credentials = loadDevopsCredentials({ home, env: { DEVOPS_CREDENTIALS_FILE: explicit } })
    assert.equal(credentials.token, 'rhk_from_explicit')
    assert.equal(credentials.baseUrl, 'https://from-explicit.example')
    assert.equal(credentials.source, `file:${explicit}`)
  } finally {
    cleanup()
  }
})

test('the standard devops.json is read when the environment is empty', () => {
  const { home, cleanup } = fakeHome({
    json: JSON.stringify({ base_url: 'https://devops.ronhan.com', token: 'rhk_standard' }),
    envFile: 'DEVOPS_API_KEY=rhk_env_file\n',
  })
  try {
    const credentials = loadDevopsCredentials({ home, env: {} })
    assert.equal(credentials.token, 'rhk_standard')
    assert.equal(credentials.baseUrl, 'https://devops.ronhan.com')
    assert.match(credentials.source, /devops\.json$/)
  } finally {
    cleanup()
  }
})

test('onerway-devops.env is the last resort, and its values may be quoted', () => {
  const { home, cleanup } = fakeHome({
    envFile: [
      '# comment',
      'DEVOPS_BASE_URL="https://devops.ronhan.com/"',
      "DEVOPS_API_KEY='rhk_env_file'",
      '',
    ].join('\n'),
  })
  try {
    const credentials = loadDevopsCredentials({ home, env: {} })
    assert.equal(credentials.token, 'rhk_env_file')
    assert.equal(credentials.baseUrl, 'https://devops.ronhan.com')
    assert.match(credentials.source, /onerway-devops\.env$/)
  } finally {
    cleanup()
  }
})

test('an unreadable or malformed file is skipped, not fatal', () => {
  const { home, cleanup } = fakeHome({ json: '{ this is not json', envFile: 'DEVOPS_API_KEY=rhk_still_there\n' })
  try {
    const credentials = loadDevopsCredentials({ home, env: {} })
    assert.equal(credentials.token, 'rhk_still_there')
  } finally {
    cleanup()
  }
})

test('no source at all is not an error: an empty token and the default address', () => {
  const { home, cleanup } = fakeHome()
  try {
    const credentials = loadDevopsCredentials({ home, env: {} })
    assert.equal(credentials.token, '')
    assert.equal(credentials.source, 'none')
    assert.equal(credentials.baseUrl, 'https://devops.ronhan.com')
  } finally {
    cleanup()
  }
})

test('the diagnostic view never carries the token', () => {
  const view = describeCredentials({ baseUrl: 'https://devops.ronhan.com/', token: 'rhk_secret_value', source: 'env' })
  assert.deepEqual(view, { baseUrl: 'https://devops.ronhan.com', hasToken: true, source: 'env' })
  assert.equal(JSON.stringify(view).includes('rhk_secret_value'), false)
  assert.deepEqual(describeCredentials(null), {
    baseUrl: 'https://devops.ronhan.com',
    hasToken: false,
    source: 'none',
  })
})

test("this machine's credential files resolve a token (without printing it)", () => {
  const standard = join(homedir(), '.config', 'agents', 'credentials', 'devops.json')
  const onerway = join(homedir(), '.config', 'agents', 'credentials', 'onerway-devops.env')
  if (!existsSync(standard) && !existsSync(onerway)) {
    // Nothing to assert on a machine that has never configured the platform.
    return
  }
  const credentials = loadDevopsCredentials()
  assert.ok(credentials.token.length > 0, 'expected a token from the machine credential files')
  assert.match(credentials.baseUrl, /^https?:\/\//)
  assert.equal(describeCredentials(credentials).hasToken, true)
})
