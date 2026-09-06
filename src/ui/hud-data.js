/** UI-facing slices of the settings model, kept apart so the HUD never reaches into the engine. */
export { PRESETS } from '../core/settings.js'

/**
 * Host worlds (and Fleet) — each is its own colony view so dm2's hundreds of threads cannot
 * swamp the mini. Tab / the globe / the Planet picker cycle this list.
 *
 * Visual skins still come from planet.js (Luna/Mars/Terra/Fleet colours); the *filter* is
 * by host, not by scenery.
 */
export const PLANETS_ORDER = ['mini', 'dm1', 'dm2', 'clawd', 'imac', 'fleet']

/** Planet id for the Grok Bot world — coding harnesses stay off it, and vice versa. */
export const FLEET_PLANET = 'fleet'

/** Remote Claude plot/thread prefixes (and remotes.config.json ids). */
export const HOST_PREFIXES = ['dm1', 'dm2', 'clawd', 'imac']

/** Pre-host-world scenery ids — treat as Mini when found in stored settings. */
export const LEGACY_PLANETS = new Set(['moon', 'mars', 'terra'])

export function normalizeWorld(planetId) {
  if (!planetId || LEGACY_PLANETS.has(planetId)) return 'mini'
  return PLANETS_ORDER.includes(planetId) ? planetId : 'mini'
}

/**
 * Which host-world a thread belongs on.
 * - grok-bot → fleet
 * - ref.hostId / hostId when remote
 * - project name prefix `dm1/…` etc.
 * - otherwise local mini (no prefix)
 */
export function hostOfThread(thread) {
  if (!thread) return 'mini'
  if (thread.harness === 'grok-bot') return FLEET_PLANET
  const hostId = thread.ref?.hostId || thread.hostId
  if (hostId && hostId !== 'local') return String(hostId)
  const project = String(thread.project || '')
  for (const prefix of HOST_PREFIXES) {
    if (project === prefix || project.startsWith(`${prefix}/`)) return prefix
  }
  return 'mini'
}

/** Strip `dm2/botdispatcher` → `botdispatcher` for display / claudemux URLs. */
export function stripHostPrefix(project) {
  const raw = String(project || '')
  for (const prefix of HOST_PREFIXES) {
    if (raw.startsWith(`${prefix}/`)) return raw.slice(prefix.length + 1)
  }
  return raw
}

/** Sidebar title: include host when it is not already obvious from the world filter. */
export function displayProjectName(project, worldId) {
  const raw = String(project || '')
  if (!raw) return 'unknown'
  const world = normalizeWorld(worldId)
  if (world === FLEET_PLANET) return raw
  if (world !== 'mini' && raw.startsWith(`${world}/`)) {
    return `${world}/${stripHostPrefix(raw)}`
  }
  if (world === 'mini') {
    for (const prefix of HOST_PREFIXES) {
      if (raw.startsWith(`${prefix}/`)) return raw
    }
  }
  return raw
}
