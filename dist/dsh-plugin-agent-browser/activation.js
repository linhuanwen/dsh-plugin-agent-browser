/**
 * When the plugin is allowed to put the browser panel on screen.
 *
 * Opening the panel is a visible act: it expands the right column and takes
 * screen space away from whatever the user was reading. The three modes below
 * are the whole policy surface; the host stamps one of them onto every command
 * and the panel is the only place that acts on it (see `client.js` `dispatch`).
 *
 * - `auto`   — open once, when this session has no live panel yet; after that
 *              leave the column alone. Collapsing the sidebar therefore sticks.
 * - `always` — bring the panel forward on every command, so the user can watch
 *              the agent work even after switching to another view.
 * - `manual` — never open it; if there is no panel, fail immediately with an
 *              instruction instead of waiting for a mount that will not happen.
 *
 * `browser_download` never reaches this module: it runs on the host with
 * `fetch`, so it neither opens nor needs the panel in any mode.
 */

/** Accepted values of the `activation` config field, in menu order. */
export const ACTIVATIONS = ['auto', 'always', 'manual']

/** What an unset or unknown value means. */
export const DEFAULT_ACTIVATION = 'auto'

/**
 * Coerce a config value into a known activation.
 * @param {unknown} value - whatever the loader row held.
 * @returns {'auto'|'always'|'manual'} a usable mode.
 */
export function normalizeActivation(value) {
  if (typeof value !== 'string') return DEFAULT_ACTIVATION
  const mode = value.trim().toLowerCase()
  return ACTIVATIONS.includes(mode) ? mode : DEFAULT_ACTIVATION
}

/**
 * How one command should treat the panel.
 *
 * `once` and `always` differ only when a live panel already exists: `once`
 * leaves the layout untouched, `always` re-focuses it.
 * @param {unknown} activation - the configured mode.
 * @returns {'once'|'always'|'never'} instruction carried with the command.
 */
export function showFor(activation) {
  const mode = normalizeActivation(activation)
  if (mode === 'manual') return 'never'
  if (mode === 'always') return 'always'
  return 'once'
}

/**
 * Bundle the mode with the per-command instruction the bridge expects.
 * @param {unknown} activation - the configured mode.
 * @returns {{ mode: string, show: () => 'once'|'always'|'never' }} policy.
 */
export function activationPolicy(activation) {
  const mode = normalizeActivation(activation)
  const show = showFor(mode)
  return { mode, show: () => show }
}
