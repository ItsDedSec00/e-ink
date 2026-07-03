// Home-Assistant Core API. Im Add-on automatisch verfuegbar via SUPERVISOR_TOKEN
// (braucht `homeassistant_api: true` in config.yaml). Lokal/standalone via
// HA_BASE_URL + HA_TOKEN ueberschreibbar (z.B. fuer Tests). Ohne Token/Config
// sind beide Funktionen No-ops (Fenster faellt auf den statischen Platzhalter zurueck).
import { config } from '../config.mjs'

const OPEN_STATES = new Set(['on', 'open', 'offen', 'true'])

// Fenster offen? -> true wenn IRGENDEIN konfigurierter Sensor offen ist, false wenn
// alle zu, null wenn nicht konfiguriert / HA nicht erreichbar (Aufrufer nutzt Fallback).
export async function getWindowsOpen() {
  const { haBaseUrl, haToken, windowSensors } = config
  if (!haBaseUrl || !haToken || !windowSensors.length) return null
  try {
    const states = await Promise.all(windowSensors.map(async id => {
      const res = await fetch(`${haBaseUrl}/states/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${haToken}` }, cache: 'no-store',
      })
      if (!res.ok) return null
      return (await res.json())?.state
    }))
    const known = states.filter(s => s != null)
    if (!known.length) return null
    return known.some(s => OPEN_STATES.has(String(s).toLowerCase()))
  } catch { return null }
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
