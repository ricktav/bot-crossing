import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  defaultHarness,
  harnessAppStartedAt,
  harnessStatus,
  newSession as harnessNewSession,
  openThread as harnessOpenThread,
  scanThreads,
  setThreadArchived,
} from './scan.mjs'
import {
  claudemuxUrlFor,
  enrichThreadsWithClaudemux,
  fleetReportUrl,
} from './lib/claudemux.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.BOT_CROSSING_DATA || path.join(here, '..', 'data')
const STATE_FILE = path.join(DATA_DIR, 'colony.json')

const STATE_VERSION = 1

/**
 * Colony state is only ever the things the *game* invents — which plot a project got,
 * what a thread's building looks like, what you archived. The threads themselves stay
 * read-only: nothing here ever writes to a harness's data except the one archive flag.
 */
const emptyState = () => ({
  version: STATE_VERSION,
  archived: [],
  archivedAt: {},
  opened: [],
  plots: {},
  plotsByWorld: {},
  seen: {},
  settings: null,
  updatedAt: 0,
})

const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {})
const asArray = (v) => (Array.isArray(v) ? v : [])

async function readState() {
  try {
    const raw = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'))
    return {
      version: STATE_VERSION,
      archived: asArray(raw.archived),
      archivedAt: asObject(raw.archivedAt),
      opened: asArray(raw.opened),
      plots: asObject(raw.plots),
      plotsByWorld: asObject(raw.plotsByWorld),
      seen: asObject(raw.seen),
      settings: raw.settings && typeof raw.settings === 'object' ? raw.settings : null,
      updatedAt: Number(raw.updatedAt) || 0,
    }
  } catch {
    return emptyState()
  }
}

/**
 * One writer: the browser owns this file and PUTs it whole. `/api/archive` deliberately
 * does not touch it — if it did, the next save from a page holding older state would
 * silently drop every archive made since that page loaded.
 */
async function writeState(next) {
  const state = {
    version: STATE_VERSION,
    archived: asArray(next.archived),
    archivedAt: asObject(next.archivedAt),
    opened: asArray(next.opened),
    plots: asObject(next.plots),
    plotsByWorld: asObject(next.plotsByWorld),
    seen: asObject(next.seen),
    settings: next.settings && typeof next.settings === 'object' ? next.settings : null,
    updatedAt: Date.now(),
  }
  await fsp.mkdir(DATA_DIR, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2))
  await fsp.rename(tmp, STATE_FILE)
  return state
}

/**
 * Hand a `harness://…` deep link, or a folder, to whatever opens things on this OS. The
 * opener gets an argument list, never a shell string.
 *
 * macOS's `open(1)` does both jobs, and `xdg-open` is the Linux equivalent. On Windows the
 * equivalent is ShellExecute, reached through `rundll32 url.dll,FileProtocolHandler`: a
 * registered protocol URL goes to its app and a folder opens in Explorer, with the argument
 * passed through untouched. Two more obvious routes were tried and rejected — `explorer.exe
 * <url>` silently drops any URL that carries a query string, so `code/new?folder=…` never
 * arrived, and `cmd /c start` parses its own argument line, where the `%3A%5C` escapes in that
 * same link are exactly what it expands.
 *
 * The spawn is guarded because the opener may simply not be installed — a headless Linux box
 * has no `xdg-open` — and an unhandled `error` event on a child process takes the whole server
 * down. Failing quietly is right here: there is nothing the page could do with the error, and
 * the scan path must never depend on whether presentation worked.
 */
const OPENERS = {
  darwin: ['open'],
  win32: ['rundll32', 'url.dll,FileProtocolHandler'],
  linux: ['xdg-open'],
}

function launch(target) {
  const opener = OPENERS[process.platform]
  if (!opener) return
  const [cmd, ...args] = opener
  const child = spawn(cmd, [...args, target], { stdio: 'ignore', detached: true })
  child.on('error', () => {})
  child.unref()
}

/**
 * A folder is openable only if it is still on this machine and still a directory. Paths
 * arrive from the page, which got them from a scan that may be minutes old — a repo that
 * has since been moved or deleted must fail here rather than hand the opener a dead path.
 * Absolute is judged by `path.isAbsolute` rather than a leading `/`, which no Windows path has.
 */
async function resolveFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null
  const dir = path.resolve(folder)
  const stat = await fsp.stat(dir).catch(() => null)
  return stat && stat.isDirectory() ? dir : null
}

/**
 * A harness loads its session records at launch and rewrites them whenever it touches one,
 * which silently clears an archive flag set from outside. So the colony keeps its own list
 * and re-asserts the flag on every scan; an archive that gets stomped comes back within one
 * poll. `archivePending` is true while the flag is on disk but the running app has not read
 * it yet — that astronaut is walking to the ship but has not boarded.
 */
async function reconcileArchived(threads) {
  const state = await readState()
  if (!state.archived.length) return threads
  const wanted = new Set(state.archived)

  // One `ps` sweep per harness rather than one per thread.
  const startedAt = new Map()
  for (const id of new Set(threads.map((t) => t.harness))) {
    startedAt.set(id, await harnessAppStartedAt(id))
  }

  return Promise.all(
    threads.map(async (thread) => {
      if (!wanted.has(thread.id)) return thread
      if (!thread.archived && thread.canArchive) {
        await setThreadArchived(thread.harness, thread.ref, true).catch(() => {})
      }
      const at = state.archivedAt[thread.id] ?? 0
      const appStart = startedAt.get(thread.harness) || 0
      return { ...thread, archived: true, archivePending: !(appStart && appStart > at) }
    })
  )
}

function send(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// The machine's own LAN addresses count as local too, so the colony can be
// served to the home network with BOT_CROSSING_HOST set. Harmless when bound
// to loopback (those hosts can't reach the server anyway), and the Host +
// Origin pairing still stops DNS rebinding and CSRF exactly as before.
for (const addrs of Object.values(os.networkInterfaces())) {
  for (const a of addrs || []) {
    if (a && a.family === 'IPv4' && !a.internal && a.address) LOCAL_HOSTS.add(a.address)
  }
}

/** Hostname out of a `Host:` or `Origin:` value, with the port and any brackets stripped. */
function hostnameOf(value) {
  if (!value) return ''
  const raw = String(value).includes('://') ? value : `http://${value}`
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/**
 * Is the HTTP client this Mac itself? Loopback always is; so is any of our own LAN
 * addresses (Safari on this Mac talking to `http://192.0.2.10:5274/`). An iPad on the
 * same LAN is not — its remoteAddress is the phone, not us — so OS `open` on the server
 * would bring Claude forward on the mini while Rick is looking at the iPad. In that case
 * we skip the server launch and hand the deep link back for the browser to navigate.
 */
function clientAddress(req) {
  const raw = req.socket?.remoteAddress || ''
  return String(raw).replace(/^::ffff:/, '')
}

function isSameMachine(req) {
  const addr = clientAddress(req)
  if (!addr) return false
  if (addr === '127.0.0.1' || addr === '::1') return true
  return LOCAL_HOSTS.has(addr)
}

/**
 * Only a page this server itself served may drive it. Two checks, against two different
 * attacks, both of which a localhost server with an `open`-the-desktop-app button is a
 * genuinely attractive target for:
 *
 *   - **Host** stops DNS rebinding. Binding to 127.0.0.1 is not on its own enough: an
 *     attacker who points `evil.com` at 127.0.0.1 reaches us *as a same-origin page*, and
 *     can then read every response. The rebound request still carries `Host: evil.com`.
 *   - **Origin** stops CSRF. A cross-site `fetch` with a `text/plain` body is not
 *     preflighted, so without this check any page you happened to be visiting could POST
 *     here — spawning sessions, opening Finder windows, or wiping the colony layout —
 *     even though it could never read the reply.
 *
 * A state-changing request with no `Origin` at all is refused: browsers always send one on
 * POST/PUT, so its absence means the caller is not the page. That does mean a bare `curl`
 * POST is rejected; pass `-H 'Origin: http://localhost:5274'` if you are scripting this.
 */
function isLocalRequest(req) {
  if (!LOCAL_HOSTS.has(hostnameOf(req.headers.host))) return false

  const origin = req.headers.origin
  if (origin && origin !== 'null') return LOCAL_HOSTS.has(hostnameOf(origin))
  return req.method === 'GET' || req.method === 'HEAD'
}

function readJsonBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('Body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })
}


/** Keep the roster payload phone-sized. Some CLI sessions store multi-KB prompts as titles. */
function slimThread(t) {
  if (!t || typeof t !== 'object') return t
  const title = String(t.title || '')
  const preview = String(t.preview || '')
  const out = { ...t }
  if (title.length > 160) out.title = `${title.slice(0, 157)}…`
  if (preview.length > 240) out.preview = `${preview.slice(0, 237)}…`
  return out
}

function filterThreadsByWorld(threads, world) {
  if (!world || world === 'all' || world === 'overview') return threads
  const w = String(world)
  return threads.filter((t) => {
    if (w === 'fleet') return t.harness === 'grok-bot'
    if (w === 'mini') {
      const host = t.hostId || t.ref?.hostId || 'local'
      return t.harness !== 'grok-bot' && (host === 'local' || host === 'mini' || !host)
    }
    const host = t.hostId || t.ref?.hostId || ''
    if (host === w) return true
    const project = String(t.project || '')
    return project === w || project.startsWith(`${w}/`)
  })
}

/** Connect-style middleware: handles /api/*, passes everything else through. */
export async function apiMiddleware(req, res, next) {
  const url = new URL(req.url, 'http://localhost')
  if (!url.pathname.startsWith('/api/')) return next ? next() : send(res, 404, { error: 'Not found' })

  if (!isLocalRequest(req)) {
    return send(res, 403, { error: 'Bot Crossing only answers its own page on this machine' })
  }

  try {
    if (url.pathname === '/api/threads' && req.method === 'GET') {
      const world = url.searchParams.get('world') || url.searchParams.get('planet') || ''
      let threads = await enrichThreadsWithClaudemux(await reconcileArchived(await scanThreads()))
      threads = filterThreadsByWorld(threads, world).map(slimThread)
      return send(res, 200, { threads, scannedAt: Date.now(), world: world || 'all' })
    }

    if (url.pathname === '/api/harnesses' && req.method === 'GET') {
      return send(res, 200, { harnesses: await harnessStatus() })
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, await readState())
    }

    if (url.pathname === '/api/state' && req.method === 'PUT') {
      return send(res, 200, await writeState(await readJsonBody(req)))
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const { harness, ref, project, preferWeb } = body
      let result = harnessOpenThread(harness, ref)

      // Claudemux web page: preferred when asked, or as the Open fallback for remote Claude
      // sessions that cannot deep-link on this Mac. Only URLs present in the live index.
      const wantWeb = Boolean(preferWeb) || (!result.ok && ref?.remote)
      if (wantWeb || (preferWeb && harness === 'claude-code')) {
        const web = await claudemuxUrlFor({
          project: project || ref?.project,
          hostId: ref?.hostId || (ref?.remote ? undefined : 'local'),
        })
        if (web) result = { ok: true, url: web, web: true }
      }

      // Fleet report when Grok Bot has no agent openUrl.
      if (!result.ok && harness === 'grok-bot' && preferWeb) {
        result = { ok: true, url: fleetReportUrl(), web: true }
      }

      // Always return the URL so a remote browser (iPad on LAN) can navigate it itself.
      // Only also hand it to the OS opener when the click came from this Mac — otherwise
      // Claude/Cursor would pop up on the mini while Rick is staring at the phone.
      // http(s) claudemux links also navigate in *this* browser via the client; still launch
      // on the mini so a local click opens a tab there too.
      let launched = false
      if (result.ok && result.url && isSameMachine(req)) {
        launch(result.url)
        launched = true
      }
      return send(res, result.ok ? 200 : 400, { ...result, launched })
    }

    if ((url.pathname === '/api/new-session' || url.pathname === '/api/reveal') && req.method === 'POST') {
      const { folder, harness } = await readJsonBody(req)
      const dir = await resolveFolder(folder)
      if (!dir) return send(res, 400, { ok: false, error: 'That folder is not on this machine any more' })

      if (url.pathname === '/api/reveal') {
        // Finder/Explorer only exists on this Mac — remote clients get a clear refusal.
        if (!isSameMachine(req)) {
          return send(res, 400, {
            ok: false,
            error: 'Reveal only works from a browser on this Mac — the folder lives here, not on your phone',
          })
        }
        launch(dir)
        return send(res, 200, { ok: true, launched: true })
      }
      const result = harnessNewSession(harness || (await defaultHarness()), dir)
      let launched = false
      if (result.ok && result.url && isSameMachine(req)) {
        launch(result.url)
        launched = true
      }
      return send(res, result.ok ? 200 : 400, { ...result, launched })
    }

    if (url.pathname === '/api/archive' && req.method === 'POST') {
      const { id, harness, ref, archived } = await readJsonBody(req)
      if (!id) return send(res, 400, { ok: false, error: 'Missing thread id' })

      // Only the harness's own records are touched here — the page records the intent.
      if (!ref || !harness) {
        return send(res, 200, {
          ok: true,
          archived: Boolean(archived),
          harnessRecord: false,
          note: 'Archived in the colony. That harness has no session record for this thread.',
        })
      }
      const result = await setThreadArchived(harness, ref, archived)
      return send(res, 200, { ...result, ok: true, archived: Boolean(archived), harnessRecord: result.ok })
    }

    return send(res, 404, { error: 'Unknown endpoint' })
  } catch (err) {
    return send(res, 500, { error: String(err && err.message ? err.message : err) })
  }
}
