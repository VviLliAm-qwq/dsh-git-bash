import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import { BASH_EXECUTABLE, candidateBinDirs, pathContains, prependPath, resolveBinDir } from '../lib/git-path.js'
import { Config, apply, sanitizeConfig } from '../lib/plugin.js'

/** A Cordis-context stand-in recording logs and effect disposers. */
function makeCtx() {
  const record = { logs: [], cleanups: [] }
  const ctx = {
    logger: {
      info: message => record.logs.push(['info', message]),
      warn: message => record.logs.push(['warn', message]),
      debug: () => {},
    },
    effect(callback, label) {
      record.effectLabel = label
      const result = callback()
      if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
        const step = result.next()
        const disposer = step.value
        record.cleanups.push(() => {
          if (typeof disposer === 'function') disposer()
          result.next()
        })
      }
      return ctx
    },
  }
  ctx.__record = record
  ctx.__dispose = () => {
    for (const cleanup of record.cleanups) cleanup()
  }
  return ctx
}

/** Run `body` with a temporary PATH, restored afterwards. */
function withPath(value, body) {
  const saved = process.env.PATH
  if (value === undefined) delete process.env.PATH
  else process.env.PATH = value
  try {
    return body()
  } finally {
    if (saved === undefined) delete process.env.PATH
    else process.env.PATH = saved
  }
}

test('candidate directories come from the environment, de-duplicated', () => {
  assert.deepEqual(
    candidateBinDirs({
      ProgramFiles: 'C:\\PF',
      ProgramW6432: 'C:\\PF',
      'ProgramFiles(x86)': 'C:\\PF86',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
    }),
    [
      'C:\\PF\\Git\\bin',
      'C:\\PF86\\Git\\bin',
      'C:\\Users\\x\\AppData\\Local\\Programs\\Git\\bin',
      'C:\\Program Files\\Git\\bin',
    ],
  )
  // No environment at all still offers the default installer target.
  assert.deepEqual(candidateBinDirs({}), ['C:\\Program Files\\Git\\bin'])
  // Blank entries are not paths.
  assert.deepEqual(candidateBinDirs({ ProgramFiles: '   ' }), ['C:\\Program Files\\Git\\bin'])
})

test('an explicit gitBinDir is the only candidate, and must hold the executable', () => {
  const hasBash = directory => directory === 'D:\\Git\\bin'
  assert.equal(resolveBinDir({ configured: 'D:\\Git\\bin', hasBash }), 'D:\\Git\\bin')
  assert.equal(resolveBinDir({ configured: 'E:\\nope', hasBash }), undefined)
  // No probing behind an explicit answer: a typo must be reported, not papered over.
  assert.equal(resolveBinDir({ configured: 'E:\\nope', env: { ProgramFiles: 'C:\\PF' }, hasBash }), undefined)
})

test('detection walks the candidates and stops at the first usable one', () => {
  const seen = []
  assert.equal(
    resolveBinDir({
      env: { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86' },
      hasBash: directory => {
        seen.push(directory)
        return directory === 'C:\\PF86\\Git\\bin'
      },
    }),
    'C:\\PF86\\Git\\bin',
  )
  assert.deepEqual(seen, ['C:\\PF\\Git\\bin', 'C:\\PF86\\Git\\bin'])
  assert.equal(resolveBinDir({ env: {}, hasBash: () => false }), undefined)
})

test('prependPath puts the directory first and is idempotent', () => {
  const options = { delimiter: ';', caseInsensitive: true }
  assert.equal(prependPath('C:\\WINDOWS;C:\\tools', 'D:\\Git\\bin', options), 'D:\\Git\\bin;C:\\WINDOWS;C:\\tools')
  assert.equal(prependPath('', 'D:\\Git\\bin', options), 'D:\\Git\\bin')
  assert.equal(prependPath(undefined, 'D:\\Git\\bin', options), 'D:\\Git\\bin')
  // Already present anywhere: an unchanged value is how the caller detects
  // "nothing to do" — and a curated PATH is never reordered.
  assert.equal(prependPath('D:\\Git\\bin;C:\\WINDOWS', 'D:\\Git\\bin', options), 'D:\\Git\\bin;C:\\WINDOWS')
  assert.equal(prependPath('C:\\WINDOWS;D:\\Git\\bin', 'D:\\Git\\bin', options), 'C:\\WINDOWS;D:\\Git\\bin')
  // Case, trailing separators and empty segments must not defeat the check.
  assert.equal(prependPath('c:\\windows;d:\\git\\bin\\;;', 'D:\\Git\\bin', options), 'c:\\windows;d:\\git\\bin\\;;')
  // An empty directory is not a change.
  assert.equal(prependPath('C:\\WINDOWS', '  ', options), 'C:\\WINDOWS')
})

test('pathContains honours case sensitivity and the delimiter it is given', () => {
  assert.equal(pathContains('a;/b', '/b', { delimiter: ';', caseInsensitive: false }), true)
  assert.equal(pathContains('a;B', 'b', { delimiter: ';', caseInsensitive: false }), false)
  assert.equal(pathContains('a;B', 'b', { delimiter: ';', caseInsensitive: true }), true)
  assert.equal(pathContains('a;/b', '/b', { delimiter: ': ', caseInsensitive: true }), false)
  assert.equal(pathContains('', 'x', { delimiter: ';' }), false)
  assert.equal(pathContains('a;b', '  ', { delimiter: ';' }), true)
})

test('the config carries one string key with a safe default', () => {
  assert.deepEqual(sanitizeConfig(undefined), { gitBinDir: '' })
  assert.deepEqual(sanitizeConfig('nonsense'), { gitBinDir: '' })
  assert.deepEqual(sanitizeConfig({ gitBinDir: 42 }), { gitBinDir: '' })
  assert.deepEqual(sanitizeConfig({ gitBinDir: 'D:\\Git\\bin', extra: 1 }), { gitBinDir: 'D:\\Git\\bin' })
  assert.deepEqual({ ...Config({}) }, { gitBinDir: '' })
})

test('win32: the detected installation is prepended, then restored on unload', () => {
  if (process.platform !== 'win32') return
  const directory = resolveBinDir({ env: process.env })
  if (directory === undefined) return
  withPath('C:\\WINDOWS;C:\\tools', () => {
    const ctx = makeCtx()
    apply(ctx, undefined)
    assert.equal(process.env.PATH, `${directory};C:\\WINDOWS;C:\\tools`)
    assert.ok(ctx.__record.logs.some(([, message]) => /PATH prepended with/.test(message)))

    // A second activation finds it resolvable already and leaves it alone.
    const again = makeCtx()
    apply(again, undefined)
    assert.equal(process.env.PATH, `${directory};C:\\WINDOWS;C:\\tools`)
    assert.ok(again.__record.logs.some(([, message]) => /already resolvable/.test(message)))

    ctx.__dispose()
    assert.equal(process.env.PATH, 'C:\\WINDOWS;C:\\tools')
  })
})

test('a directory holding no executable leaves PATH alone and says so', () => {
  withPath('C:\\WINDOWS', () => {
    const ctx = makeCtx()
    apply(ctx, { gitBinDir: 'C:\\no-such-git-bin-dir-dsh-git-bash' })
    assert.equal(process.env.PATH, 'C:\\WINDOWS')
    assert.ok(ctx.__record.logs.some(([, message]) => /PATH left unchanged/.test(message)))
    ctx.__dispose()
  })
})

test('a PATH edited after this plugin is left to whoever changed it', () => {
  if (process.platform !== 'win32') return
  const directory = resolveBinDir({ env: process.env })
  if (directory === undefined) return
  withPath('C:\\WINDOWS', () => {
    const ctx = makeCtx()
    apply(ctx, undefined)
    assert.ok(process.env.PATH.startsWith(`${directory};`))
    process.env.PATH = 'D:\\someone-elses'
    ctx.__dispose()
    assert.equal(process.env.PATH, 'D:\\someone-elses')
    assert.ok(ctx.__record.logs.some(([, message]) => /PATH left alone/.test(message)))
  })
})

test('garbage configuration cannot throw', () => {
  const ctx = makeCtx()
  assert.doesNotThrow(() => apply(ctx, { gitBinDir: 42 }))
  assert.doesNotThrow(() => apply(ctx, 'nonsense'))
  assert.doesNotThrow(() => ctx.__dispose())
})

test('the entry module exports exactly name, Config and apply', async () => {
  const entry = await import('../lib/index.js')
  assert.deepEqual(Object.keys(entry).sort(), ['Config', 'apply', 'name'])
  assert.equal(entry.name, 'dsh-git-bash')
})

test('the probed executable is the documented one, under Git\\bin', () => {
  assert.equal(BASH_EXECUTABLE, 'bash.exe')
  assert.ok(candidateBinDirs({ ProgramFiles: 'C:\\PF' })[0].endsWith(join('Git', 'bin')))
})
