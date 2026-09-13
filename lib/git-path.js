/**
 * Pure helpers for making a Git for Windows installation resolvable as `bash`.
 *
 * WHY THIS EXISTS
 *
 * The official bash shell stack (`@deepseek-ai/dsh-bash-sandbox` +
 * `@deepseek-ai/dsh-tool-bash`) spawns the *bare name* `bash` in two places:
 * the local executor's `run()`/`start()` argv (`["bash", "-c", command]`) and,
 * crucially, the sandbox layer's `confine()`, which builds its own
 * `["bash", "-c", command]` for the confined runner. Neither goes through a
 * configurable executable path, so the only place a Windows installation can
 * be injected is the process PATH that resolves that name.
 *
 * Everything here is pure and injectable: no `process.env` reads, no
 * filesystem calls, so the discovery rules are unit-testable at fixed inputs.
 *
 * @module dsh-git-bash/git-path
 */

import { statSync } from 'node:fs'
import { delimiter as pathDelimiter, join } from 'node:path'

/** Executable the shell stack ultimately spawns. */
export const BASH_EXECUTABLE = 'bash.exe'

/**
 * Installation roots probed when the config names none, most common first.
 *
 * `ProgramFiles(x86)` is read through a lookup function because its name is not
 * a valid identifier for dot access on some engines, and an unset variable must
 * simply drop the candidate rather than produce a path relative to the cwd.
 *
 * @param env - environment to read.
 * @returns Candidate `bin` directories, de-duplicated, in probe order.
 */
export function candidateBinDirs(env = {}) {
  const read = name => {
    const value = env[name]
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  }
  const roots = [
    read('ProgramFiles'),
    read('ProgramW6432'),
    read('ProgramFiles(x86)'),
    read('LOCALAPPDATA') === undefined ? undefined : join(read('LOCALAPPDATA'), 'Programs'),
    // The default installer target, kept last so an env-driven hit wins.
    'C:\\Program Files',
  ]
  const out = []
  for (const root of roots) {
    if (root === undefined) continue
    const candidate = join(root, 'Git', 'bin')
    if (!out.some(existing => existing.toLowerCase() === candidate.toLowerCase())) out.push(candidate)
  }
  return out
}

/** Whether `directory` holds the executable as a regular file. */
function defaultHasBash(directory) {
  try {
    return statSync(join(directory, BASH_EXECUTABLE)).isFile()
  } catch {
    return false
  }
}

/**
 * The directory that makes `bash` resolvable, or `undefined`.
 *
 * @param options.configured - explicit `gitBinDir` from the plugin config; when
 *   set it is the ONLY candidate (an explicit answer must not be second-guessed).
 * @param options.env - environment used to build the candidate list.
 * @param options.hasBash - injectable existence probe (defaults to `fs`).
 * @returns The first candidate containing the executable, else `undefined`.
 */
export function resolveBinDir(options = {}) {
  const hasBash = options.hasBash ?? defaultHasBash
  const configured = options.configured
  if (typeof configured === 'string' && configured.trim() !== '') {
    const directory = configured.trim()
    return hasBash(directory) ? directory : undefined
  }
  for (const candidate of candidateBinDirs(options.env)) {
    if (hasBash(candidate)) return candidate
  }
  return undefined
}

/**
 * Whether one PATH segment list already contains `directory`.
 *
 * Windows path comparison is case-insensitive; trailing separators and empty
 * segments (`;;`) are ignored so a hand-edited PATH cannot defeat the check.
 */
export function pathContains(pathValue, directory, options = {}) {
  const separator = options.delimiter ?? pathDelimiter
  const fold = options.caseInsensitive ?? process.platform === 'win32'
  const normalize = value => {
    const trimmed = value.trim().replace(/[\\/]+$/, '')
    return fold ? trimmed.toLowerCase() : trimmed
  }
  const wanted = normalize(directory)
  if (wanted === '') return true
  return String(pathValue ?? '')
    .split(separator)
    .some(segment => normalize(segment) === wanted)
}

/**
 * Prepend `directory` to a PATH value.
 *
 * Returns the input unchanged when the directory is already present anywhere in
 * the list: re-ordering a PATH the user curated is a side effect this plugin
 * has no business taking, and an unchanged value also lets the caller detect
 * "nothing to do" without a second probe.
 *
 * @param pathValue - current PATH (may be empty or undefined).
 * @param directory - directory to prepend.
 * @param options - `delimiter` and `caseInsensitive` overrides.
 * @returns The new PATH value, or the original when nothing had to change.
 */
export function prependPath(pathValue, directory, options = {}) {
  const separator = options.delimiter ?? pathDelimiter
  const current = typeof pathValue === 'string' ? pathValue : ''
  if (directory === undefined || directory === null || String(directory).trim() === '') return current
  if (pathContains(current, directory, options)) return current
  const head = String(directory).replace(/[\\/]+$/, '')
  return current === '' ? head : `${head}${separator}${current}`
}
