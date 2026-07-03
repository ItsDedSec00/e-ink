// Home-Assistant Core API. Im Add-on automatisch verfuegbar via SUPERVISOR_TOKEN
// (braucht `homeassistant_api: true` in config.yaml). Lokal/standalone via
// HA_BASE_URL + HA_TOKEN ueberschreibbar (z.B. fuer Tests). Ohne Token/Config
// sind die Funktionen No-ops (Fenster faellt auf den statischen Platzhalter zurueck).
import fs from 'node:fs'
import { config } from '../config.mjs'

const OPEN_STATES = new Set(['on', 'open', 'offen', 'true'])
// Persistierte Fenster-Auswahl (ueber die Web-UI gesetzt). Im Add-on unter /data.
const SELECTION_FILE = config.windowSelectionFile || 'window_sensors.json'

// --- HA Core API ---
async function haGet(pathStr) {
  const { haBaseUrl, haToken } = config
  if (!haBaseUrl || !haToken) return null
  try {
    const res = await fetch(`${haBaseUrl}${pathStr}`, {
      headers: { Authorization: `Bearer ${haToken}` }, cache: 'no-store',
    })
    if (!res.ok) return null
    return await res.json()
  } catch { return null }
}

// --- Fenster-Auswahl (persistiert) ---
// Bevorzugt die per UI gespeicherte Liste, sonst die WINDOW_SENSORS-Env als Default.
export function readSelectedWindows() {
  try {
    const arr = JSON.parse(fs.readFileSync(SELECTION_FILE, 'utf8'))
    if (Array.isArray(arr)) return arr.filter(s => typeof s === 'string' && s)
  } catch { /* keine/kaputte Datei -> Env-Default */ }
  return config.windowSensors
}

export function saveSelectedWindows(ids) {
  const clean = Array.isArray(ids)
    ? [...new Set(ids.filter(s => typeof s === 'string' && s.includes('.')))]
    : []
  try { fs.writeFileSync(SELECTION_FILE, JSON.stringify(clean)) }
  catch (e) { console.warn('[hass] Fenster-Auswahl speichern fehlgeschlagen:', e.message) }
  return clean
}

// Kandidaten fuer die UI-Auswahl: alle binary_sensor-Entities, Fenster-/Tuer-Klassen
// zuerst. null wenn HA nicht erreichbar.
export async function getWindowCandidates() {
  const states = await haGet('/states')
  if (!Array.isArray(states)) return null
  const WIN = new Set(['window', 'door', 'opening', 'garage_door'])
  const list = states
    .filter(s => typeof s.entity_id === 'string' && s.entity_id.startsWith('binary_sensor.'))
    .map(s => ({
      id: s.entity_id,
      name: s.attributes?.friendly_name || s.entity_id,
      deviceClass: s.attributes?.device_class || '',
      open: OPEN_STATES.has(String(s.state).toLowerCase()),
    }))
  list.sort((a, b) => {
    const aw = WIN.has(a.deviceClass) ? 0 : 1, bw = WIN.has(b.deviceClass) ? 0 : 1
    return aw - bw || a.name.localeCompare(b.name)
  })
  return list
}

// Fenster offen? -> true wenn IRGENDEIN ausgewaehlter Sensor offen ist, false wenn
// alle zu, null wenn nichts ausgewaehlt / HA nicht erreichbar (Aufrufer nutzt Fallback).
export async function getWindowsOpen() {
  const { haBaseUrl, haToken } = config
  const sensors = readSelectedWindows()
  if (!haBaseUrl || !haToken || !sensors.length) return null
  const states = await Promise.all(sensors.map(async id => (await haGet(`/states/${encodeURIComponent(id)}`))?.state))
  const known = states.filter(s => s != null)
  if (!known.length) return null
  return known.some(s => OPEN_STATES.has(String(s).toLowerCase()))
}

// Feuert das HA-Event `eink_dashboard_button` mit { button: N } (0..2). Der Nutzer
// haengt in HA eine Automatisierung an dieses Event. -> true bei Erfolg.
export async function fireButtonEvent(button) {
  const { haBaseUrl, haToken } = config
  if (!haBaseUrl || !haToken) return false
  try {
    const res = await fetch(`${haBaseUrl}/events/eink_dashboard_button`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${haToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ button }),
    })
    return res.ok
  } catch { return false }
}
