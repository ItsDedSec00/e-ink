// Führt alle Quellen zur EinkData-Struktur zusammen, die der Renderer erwartet.
// Ohne konfigurierte Quellen (kein Kalender, keine Erinnerungen) -> Mock-Daten.
import { config, hasLiveSources } from './config.mjs'
import { getWeather } from './sources/weather.mjs'
import { getCalendar } from './sources/calendar.mjs'
import { getReminders } from './sources/reminders.mjs'

// ── Formatierung ──────────────────────────────────────────────────────────────
const DASH = '—'

// ── Header (Datum/Uhrzeit in lokaler TZ) ──────────────────────────────────────
function header(weather) {
  const tz = config.tz
  const now = new Date()
  const weekday = new Intl.DateTimeFormat('de-DE', { weekday: 'long', timeZone: tz }).format(now)
  const day = new Intl.DateTimeFormat('de-DE', { day: 'numeric', timeZone: tz }).format(now)
  const month = new Intl.DateTimeFormat('de-DE', { month: 'long', timeZone: tz }).format(now)
  // Uhrzeit bewusst NICHT mehr im Kopf (Refresh-Intervall macht sie ohnehin ungenau)
  return { weekday: weekday[0].toUpperCase() + weekday.slice(1), date: `${day}. ${month}`, ...weather }
}

// ── Mock (Demo ohne Kalender/Erinnerungen) ────────────────────────────────────
function mock() {
  return {
    header: header({ weather: 'Sonnig 21°C', city: config.weatherCity, temp: 21 }),
    battery: 87,
    weatherDays: [
      { text: 'Heiter', tmax: 24, tmin: 13, uvMax: 6 },
      { text: 'Wolkig', tmax: 21, tmin: 12, uvMax: 4 },
      { text: 'Regen',  tmax: 18, tmin: 11, uvMax: 3 },
    ],
    calendar: { days: [
      { label: 'Di – 2. Juni', isToday: true, allDay: [], events: [
        { startMin: 10 * 60 + 15, endMin: 11 * 60 + 45, title: 'Team-Meeting' },
        { startMin: 14 * 60 + 30, endMin: 16 * 60, title: 'Projekt-Review' }] },
      { label: 'Mi – 3. Juni', isToday: false, allDay: [], events: [
        { startMin: 8 * 60 + 30, endMin: 10 * 60, title: 'Standup' },
        { startMin: 12 * 60 + 30, endMin: 14 * 60, title: 'Mittagessen' },
        { startMin: 20 * 60, endMin: 22 * 60, title: 'Sport' }] },
      { label: 'Do – 4. Juni', isToday: false, allDay: [], events: [
        { startMin: 9 * 60, endMin: 10 * 60 + 30, title: 'Planung' },
        { startMin: 15 * 60, endMin: 16 * 60, title: 'Termin' }] },
    ] },
    // Ein langer Titel ist Absicht: zeigt in der Vorschau den mehrzeiligen Umbruch.
    reminders: [
      { title: 'Rechnung bezahlen und Beleg ablegen, bevor die Frist ablaeuft', overdue: true },
      { title: 'Einkaufen gehen', overdue: false },
      { title: 'Paket abholen', overdue: false },
      { title: 'E-Mail beantworten', overdue: false },
      { title: 'Rückruf', overdue: false },
    ],
    windows: { open: config.windowsOpen },
    _mock: true,
  }
}

// ── Live ──────────────────────────────────────────────────────────────────────
// Nur noch die Quellen, die das Panel zeigt: Wetter, Kalender, Erinnerungen.
// Faellt eine aus, bleibt der Rest stehen (der Renderer zeigt den Platzhalter).
async function live() {
  const [weather, calendar, reminders] = await Promise.all([
    getWeather().catch(() => null),
    getCalendar().catch(() => null),
    getReminders(15).catch(() => null),
  ])

  return {
    header: header(weather ? { weather: weather.weather, city: weather.city, temp: weather.temp } : { weather: DASH, city: config.weatherCity, temp: null }),
    weatherDays: weather?.days ?? null,
    calendar, // { days: [...] } oder null -> Renderer zeigt Hinweis
    reminders, // [{title, due, overdue}] oder null
    windows: { open: config.windowsOpen }, // statischer Fallback; Live-Status setzt der Render-Pfad
    _mock: false,
  }
}

export async function getEinkData(opts = {}) {
  const d = hasLiveSources ? await live() : mock()
  if (opts.battery != null) d.battery = opts.battery   // Akkustand kommt vom ESP32 (Query-Param)
  return d
}
