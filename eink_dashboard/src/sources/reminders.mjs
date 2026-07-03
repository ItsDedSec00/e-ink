// iCloud-Erinnerungen über den pyicloud-Bridge (moderne CloudKit-Reminders-API).
// CalDAV sieht die auf iOS 13+ migrierten Listen NICHT mehr — pyicloud schon.
// Ein kurzlebiger Python-Prozess (Pfade via REMINDER_BRIDGE_PY/-SCRIPT bzw. im
// HA-Add-on automatisch), dem wir EINE NDJSON-Zeile (op=list_reminders) auf stdin
// schicken und dessen Antwortzeile wir lesen.
//
// WICHTIG — Timing: eine Bridge-Abfrage dauert oft ~90 s (CloudKit-Backoff), viel
// zu lang für den Render-Pfad (ESP32 bricht bei 20 s ab). Deshalb läuft die
// Abfrage im HINTERGRUND in einen Cache; getReminders() liefert den Cache SOFORT
// (stale-while-revalidate). Erste Render vor dem ersten Refresh -> null.
//
// Voraussetzung (einmalig, interaktiv): die pyicloud-Bridge einmal authentifizieren
// (echtes Apple-ID-Passwort + 2FA-Device-Trust). Im HA-Add-on via setup_2fa.py —
// siehe DOCS.md.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.mjs'

const REFRESH_MS = config.reminderRefreshMs   // Hintergrund-Refresh-Intervall
const BRIDGE_TIMEOUT_MS = 180000              // grosszuegig — laeuft ja im Hintergrund
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = config.reminderCacheFile || path.join(__dirname, '..', '..', '.reminders-cache.json')

// Apples iOS-13-Migrations-Stubs ausblenden (falls sie doch mal auftauchen).
function isAppleStub(title, notes) {
  if (notes && String(notes).toLowerCase().includes('support.apple.com/ht210220')) return true
  return [
    'Wo sind meine Erinnerungen?',
    'Where are my reminders?',
    'Where Are My Reminders?',
    'Der Ersteller dieser Liste hat diese Erinnerungen aktualisiert.',
  ].includes(String(title || '').trim())
}

// Bridge einmalig aufrufen: Anfrage auf stdin, letzte JSON-Zeile von stdout lesen.
function callBridge(op, args, timeoutMs = BRIDGE_TIMEOUT_MS) {
  return new Promise(resolve => {
    const { reminderBridgePy: py, reminderBridgeScript: script, reminderAppleId: appleId } = config
    if (!py || !script || !appleId) return resolve(null)

    let out = '', done = false, child
    try {
      child = spawn(py, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ICLOUD_USERNAME: appleId, ICLOUD_REMINDER_LISTS: config.icloudReminderLists.join(',') },
      })
    } catch { return resolve(null) }

    const finish = val => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { child.kill() } catch { /* egal */ }
      resolve(val)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.on('error', () => finish(null))
    child.on('close', () => {
      const line = out.split('\n').map(s => s.trim()).filter(Boolean).pop()
      if (!line) return finish(null)
      try {
        const resp = JSON.parse(line)
        if (resp.error) return finish(null)
        finish(resp.result ?? null)
      } catch { finish(null) }
    })
    child.stdin.write(JSON.stringify({ id: '1', op, args }) + '\n')  // Node schreibt UTF-8 ohne BOM
    child.stdin.end()
  })
}

// Rohdaten des Bridge -> [{title, due, overdue, list}] (offene, ueberfaellig zuerst).
// NUR relevante: verpasst (ueberfaellig), heute oder morgen faellig. Alles ohne
// Faelligkeit oder erst spaeter faellig wird ausgeblendet.
function mapReminders(result, limit = 20) {
  const now = new Date()
  const nowMs = now.getTime()
  // Ende von morgen (lokale Zeit) = Mitternacht in 2 Tagen
  const endOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 2).getTime()
  const out = []
  for (const r of result) {
    if (!r || r.completed) continue
    const title = String(r.title ?? '').trim() || '(ohne Titel)'
    const notes = r.notes ? String(r.notes) : null
    if (isAppleStub(title, notes)) continue
    const d = r.due ? new Date(r.due) : null
    const due = d && !isNaN(d.getTime()) ? d : null
    if (!due || due.getTime() >= endOfTomorrow) continue   // nur verpasst/heute/morgen
    out.push({ title, due, overdue: due.getTime() < nowMs, list: r.list ?? '' })
  }
  out.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
    const ad = a.due ? a.due.getTime() : Infinity
    const bd = b.due ? b.due.getTime() : Infinity
    return ad - bd
  })
  return out.slice(0, limit)
}

// ── Cache: im Speicher + auf Platte persistiert ──────────────────────────────
// Jede Apple-Abfrage dauert ~85s (CloudKit-Backoff, auch im lebenden Prozess).
// Deshalb: Ergebnis auf Platte schreiben -> beim Neustart SOFORT warm (kein
// Prewarm-Warten). Ein Hintergrund-Intervall haelt den Cache aktuell.
let cache = { items: null, at: 0 }   // items: [{title, due:Date|null, list}]
let refreshing = false
let intervalStarted = false
let onRefreshedCb = null              // feuert nach jedem erfolgreichen Refresh

function persist() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ at: cache.at, items: cache.items }))
  } catch (e) {
    console.warn('[reminders] Cache speichern fehlgeschlagen:', e.message)
  }
}

function loadFromDisk() {
  if (cache.items) return
  try {
    const obj = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
    if (Array.isArray(obj.items)) {
      cache = {
        at: obj.at || 0,
        items: obj.items.map(i => ({ title: i.title, due: i.due ? new Date(i.due) : null, list: i.list || '' })),
      }
      const age = Math.round((Date.now() - cache.at) / 60000)
      console.log(`[reminders] Cache von Platte: ${cache.items.length} Eintraege (${age} min alt)`)
    }
  } catch { /* keine/kaputte Datei -> egal, wird gleich neu geholt */ }
}

async function refresh() {
  if (refreshing) return
  refreshing = true
  const t0 = Date.now()
  try {
    const result = await callBridge('list_reminders', { only_open: true })
    if (Array.isArray(result)) {
      // nur die relevanten Felder halten (due als Date); overdue kommt beim Lesen
      cache = { items: mapReminders(result).map(({ title, due, list }) => ({ title, due, list })), at: Date.now() }
      persist()
      console.log(`[reminders] Cache erneuert: ${cache.items.length} relevant (${((Date.now() - t0) / 1000).toFixed(0)}s)`)
      try { onRefreshedCb && onRefreshedCb() } catch { /* egal */ }   // Render-Caches invalidieren -> sofort sichtbar
    } else {
      console.warn('[reminders] Refresh lieferte keine Daten (Auth/Bridge?).')
    }
  } finally {
    refreshing = false
  }
}

// Callback, der nach jedem erfolgreichen Reminder-Refresh feuert. server.mjs nutzt
// ihn, um die Render-/Datencaches zu invalidieren -> frische Erinnerungen sofort
// sichtbar (statt bis zum naechsten 5-Min-Datencache-Refresh zu warten).
export function onRemindersRefreshed(cb) { onRefreshedCb = cb }

// Sofortigen Refresh anstossen (z.B. direkt nach erfolgreichem 2FA-Setup), damit die
// Erinnerungen nicht erst beim naechsten Intervall geladen werden.
export function refreshRemindersNow() { return refresh() }

// Beim Serverstart: Platten-Cache laden (sofort warm) + Hintergrund-Loop starten.
export function prewarmReminders() {
  if (!config.reminderAppleId) return
  loadFromDisk()
  refresh()   // frische Daten holen (im Hintergrund)
  if (!intervalStarted) {
    intervalStarted = true
    setInterval(refresh, REFRESH_MS)   // haelt den Cache automatisch aktuell
  }
}

// -> [{title, due, overdue, list}] aus dem Cache (overdue frisch berechnet), oder null.
// Blockiert NIE; loest bei veraltetem Cache eine Hintergrund-Aktualisierung aus.
export async function getReminders(limit = 6) {
  if (!config.reminderAppleId) return null
  if (!cache.items) loadFromDisk()                     // Fallback, falls prewarm nicht lief
  if (Date.now() - cache.at > REFRESH_MS) refresh()    // fire-and-forget
  if (!cache.items) return null
  const now = Date.now()
  const items = cache.items.map(r => ({ ...r, overdue: !!(r.due && r.due.getTime() < now) }))
  items.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1
    const ad = a.due ? a.due.getTime() : Infinity
    const bd = b.due ? b.due.getTime() : Infinity
    return ad - bd
  })
  return items.slice(0, limit)
}
