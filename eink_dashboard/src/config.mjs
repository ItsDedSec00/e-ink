// Zentrale Konfiguration — liest .env. Fehlende Keys sind ok: dann greift der Mock-Fallback.
// .env wird MODUL-RELATIV geladen (App-Verzeichnis, ein Level ueber src/), damit sie
// unabhaengig vom Arbeitsverzeichnis gefunden wird (lokal wie im HA-Container; fehlt
// die Datei, ist es ein No-op und die ENV kommt aus den Add-on-Optionen).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env'), quiet: true })

const env = process.env

export const config = {
  // Optionale App-Admin-APIs (Server-Metriken + Nutzerzahlen) fuer bis zu zwei Apps.
  // URLs + Keys via .env (APP1_*/APP2_*). Ohne Keys werden diese Werte gemockt.
  app1: {
    url: env.APP1_API_URL || 'https://your-app.example.com/api/admin/live',
    key: env.APP1_API_KEY || '',
  },
  app2: {
    url: env.APP2_API_URL || 'https://your-other-app.example.com/api/admin/live',
    key: env.APP2_API_KEY || '',
  },
  // Zahlungs- & Kosten-APIs
  stripeKey: env.STRIPE_SECRET_KEY || '',
  veniceKey: env.VENICE_ADMIN_KEY || '',
  falKey: env.FAL_ADMIN_KEY || '',
  openrouterKey: env.OPENROUTER_ADMIN_KEY || '',
  fxFallbackUsdToEur: 0.92,
  // Kostenzuordnung: welche Cost-Key-/Produktnamen (Substrings, komma-getrennt) App 1
  // bzw. App 2 zugeschlagen werden — haelt konkrete Produktnamen aus dem Code (via
  // .env). Leer = keine Zuordnung (solche Kosten fallen in den Bucket 'Others').
  primaryAppMatch: (env.APP_PRIMARY_MATCH || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  secondaryAppMatch: (env.APP_SECONDARY_MATCH || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),

  // iCloud-Kalender (CalDAV, app-spezifisches Passwort)
  icloudUser: env.ICLOUD_USER || '',
  icloudAppPw: env.ICLOUD_APP_PW || '',
  // Nur diese iCloud-Kalender anzeigen (Anzeigenamen, ⚠️/Emojis werden ignoriert)
  icloudCalendars: (env.ICLOUD_CALENDARS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Öffentliche iCal-Feeds (ICS-URLs oder webcal://), komma-getrennt
  icalUrls: (env.ICAL_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
  // iCloud-Erinnerungslisten — Whitelist nach Name/UUID; leer = alle
  icloudReminderLists: (env.ICLOUD_REMINDER_LISTS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Erinnerungen laufen NICHT über CalDAV (das sieht die modernen iOS-13+-Reminders
  // nicht), sondern über eine pyicloud-Python-Bridge. Pfade + Apple-ID via .env bzw.
  // (im HA-Add-on) via Optionen setzen — siehe .env.example / DOCS.md.
  reminderAppleId: env.ICLOUD_APPLE_ID || env.ICLOUD_USER || '',
  reminderBridgePy: env.REMINDER_BRIDGE_PY || '',
  reminderBridgeScript: env.REMINDER_BRIDGE_SCRIPT || '',
  // Hintergrund-Refresh-Intervall der Erinnerungen (Minuten). Jede Apple-Abfrage
  // dauert ~85s, daher nicht sinnvoll unter ~2 min. Cache wird auf Platte persistiert.
  reminderRefreshMs: Math.max(60, Number(env.REMINDER_REFRESH_MIN || 5) * 60) * 1000,
  reminderCacheFile: env.REMINDER_CACHE_FILE || '',   // leer -> Default im Projekt-Root

  // Service
  port: Number(env.EINK_PORT || 8080),
  einkKey: env.EINK_KEY || '',          // optionales Shared Secret für GET /eink
  tz: env.EINK_TZ || 'Europe/Berlin',
  // Fenster-Status: bevorzugt echte HA-Fenstersensoren (windowSensors), sonst der
  // statische Platzhalter EINK_WINDOWS_OPEN=true -> roter Streifen.
  windowsOpen: env.EINK_WINDOWS_OPEN === 'true',
  // Home Assistant Core API (im Add-on: SUPERVISOR_TOKEN + homeassistant_api:true).
  // Lokal/standalone via HA_BASE_URL + HA_TOKEN ueberschreibbar.
  haBaseUrl: env.HA_BASE_URL || (env.SUPERVISOR_TOKEN ? 'http://supervisor/core/api' : ''),
  haToken: env.HA_TOKEN || env.SUPERVISOR_TOKEN || '',
  // Fenster-Sensoren: binary_sensor-Entity-IDs, komma-getrennt (offen -> roter Streifen).
  windowSensors: (env.WINDOW_SENSORS || '').split(',').map(s => s.trim()).filter(Boolean),

  // Wetter (Open-Meteo, kein Key nötig). Koordinaten optional — sonst wird die Stadt geocodet.
  weatherCity: env.EINK_WEATHER_CITY || 'München',
  weatherLat: env.EINK_LAT ? Number(env.EINK_LAT) : null,
  weatherLon: env.EINK_LON ? Number(env.EINK_LON) : null,
}

// True, wenn die KPI-Quellen konfiguriert sind. Sonst Mock-Daten.
export const hasLiveKpis = Boolean(config.stripeKey && config.app1.key)
