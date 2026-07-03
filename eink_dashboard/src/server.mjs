// Mini-HTTP-Server für den ESP32: GET /eink -> 800x480 PNG. Später als HA-Add-on paketiert.
import http from 'node:http'
import { config } from './config.mjs'
import { getEinkData } from './aggregate.mjs'
import { renderEinkPng, renderEinkPacked } from './render.mjs'
import { prewarmReminders, onRemindersRefreshed } from './sources/reminders.mjs'
import { icloudAuthState, icloudSubmitCode } from './setup.mjs'
import { APP_HTML } from './webui.mjs'
import { fireButtonEvent, getWindowCandidates, readSelectedWindows, saveSelectedWindows } from './sources/hass.mjs'

const CACHE_TTL_MS = Number(process.env.EINK_CACHE_TTL || 300) * 1000
let cache = null    // { png, at, bat }
let binCache = null // { bin, at, bat } — gepackter 4-Farb-Puffer fuer den ESP32

// Akkustand aus dem Query-Param (?bat=87), 0..100 oder null (nicht mitgeschickt).
function parseBat(url) {
  const raw = url.searchParams.get('bat')
  if (raw == null) return null
  const n = parseInt(raw, 10)
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null
}

// Zugriff erlaubt, wenn: via HA-Ingress (Header X-Ingress-Path -> HA hat den Nutzer
// bereits authentifiziert) ODER kein eink_key gesetzt ist ODER der Key stimmt. Der
// ESP32 nutzt den direkten Port mit ?key=…; Menschen kommen ueber das Ingress-Panel.
function allowed(req, url) {
  if (req.headers['x-ingress-path'] !== undefined) return true
  if (!config.einkKey) return true
  return url.searchParams.get('key') === config.einkKey
}

// ── Datencache (die teuren Live-Abrufe) — stale-while-revalidate ─────────────
// Der ESP32 wacht nur alle 30 min auf, der Cache lebt 5 min -> ohne das hier
// wuerde JEDER ESP-Abruf einen kalten ~10-15s-Render ausloesen (ESP-Timeout!).
// Loesung: Daten getrennt cachen + im Hintergrund erneuern. Der Render pro
// Anfrage ist dann nur noch Satori/resvg (~1-2s) auf fertigen Daten.
let dataCache = null      // { data, at }
let dataPromise = null    // laufender Refresh (geteilt -> parallele Aufrufe warten mit)

function refreshData() {
  if (dataPromise) return dataPromise
  dataPromise = (async () => {
    try {
      const data = await getEinkData()        // ohne battery — kommt erst beim Rendern dazu
      dataCache = { data, at: Date.now() }
      return data
    } finally { dataPromise = null }
  })()
  return dataPromise
}

async function getCachedData() {
  if (!dataCache) return await refreshData()  // erster Aufruf: auf (laufenden) Refresh warten
  if (Date.now() - dataCache.at > CACHE_TTL_MS) refreshData().catch(() => {})  // veraltet -> Hintergrund
  return dataCache.data                        // sofort (ggf. minimal veraltet)
}

async function renderCached(bat) {
  if (cache && cache.bat === bat && Date.now() - cache.at < CACHE_TTL_MS) return cache.png
  const png = await renderEinkPng({ ...(await getCachedData()), battery: bat })
  cache = { png, at: Date.now(), bat }
  return png
}

async function renderCachedBin(bat) {
  if (binCache && binCache.bat === bat && Date.now() - binCache.at < CACHE_TTL_MS) return binCache.bin
  const bin = await renderEinkPacked({ ...(await getCachedData()), battery: bat })
  binCache = { bin, at: Date.now(), bat }
  return bin
}

// Frische Erinnerungen (z.B. ~85s nach Start oder direkt nach dem 2FA-Setup) ->
// Render-/Datencache invalidieren, damit der naechste Abruf sie SOFORT zeigt
// (statt bis zum naechsten 5-Min-Refresh zu warten).
onRemindersRefreshed(() => {
  cache = null; binCache = null; dataCache = null
  refreshData().catch(() => {})
})

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  // Jede eingehende Anfrage loggen (Diagnose: erreicht der ESP32 den PC ueberhaupt?)
  const batLog = url.searchParams.get('bat')
  console.log(`[req] ${new Date().toISOString()} ${req.method} ${path}${batLog != null ? ` bat=${batLog}%` : ''} von ${req.socket.remoteAddress}`)

  if (path === '/healthz') { res.writeHead(200).end('ok'); return }

  // ── Web-UI (HA-Ingress-Panel in der Seitenleiste): Vorschau + iCloud-Setup + Status ──
  if (req.method === 'GET' && (path === '/' || path === '/setup')) {
    if (!allowed(req, url)) { res.writeHead(403).end('forbidden'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(APP_HTML); return
  }

  // eInk-Bild (Vorschau im UI + direkter Abruf).
  if (req.method === 'GET' && (path === '/eink' || path === '/eink.png')) {
    if (!allowed(req, url)) { res.writeHead(403).end('forbidden'); return }
    try {
      const png = await renderCached(parseBat(url))
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': png.length })
      res.end(png)
    } catch (err) {
      console.error('render error:', err)
      res.writeHead(500).end('render error')
    }
    return
  }

  // Gepackter 4-Farb-Puffer (96000 Bytes) — der ESP32 streamt ihn direkt ins Panel.
  if (req.method === 'GET' && path === '/eink.bin') {
    if (!allowed(req, url)) { res.writeHead(403).end('forbidden'); return }
    try {
      const t0 = Date.now()
      const bin = await renderCachedBin(parseBat(url))
      console.log(`  -> eink.bin ${bin.length}B in ${Date.now() - t0}ms`)
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': bin.length })
      res.end(bin)
    } catch (err) {
      console.error('bin render error:', err)
      res.writeHead(500).end('render error')
    }
    return
  }

  // Status-JSON fuer die Web-UI (welche Quellen live/mock, Cache-Alter, Reminder-Zahl).
  if (req.method === 'GET' && path === '/status') {
    if (!allowed(req, url)) { res.writeHead(403).end('forbidden'); return }
    const d = dataCache && dataCache.data
    const status = {
      mock: d ? Boolean(d._mock) : null,
      note: (d && d._note) || null,
      cacheAgeSec: dataCache ? Math.round((Date.now() - dataCache.at) / 1000) : null,
      reminders: d && Array.isArray(d.reminders) ? d.reminders.length : (d ? 0 : null),
      sources: {
        stripe: Boolean(config.stripeKey),
        app1: Boolean(config.app1.key),
        app2: Boolean(config.app2.key),
        calendar: Boolean((config.icloudUser && config.icloudAppPw) || config.icalUrls.length),
        remindersConfigured: Boolean(config.reminderAppleId),
      },
      einkKeySet: Boolean(config.einkKey),
      port: config.port,
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(status)); return
  }

  // Fenster-Auswahl (Web-UI): verfuegbare HA-binary_sensors + aktuelle Auswahl / speichern.
  if (path === '/windows' && req.method === 'GET') {
    if (!allowed(req, url)) { res.writeHead(403).end('forbidden'); return }
    const candidates = await getWindowCandidates()
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ candidates, selected: readSelectedWindows() })); return
  }
  if (path === '/windows' && req.method === 'POST') {
    if (!allowed(req, url)) { res.writeHead(403).end('forbidden'); return }
    let body = ''
    req.on('data', c => { body += c; if (body.length > 20000) req.destroy() })
    req.on('end', () => {
      let ids = []
      try { ids = JSON.parse(body).selected } catch { ids = [] }
      const saved = saveSelectedWindows(ids)
      cache = null; binCache = null; dataCache = null   // sofort mit neuer Auswahl rendern
      refreshData().catch(() => {})
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, selected: saved }))
    })
    return
  }

  // Button (ESP32) -> HA-Event `eink_dashboard_button` { button: N }.
  if (req.method === 'POST' && path.startsWith('/button/')) {
    if (!allowed(req, url)) { res.writeHead(403).end('forbidden'); return }
    const n = Number(path.slice('/button/'.length))
    const ok = await fireButtonEvent(n)
    console.log(`[button] ${n} -> HA-Event eink_dashboard_button: ${ok ? 'ok' : 'HA nicht erreichbar'}`)
    res.writeHead(ok ? 202 : 502).end(ok ? 'accepted' : 'ha unreachable'); return
  }

  // iCloud-2FA-Backend fuer die Web-UI (Login/Code-Validierung ueber die pyicloud-Bridge).
  if (path === '/setup/state' && req.method === 'GET') {
    if (!allowed(req, url)) { res.writeHead(403).end('forbidden'); return }
    const st = await icloudAuthState({ fresh: url.searchParams.get('fresh') === '1', initiate: url.searchParams.get('initiate') === '1' })
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(st)); return
  }
  if (path === '/setup/code' && req.method === 'POST') {
    if (!allowed(req, url)) { res.writeHead(403).end('forbidden'); return }
    let body = ''
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy() })
    req.on('end', async () => {
      let code = ''
      try { code = JSON.parse(body).code } catch { code = new URLSearchParams(body).get('code') || '' }
      const r = await icloudSubmitCode(code)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(r))
    })
    return
  }

  res.writeHead(404).end('not found')
})

server.listen(config.port, () => {
  console.log(`eInk-Renderer + Web-UI auf http://0.0.0.0:${config.port}/  (Cache ${CACHE_TTL_MS / 1000}s, Key ${config.einkKey ? 'an' : 'aus'}; UI-Panel via HA-Ingress)`)
  prewarmReminders()                                   // iCloud-Erinnerungen im Hintergrund (~90s)
  refreshData().catch(() => {})                        // Live-Daten vorwaermen -> erster ESP-Abruf schnell
  setInterval(() => refreshData().catch(() => {}), CACHE_TTL_MS)  // im Hintergrund aktuell halten
})
