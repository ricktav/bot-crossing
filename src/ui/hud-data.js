/** UI-facing slices of the settings model, kept apart so the HUD never reaches into the engine. */
export { PRESETS } from '../core/settings.js'

/** Display order for the planet picker — coding worlds first, then the Grok Bot fleet. */
export const PLANETS_ORDER = ['moon', 'mars', 'terra', 'fleet']

/** Planet id for the Grok Bot world — coding harnesses stay off it, and vice versa. */
export const FLEET_PLANET = 'fleet'
