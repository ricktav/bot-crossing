/**
 * Claudemux project pages (optional LAN dashboard).
 *
 * Configure via env (`CLAUDEMUX_INDEX`, `CLAUDEMUX_FLEET`, `CLAUDEMUX_HOME`) and/or
 * `server/claudemux.config.json` (gitignored — copy from `claudemux.config.sample.json`).
 * When unset, enrichment is a no-op and Open keeps its existing behaviour.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { URL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(here, '..', 'claudemux.config.json')

/** Fallback host-key map used only when a config file provides URLs but omits hostKeys. */
const DEFAULT_HOST_KEYS = {
  mini: 'local-host',
  local: 'local-host',
}

const HOST_PREFIXES = ['dm1', 'dm2', 'clawd', 'imac', 'alpha', 'bravo', 'studio']

let fileConfig = null
let fileConfigAt = 0

function readFileConfig() {
  const now = Date.now()
  if (fileConfig && now - fileConfigAt < 5000) return fileConfig
  try {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    fileConfig = {}
  }
  fileConfigAt = now
  return fileConfig
}

function cfg() {
  const file = readFileConfig()
  const indexUrl = process.env.CLAUDEMUX_INDEX || file.indexUrl || ''
  const fleetReportUrl = process.env.CLAUDEMUX_FLEET || file.fleetReportUrl || ''
  const homeUrl = process.env.CLAUDEMUX_HOME || file.homeUrl || ''
  const pageBases = [
    process.env.CLAUDEMUX_PAGE_BASE,
    ...(Array.isArray(file.pageBases) ? file.pageBases : []),
  ].filter(Boolean)
  const hostKeys = { ...DEFAULT_HOST_KEYS, ...(file.hostKeys || {}) }
  return { indexUrl, fleetReportUrl, homeUrl, pageBases, hostKeys }
}

const cache = {
  at: 0,
  /** @type {Map<string, string>} */
  pages: new Map(),
  ok: false,
  indexUrl: '',
}

const TTL_MS = 60_000

export function stripHostPrefix(project) {
  const raw = String(project || '')
  const prefixes = new Set(HOST_PREFIXES)
  for (const id of Object.keys(cfg().hostKeys || {})) {
    if (id !== 'mini' && id !== 'local') prefixes.add(id)
  }
  for (const prefix of prefixes) {
    if (raw.startsWith(`${prefix}/`)) return raw.slice(prefix.length + 1)
  }
  return raw
}

export function hostKeyFor(hostId) {
  const { hostKeys } = cfg()
  if (!hostId) return hostKeys.mini || hostKeys.local || null
  return hostKeys[hostId] || null
}

function pageKey(hostKey, projectName) {
  return `${hostKey}::${projectName}`
}

function httpGet(url, { method = 'GET', timeoutMs = 6000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (err) {
      reject(err)
      return
    }
    const lib = parsed.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: { Accept: 'text/html,*/*', Connection: 'close' },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          resolve({
            status: res.statusCode || 0,
            url: res.headers.location ? new URL(res.headers.location, url).href : url,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
      },
    )
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('timeout'))
    })
    req.on('error', reject)
    req.end()
  })
}

async function headOk(url) {
  try {
    const res = await httpGet(url, { method: 'HEAD', timeoutMs: 2500 })
    if (res.status >= 200 && res.status < 400) return true
    if (res.status === 405 || res.status === 501) {
      const get = await httpGet(url, { method: 'GET', timeoutMs: 2500 })
      return get.status >= 200 && get.status < 400
    }
    return false
  } catch {
    return false
  }
}

export async function refreshClaudemuxIndex({ force = false } = {}) {
  const { indexUrl } = cfg()
  const now = Date.now()
  if (!indexUrl) {
    cache.pages = new Map()
    cache.ok = false
    cache.at = now
    cache.indexUrl = ''
    return cache
  }
  if (!force && cache.pages.size && cache.indexUrl === indexUrl && now - cache.at < TTL_MS) return cache

  try {
    const res = await httpGet(indexUrl, { method: 'GET', timeoutMs: 8000 })
    if (res.status < 200 || res.status >= 300) throw new Error(`index ${res.status}`)
    const base = res.url || indexUrl
    const next = new Map()
    for (const match of res.body.matchAll(/href=["']([^"']+)["']/gi)) {
      const href = match[1]
      if (!href || href === '#' || href.startsWith('javascript:')) continue
      let abs
      try {
        abs = new URL(href, base).href
      } catch {
        continue
      }
      const file = decodeURIComponent(abs.split('/').pop() || '')
      const m = file.match(/^(.+)__([^/]+)\.html$/i)
      if (!m) continue
      next.set(pageKey(m[2], m[1]), abs)
    }
    cache.pages = next
    cache.ok = true
    cache.at = now
    cache.indexUrl = indexUrl
  } catch {
    cache.at = now
    cache.ok = cache.pages.size > 0
    cache.indexUrl = indexUrl
  }
  return cache
}

async function probeConstructed(hostKey, projectName) {
  const { pageBases, indexUrl } = cfg()
  const bases = pageBases.length ? pageBases : indexUrl ? [indexUrl] : []
  const safe = `${projectName}__${hostKey}.html`
  for (const base of bases) {
    const url = new URL(safe, base.endsWith('/') ? base : `${base}/`).href
    if (await headOk(url)) return url
  }
  return null
}

export async function claudemuxUrlFor({ project, hostId } = {}) {
  const hostKey = hostKeyFor(hostId === undefined || hostId === null ? 'local' : hostId)
  if (!hostKey) return null
  const name = stripHostPrefix(project)
  if (!name) return null
  const { indexUrl, pageBases } = cfg()
  if (!indexUrl && !pageBases.length) return null
  await refreshClaudemuxIndex()
  const hit = cache.pages.get(pageKey(hostKey, name))
  if (hit) return hit
  const probed = await probeConstructed(hostKey, name)
  if (probed) cache.pages.set(pageKey(hostKey, name), probed)
  return probed
}

export function fleetReportUrl() {
  return cfg().fleetReportUrl || ''
}

export function claudemuxHomeUrl() {
  return cfg().homeUrl || ''
}

export async function enrichThreadsWithClaudemux(threads) {
  if (!Array.isArray(threads) || !threads.length) return threads
  const { indexUrl } = cfg()
  const report = fleetReportUrl()
  if (!indexUrl && !report) return threads
  if (indexUrl) await refreshClaudemuxIndex()
  for (const thread of threads) {
    if (thread.harness === 'grok-bot') {
      if (report) thread.fleetReportUrl = report
      continue
    }
    if (thread.harness !== 'claude-code' || !indexUrl) continue
    const hostId = thread.ref?.hostId || thread.hostId || 'local'
    const hostKey = hostKeyFor(hostId)
    if (!hostKey) continue
    const name = stripHostPrefix(thread.project)
    const url = cache.pages.get(pageKey(hostKey, name))
    if (url) thread.claudemuxUrl = url
  }
  return threads
}

export async function ensureSampleMentioned() {
  try {
    await fsp.access(path.join(here, '..', 'claudemux.config.sample.json'))
  } catch {
    /* ignore */
  }
}
