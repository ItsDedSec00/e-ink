// Führt alle Quellen zur EinkData-Struktur zusammen, die der Renderer erwartet.
// Ohne konfigurierte Keys (oder bei Fehlern der Pflichtquelle) -> Mock-Daten.
import { config, hasLiveKpis } from './config.mjs'
import { getApps } from './sources/apps.mjs'
import { getCost30dUsdByApp, getUsdToEur } from './sources/usage.mjs'
import { getStripe } from './sources/stripe.mjs'
import { getWeather } from './sources/weather.mjs'
import { getCalendar } from './sources/calendar.mjs'
import { getReminders } from './sources/reminders.mjs'

// ── Formatierung ──────────────────────────────────────────────────────────────
const DASH = '—'
const eur = n => (n == null ? DASH : n >= 10000 ? `€${(n / 1000).toFixed(1)}k` : `€${Math.round(n).toLocaleString('de-DE')}`)
const num = n => (n == null ? DASH : n >= 10000 ? `${(n / 1000).toFixed(1)}k` : Math.round(n).toLocaleString('de-DE'))
const signed = n => (n == null ? DASH : `${n >= 0 ? '+' : ''}${n}`)
const pctStr = n => (n == null ? DASH : `${Math.round(n)}%`)
const sumN = (...xs) => { const v = xs.filter(x => typeof x === 'number'); return v.length ? v.reduce((s, x) => s + x, 0) : null }
// Ampelstufe je KPI: unter warn -> 'warn' (amber), unter crit -> 'crit' (rot),
// sonst 'none' (schlicht, kein Highlight). crit ist immer der niedrigere Wert.
const levelBelow = (v, warn, crit) => (typeof v !== 'number' ? 'none' : v < crit ? 'crit' : v < warn ? 'warn' : 'none')

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

// ── Mock (Demo ohne Keys) ─────────────────────────────────────────────────────
function mock() {
  return {
    header: header({ weather: 'Sonnig 21°C', city: config.weatherCity, temp: 21 }),
    battery: 87,
    weatherDays: [
      { text: 'Heiter', tmax: 24, tmin: 13, uvMax: 6 },
      { text: 'Wolkig', tmax: 21, tmin: 12, uvMax: 4 },
      { text: 'Regen',  tmax: 18, tmin: 11, uvMax: 3 },
    ],
    kpis: [
      { label: 'MRR',    app1: eur(2100), app2: eur(1800), total: eur(4200), delta: '+5%',  level: 'none' },
      { label: 'Gewinn', app1: eur(1500), app2: eur(1000), total: eur(2800), delta: '66%',  level: 'none' },
      { label: 'Abos',   app1: num(72),   app2: num(48),   total: num(120),  delta: '+4',   level: 'none' },
      { label: 'Nutzer', app1: num(1800), app2: num(1400), total: num(3400), delta: '+120', level: 'none' },
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
    reminders: [
      { title: 'Rechnung bezahlen', overdue: true },
      { title: 'Einkaufen gehen', overdue: false },
      { title: 'Paket abholen', overdue: false },
      { title: 'E-Mail beantworten', overdue: false },
      { title: 'Rückruf', overdue: false },
    ],
    server: { cpu: 23, mem: 61, load: 42 },
    windows: { open: config.windowsOpen },
    _mock: true,
  }
}

// 3 Buttons (EE04 hat 3 Onboard-Taster GPIO2/3/5) — Belegung später via HA.
function placeholderButtons() {
  return [
    { label: 'Wohnzimmer', state: '', on: false },
    { label: 'Heizung',    state: '', on: false },
    { label: 'Gute Nacht', state: '', on: false },
  ]
}

// ── Live ──────────────────────────────────────────────────────────────────────
async function live() {
  const [stripe, apps, costUsd, fx, weather, calendar, reminders] = await Promise.all([
    getStripe().catch(() => null),
    getApps().catch(() => ({ server: null, users: { app1: {}, app2: {} }, ok: {} })),
    getCost30dUsdByApp().catch(() => ({ app1: 0, app2: 0, Others: 0 })),
    getUsdToEur().catch(() => config.fxFallbackUsdToEur),
    getWeather().catch(() => null),
    getCalendar().catch(() => null),
    getReminders(15).catch(() => null),
  ])

  // Pflichtquelle Stripe fehlt -> lieber Mock als kaputter Schirm
  if (!stripe) return { ...mock(), _mock: true, _note: 'Stripe nicht erreichbar' }

  // Marge: je App (MRR + One-time 30d) - API-Kosten(30d, USD->EUR); Summe ueber
  // beide App-Buckets.
  const revEur = app => (stripe.byApp[app].mrr + stripe.byApp[app].oneTime30d) / 100
  const costEur = app => (costUsd[app] || 0) * fx
  const marginEur = app => revEur(app) - costEur(app)
  const visibleApps = ['app1', 'app2']
  const totalMargin = visibleApps.reduce((s, a) => s + marginEur(a), 0)
  const totalRev = visibleApps.reduce((s, a) => s + revEur(a), 0)
  const totalMarginPct = totalRev > 0 ? (totalMargin / totalRev) * 100 : null

  const u = apps.users
  // Nutzer: NUR App 1 (primaere App); App 2 bewusst NICHT mitzaehlen.
  // MRR/Gewinn/Abos bleiben dagegen die Summe beider Apps.
  const usersTotal = u.app1?.total ?? null
  const usersGrowth = u.app1?.new30d ?? null

  return {
    header: header(weather ? { weather: weather.weather, city: weather.city, temp: weather.temp } : { weather: DASH, city: config.weatherCity, temp: null }),
    weatherDays: weather?.days ?? null,
    kpis: [
      // Ampel-Schwellen (User-Vorgabe): amber ab warn, rot ab crit — sonst schlicht.
      { label: 'MRR',    app1: eur(stripe.byApp.app1.mrr / 100), app2: eur(stripe.byApp.app2.mrr / 100), total: eur(stripe.totalMrr / 100), delta: stripe.revenueChange == null ? DASH : `${signed(stripe.revenueChange)}%`, level: levelBelow(stripe.revenueChange, -10, -50) },
      { label: 'Gewinn', app1: eur(marginEur('app1')), app2: eur(marginEur('app2')), total: eur(totalMargin), delta: pctStr(totalMarginPct), level: levelBelow(totalMarginPct, 50, 25) },
      { label: 'Abos',   app1: num(stripe.byApp.app1.subs), app2: num(stripe.byApp.app2.subs), total: num(stripe.totalSubs), delta: signed(stripe.subsChange), level: levelBelow(stripe.subsChange, -5, -25) },
      { label: 'Nutzer', app1: num(u.app1?.total ?? null), app2: num(u.app2?.total ?? null), total: num(usersTotal), delta: signed(usersGrowth), level: levelBelow(usersGrowth, 20, 5) },
    ],
    calendar, // { days: [...] } oder null -> Renderer zeigt Hinweis
    reminders, // [{title, due, overdue}] oder null
    server: apps.server ?? { cpu: 0, mem: 0, load: 0 },
    windows: { open: config.windowsOpen }, // Platzhalter bis HA
    _mock: false,
  }
}

export async function getEinkData(opts = {}) {
  const d = hasLiveKpis ? await live() : mock()
  if (opts.battery != null) d.battery = opts.battery   // Akkustand kommt vom ESP32 (Query-Param)
  return d
}
