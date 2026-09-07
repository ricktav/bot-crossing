/**
 * Multi-host Claude Code mirrors under data/remotes/<id>/.claude.
 *
 * The colony host (macmini) already scans the local ~/.claude. Remotes are rsync'd in
 * over SSH (BatchMode) on a throttle, then scanned as extra roots with host-prefixed
 * project names (dm1/…, dm2/…, imac/…) so plots never collide with the mini.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { exists } from './fsutil.mjs'

const execFileAsync = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(here, '..', '..')
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(REPO_ROOT, 'data')
const REMOTES_DIR = path.join(DATA_DIR, 'remotes')
const CONFIG_PATH = path.join(REPO_ROOT, 'server', 'remotes.config.json')

let lastSyncAt = 0
let syncInFlight = null
let lastSyncSummary = null

export function remotesDir() {
  return REMOTES_DIR
}

export async function loadRemotesConfig() {
  try {
    return JSON.parse(await fsp.readFile(CONFIG_PATH, 'utf8'))
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      console.warn('bot-crossing: remotes.config.json missing/unreadable — copy server/remotes.config.sample.json —', err?.message || err)
    }
    return { syncIntervalMs: 60000, hosts: [] }
  }
}

/** Expand a remote ssh path like ~/.claude for rsync source. */
function remoteClaudeSource(host) {
  const raw = (host.claudePath || '~/.claude').trim()
  if (raw.startsWith('~/')) return `${host.ssh}:${raw}`
  if (raw.startsWith('/')) return `${host.ssh}:${raw}`
  return `${host.ssh}:~/.claude`
}

async function rsyncHost(host) {
  const dest = path.join(REMOTES_DIR, host.id, '.claude')
  await fsp.mkdir(path.join(dest, 'projects'), { recursive: true })
  const src = `${remoteClaudeSource(host).replace(/\/?$/, '/') }projects/`
  const destProjects = path.join(dest, 'projects') + '/'
  try {
    await execFileAsync(
      'rsync',
      [
        '-az',
        '--delete',
        '-e',
        'ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new',
        src,
        destProjects,
      ],
      { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }
    )
    return { id: host.id, ok: true }
  } catch (err) {
    const msg = err?.stderr?.toString?.() || err?.message || String(err)
    console.warn(`bot-crossing: remote Claude sync failed for ${host.id} —`, msg.trim().slice(0, 240))
    return { id: host.id, ok: false, error: msg.trim().slice(0, 240) }
  }
}

/**
 * Throttled sync of every enabled SSH host. Safe to call on every scan — concurrent
 * callers share one in-flight promise, and successes/failures never throw.
 */
export async function maybeSyncRemotes({ force = false } = {}) {
  const cfg = await loadRemotesConfig()
  const interval = Math.max(5000, Number(cfg.syncIntervalMs) || 60000)
  const now = Date.now()
  if (!force && now - lastSyncAt < interval && lastSyncSummary) return lastSyncSummary
  if (syncInFlight) return syncInFlight

  syncInFlight = (async () => {
    const hosts = (cfg.hosts || []).filter((h) => h && h.enabled !== false && h.ssh && h.id)
    const results = []
    for (const host of hosts) {
      results.push(await rsyncHost(host))
    }
    lastSyncAt = Date.now()
    lastSyncSummary = { at: lastSyncAt, results }
    return lastSyncSummary
  })()

  try {
    return await syncInFlight
  } finally {
    syncInFlight = null
  }
}

/**
 * Roots the Claude harness should scan beyond the local home directory.
 * A mirror is usable even when the latest rsync failed, as long as projects/ exists.
 */
export async function listRemoteRoots() {
  const cfg = await loadRemotesConfig()
  const roots = []
  for (const host of cfg.hosts || []) {
    if (!host?.id || !host?.label) continue
    const cliProjects = path.join(REMOTES_DIR, host.id, '.claude', 'projects')
    if (!(await exists(cliProjects))) continue
    roots.push({
      id: host.id,
      label: host.label,
      remote: true,
      cliProjects,
      cliLive: path.join(REMOTES_DIR, host.id, '.claude', 'sessions'),
      desktopSessions: null,
      openDisabledReason: `Session lives on ${host.label} — open Claude there`,
    })
  }
  return roots
}
