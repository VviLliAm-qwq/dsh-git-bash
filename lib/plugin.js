/**
 * dsh-git-bash — make a Git for Windows installation resolvable as `bash`.
 *
 * WHY A PLUGIN AND NOT A CONFIG FLAG
 *
 * The official bash shell stack is platform-gated off on Windows
 * (`@deepseek-ai/dsh-base` mounts `bash-sandbox` and `tool-bash` with
 * `disabled: !!js process.platform === 'win32'`), because it spawns the bare
 * name `bash` — which a stock Windows PATH does not resolve, since Git for
 * Windows only puts `cmd\git.exe` on PATH, not `bin\bash.exe`.
 *
 * Neither the executor's `run()`/`start()` argv nor the sandbox layer's
 * `confine()` accepts an executable path, so the one seam that reaches both is
 * the process PATH. This plugin prepends the detected `Git\bin` directory to
 * `process.env.PATH` of the host process, which is what the child-process
 * launcher resolves `bash` against. Enabling the bash rows in the profile is
 * then a separate, explicit composition decision (see README).
 *
 * The plugin is deliberately defensive: it never throws, never fails the host
 * startup, logs what it decided, and restores the PATH it changed on unload
 * only while it still owns that change.
 *
 * @module dsh-git-bash
 */

import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import { BASH_EXECUTABLE, prependPath, resolveBinDir } from './git-path.js'

export const name = 'dsh-git-bash'

/** Every key has a default: a missing composition entry changes nothing. */
export const Config = z.object({
  /**
   * Directory holding `bash.exe`. Empty means "detect it" — an explicit value
   * is used as given (and reported when it holds no executable), so a machine
   * with a non-standard install is a one-line config away.
   */
  gitBinDir: z.string().default(''),
})

/** Boot defaults mirroring the schema. */
const DEFAULTS = Object.freeze({ gitBinDir: '' })

const DIAG_LOG = join(homedir(), '.dsh-tui', 'dsh-git-bash.log')
/** Above this size the log is trimmed to its newest half. */
const MAX_LOG_BYTES = 128 * 1024
/** Inside `node --test` nothing may touch a user's log file. */
const FILE_LOG_ENABLED = typeof process.env?.NODE_TEST_CONTEXT !== 'string'

/** Coerce an untrusted config object into the known key with a valid type. */
export function sanitizeConfig(config) {
  const out = { ...DEFAULTS }
  if (config !== null && typeof config === 'object' && typeof config.gitBinDir === 'string') {
    out.gitBinDir = config.gitBinDir
  }
  return out
}

/** Append one bounded diagnostic line. */
function appendLogLine(path, line) {
  try {
    if (statSync(path).size > MAX_LOG_BYTES) {
      writeFileSync(path, readFileSync(path, 'utf8').slice(-Math.floor(MAX_LOG_BYTES / 2)))
    }
  } catch {
    // Missing or unreadable file: the append below recreates it.
  }
  appendFileSync(path, line)
}

/** Quiet logger: the host logger always, plus the plugin's own bounded file. */
function createLogger(ctx) {
  const write = (level, message) => {
    try {
      ctx.logger?.[level]?.(`dsh-git-bash: ${message}`)
    } catch {
      // Observability only; never let logging break the plugin.
    }
    if (!FILE_LOG_ENABLED) return
    try {
      appendLogLine(DIAG_LOG, `${new Date().toISOString()} ${level} ${message}\n`)
    } catch {
      // An unwritable log path is not worth surfacing.
    }
  }
  return {
    info: message => write('info', message),
    warn: message => write('warn', message),
  }
}

/**
 * Wire the plugin.
 *
 * @param ctx - Cordis context of this activation.
 * @param config - composition-entry config; `gitBinDir` defaults to "".
 */
export function apply(ctx, config) {
  const log = createLogger(ctx)
  try {
    log.info(`apply started pid=${process.pid} node=${process.version} file=${fileURLToPath(import.meta.url)}`)
  } catch {
    // Logging must never be the reason a plugin fails to load.
  }

  try {
    const resolved = sanitizeConfig(config)
    if (process.platform !== 'win32') {
      // POSIX installs resolve `bash` from the system PATH; prepending a
      // Windows-style Git directory there would be wrong.
      log.info('skipped: not win32')
      return
    }

    const directory = resolveBinDir({ configured: resolved.gitBinDir, env: process.env })
    if (directory === undefined) {
      log.warn(
        resolved.gitBinDir === ''
          ? 'no Git for Windows installation found; PATH left unchanged (set gitBinDir to point at one)'
          : `gitBinDir holds no ${BASH_EXECUTABLE}: ${resolved.gitBinDir}; PATH left unchanged`,
      )
      return
    }

    const before = typeof process.env.PATH === 'string' ? process.env.PATH : ''
    const after = prependPath(before, directory, { delimiter })
    if (after === before) {
      log.info(`already resolvable, PATH left unchanged: ${directory}`)
      return
    }

    process.env.PATH = after
    log.info(`PATH prepended with ${directory}`)

    // Restore only while the value is still ours: another plugin (or the user)
    // may have edited PATH afterwards, and their change must win.
    ctx.effect(function* pathEffect() {
      yield () => {
        try {
          if (process.env.PATH === after) {
            process.env.PATH = before
            log.info('PATH restored')
          } else {
            log.info('PATH left alone: it changed after this plugin')
          }
        } catch {
          // Best-effort teardown.
        }
      }
    }, 'dsh-git-bash PATH')
  } catch (error) {
    log.warn(`apply failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
