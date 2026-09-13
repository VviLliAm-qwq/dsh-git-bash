/**
 * dsh-git-bash — Cordis entry.
 *
 * This module re-exports exactly the three symbols a Cordis plugin entry is
 * read for (`name`, `Config`, `apply`) and nothing else: an entry module
 * carrying extra symbols changes how the loader wraps the activation, which is
 * the failure mode that costs an afternoon elsewhere in this ecosystem
 * (see `docs/DSH-PLUGIN-SOP.md` §2.1). Implementation lives in `./plugin.js`.
 *
 * @module dsh-git-bash
 */

export { Config, apply, name } from './plugin.js'
