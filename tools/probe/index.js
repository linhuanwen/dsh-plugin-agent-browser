/**
 * Host half of the TICKET-001 probe.
 *
 * Intentionally empty: the probe measures what the CLIENT half can do. The host
 * half exists only because a bundle with a `dsh.client` entry still mounts on
 * the Host, and a module with no `apply` is what a loader rejects.
 */
export const name = 'dsh-plugin-agent-browser-probe'

/** Nothing to wire on the Host. */
export function apply() {}
