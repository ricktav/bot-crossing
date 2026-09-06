/**
 * Harness adapter: Grok Bot fleet.
 *
 * Reads a JSON feed of Grok Bot agents (one plot per agent) from a local file and/or an
 * HTTP URL. Read-only for v1 — no archive writes, and Open only works when an agent carries
 * an `openUrl`. See `server/harnesses/README.md` for the thread shape this maps into.
 *
 * Sources, in order of preference when several are set:
 *   1. GROK_BOT_FLEET_URL  — HTTP(S) JSON
 *   2. GROK_BOT_FLEET_JSON — absolute path to a JSON file
 *   3. data/fleet.json     — default next to colony.json
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { exists, num } from '../lib/fsutil.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', '..', 'data')
const DEFAULT_FILE = path.join(DATA_DIR, 'fleet.json')

const STATES = new Set(['idle', 'running', 'waiting', 'error'])

/** Prefer URL, then explicit path, then the default data file. */
function configuredSources() {
  const url = (process.env.GROK_BOT_FLEET_URL || '').trim()
  const file = (process.env.GROK_BOT_FLEET_JSON || '').trim() || DEFAULT_FILE
  return { url, file }
}

async function detect() {
  const { url, file } = configuredSources()
  if (url) return true
  return exists(file)
}

/**
 * Pull the feed. File and URL failures are empty rather than thrown so a missing demo file
 * or a down remote does not take the rest of the colony with it.
 */
async function loadFeed() {
  const { url, file } = configuredSources()

  if (url) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      console.warn(`bot-crossing: grok-bot feed URL failed —`, err?.message || err)
      // Fall through to the file so a local demo still works when the remote is down.
    }
  }

  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn(`bot-crossing: grok-bot feed file failed —`, err?.message || err)
    }
    return null
  }
}

function mapState(raw) {
  const state = STATES.has(raw) ? raw : 'idle'
  return {
    state,
    running: state === 'running',
    unread: state === 'waiting',
    hasError: state === 'error',
  }
}

/**
 * One Thread per agent. `project` is the agent name so each gets its own hex zone — the
 * colony groups by project, and Fleet wants one plot per Grok Bot rather than per chat.
 */
/**
 * Resolve a URL the browser (or OS opener) can navigate to.
 *
 * Prefer an explicit `openUrl` from the feed. Cursor *cloud* agents (`bc-…`) have a
 * documented https open-by-id page; local Grok Bot profile ids are plain UUIDs with no
 * public deep link (no grokbot://, and Cursor's deeplink catalog has no agent-chat route).
 */
function resolveOpenUrl(agent, id) {
  const raw = typeof agent.openUrl === 'string' ? agent.openUrl.trim() : ''
  if (raw) return raw
  if (/^bc-[0-9a-f-]+$/i.test(id)) return `https://cursor.com/agents/${id}`
  return ''
}

function toThread(agent) {
  if (!agent || typeof agent !== 'object') return null
  const id = String(agent.id || '').trim()
  if (!id) return null

  const name = String(agent.name || id).trim() || id
  const description = String(agent.description || agent.summary || '').trim()
  const summary = String(agent.summary || agent.description || '').trim()
  const openUrl = resolveOpenUrl(agent, id)
  const lastActivityAt = num(agent.lastActivityAt)
  const { running, unread, hasError } = mapState(String(agent.state || 'idle').toLowerCase())

  // Stable across harnesses: prefix so a Grok uuid never collides with a Claude session id.
  const threadId = id.includes(':') ? id : `grok-bot:${id}`

  return {
    id: threadId,
    title: name,
    preview: description || summary,
    project: name,
    projectPath: '',
    worktree: '',
    cwd: '',
    gitBranch: '',
    model: '',
    effort: '',
    createdAt: lastActivityAt || 0,
    lastActivityAt,
    lastFocusedAt: 0,
    running,
    unread,
    hasError,
    starred: false,
    routine: false,
    prState: '',
    archived: false,
    // Mid-size so buildings read as finished habitats rather than stubs or skyscrapers.
    sizeBytes: 250_000,
    source: 'fleet',
    canOpen: Boolean(openUrl),
    canArchive: false,
    openDisabledReason: openUrl
      ? ''
      : 'Grok Bot has no public chat deep link yet — copy the agent id instead',
    ref: { openUrl, agentId: id },
  }
}

async function scanThreads() {
  const feed = await loadFeed()
  if (!feed || !Array.isArray(feed.agents)) return []

  const threads = []
  const seen = new Set()
  for (const agent of feed.agents) {
    const thread = toThread(agent)
    if (!thread || seen.has(thread.id)) continue
    seen.add(thread.id)
    threads.push(thread)
  }
  return threads
}

function openThread(ref) {
  const url = ref?.openUrl
  if (typeof url === 'string' && url.trim()) return { ok: true, url: url.trim() }
  return { ok: false, error: 'This Grok Bot agent has no open URL' }
}

function newSession() {
  return { ok: false, error: 'Grok Bot fleet is read-only — start agents outside Bot Crossing' }
}

async function setArchived() {
  return { ok: false, error: 'Grok Bot fleet does not support archiving from here' }
}

export default {
  id: 'grok-bot',
  name: 'Grok Bot',
  detect,
  scanThreads,
  openThread,
  newSession,
  setArchived,
  paths: { DEFAULT_FILE },
}
