// Mini-HTTP-Server für den ESP32: GET /eink -> 800x480 PNG. Später als HA-Add-on paketiert.
import http from 'node:http'
import { config } from './config.mjs'
import { getEinkData } from './aggregate.mjs'
import { renderEinkPng, renderEinkPacked } from './render.mjs'
import { prewarmReminders } from './sources/reminders.mjs'
import { SETUP_HTML, icloudAuthState, icloudSubmitCode } from './setup.mjs'

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  // Jede eingehende Anfrage loggen (Diagnose: erreicht der ESP32 den PC ueberhaupt?)
  const batLog = url.searchParams.get('bat')
  console.log(`[req] ${new Date().toISOString()} ${req.method} ${path}${batLog != null ? ` bat=${batLog}%` : ''} von ${req.socket.remoteAddress}`)

  if (path === '/healthz') { res.writeHead(200).end('ok'); return }

  if (req.method === 'GET' && (path === '/eink' || path === '/eink.png' || path === '/')) {
    if (config.einkKey && url.searchParams.get('key') !== config.einkKey) {
      res.writeHead(403).end('forbidden'); return
    }
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
    if (config.einkKey && url.searchParams.get('key') !== config.einkKey) {
      res.writeHead(403).end('forbidden'); return
    }
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

  // Button -> HA (Platzhalter, bis HA verdrahtet ist)
  if (req.method === 'POST' && path.startsWith('/button/')) {
    const n = path.slice('/button/'.length)
    console.log(`[button] ${n} gedrückt (HA-Aktion noch nicht verdrahtet)`)
    res.writeHead(202).end('accepted'); return
  }

  // ── iCloud-2FA-Setup-UI (fuer Reminders; ersetzt docker exec / SSH in den Container) ──
  // Browser oeffnet /setup -> laedt Status -> bei 2FA Code-Eingabefeld. Gleiches
  // eink_key-Gate wie /eink, falls gesetzt.
  if (path === '/setup' && req.method === 'GET') {
    if (config.einkKey && url.searchParams.get('key') !== config.einkKey) { res.writeHead(403).end('forbidden'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(SETUP_HTML); return
  }
  if (path === '/setup/state' && req.method === 'GET') {
    if (config.einkKey && url.searchParams.get('key') !== config.einkKey) { res.writeHead(403).end('forbidden'); return }
    const st = await icloudAuthState({ fresh: url.searchParams.get('fresh') === '1' })
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(st)); return
  }
  if (path === '/setup/code' && req.method === 'POST') {
    if (config.einkKey && url.searchParams.get('key') !== config.einkKey) { res.writeHead(403).end('forbidden'); return }
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
  console.log(`eInk-Renderer läuft auf http://0.0.0.0:${config.port}/eink  (Cache ${CACHE_TTL_MS / 1000}s, Key ${config.einkKey ? 'an' : 'aus'})`)
  prewarmReminders()                                   // iCloud-Erinnerungen im Hintergrund (~90s)
  refreshData().catch(() => {})                        // Live-Daten vorwaermen -> erster ESP-Abruf schnell
  setInterval(() => refreshData().catch(() => {}), CACHE_TTL_MS)  // im Hintergrund aktuell halten
})
