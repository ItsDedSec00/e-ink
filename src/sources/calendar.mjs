// Kalender aus zwei Quellen: iCloud (CalDAV, gefiltert) + öffentliche iCal-Feeds (ICS-URLs).
// Liefert Timeline-Daten für HEUTE + MORGEN (iOS-Tagesansicht).
import { DAVClient } from 'tsdav'
import ical from 'node-ical'
import { config } from '../config.mjs'

const DAY_MS = 86400 * 1000

const ymd = d => new Intl.DateTimeFormat('en-CA', { timeZone: config.tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const minutesOfDay = d => {
  const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d).split(':').map(Number)
  return h * 60 + m
}
const dayLabel = d => {
  const wd = new Intl.DateTimeFormat('de-DE', { timeZone: config.tz, weekday: 'short' }).format(d).replace('.', '')
  const day = new Intl.DateTimeFormat('de-DE', { timeZone: config.tz, day: 'numeric' }).format(d)
  const mon = new Intl.DateTimeFormat('de-DE', { timeZone: config.tz, month: 'long' }).format(d)
  return `${wd} – ${day}. ${mon}`
}
const trunc = (s, n = 40) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
// Kalendername normalisieren (Emojis/⚠️ entfernen) für den Vergleich
const normName = s => String(s).replace(/[^\p{L}\p{N}&\s]/gu, '').replace(/\s+/g, ' ').trim().toLowerCase()

// Alle VEVENT-Vorkommen eines ICS im Fenster einsammeln (mit Start/Ende)
// kind: 'primary' (primäre iCloud-Kalender -> gelb) | 'secondary' (andere iCloud -> transparent/grau) | 'ical' (Feed -> rot)
function occurrencesFromICS(data, start, end, out, kind) {
  let parsed
  try { parsed = ical.sync.parseICS(data) } catch { return }
  for (const ev of Object.values(parsed)) {
    if (!ev || ev.type !== 'VEVENT' || !ev.start) continue
    const allDay = ev.datetype === 'date'
    const durMs = ev.end && ev.start ? Math.max(0, ev.end - ev.start) : 60 * 60000
    const summary = String(ev.summary ?? '').trim() || '(ohne Titel)'
    const push = (startAt, sum, dMs) => {
      if (startAt < start || startAt > end) return
      out.push({ start: startAt, end: new Date(startAt.getTime() + dMs), allDay, summary: trunc(String(sum)), kind })
    }
    if (ev.rrule) {
      let dates = []
      try { dates = ev.rrule.between(new Date(start.getTime() - DAY_MS), end, true) } catch { dates = [] }
      for (const occ of dates) {
        const key = ymd(occ)
        if (ev.exdate && ev.exdate[key]) continue
        const ov = ev.recurrences && ev.recurrences[key]
        if (ov) push(ov.start, ov.summary ?? summary, (ov.end && ov.start) ? ov.end - ov.start : durMs)
        else push(occ, summary, durMs)
      }
    } else {
      push(ev.start, summary, durMs)
    }
  }
}

// iCloud-Kalender (nur die in config.icloudCalendars gelisteten)
async function collectICloud(start, end, out) {
  if (!config.icloudUser || !config.icloudAppPw) return
  try {
    const client = new DAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: config.icloudUser, password: config.icloudAppPw },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    })
    await client.login()
    // Alle Kalender holen; nur die in ICLOUD_CALENDARS werden gelb hervorgehoben
    const highlight = config.icloudCalendars.map(normName)
    const calendars = await client.fetchCalendars()
    await Promise.all(calendars.map(async cal => {
      const kind = highlight.includes(normName(cal.displayName || '')) ? 'primary' : 'secondary'
      try {
        const objs = await client.fetchCalendarObjects({ calendar: cal, timeRange: { start: start.toISOString(), end: end.toISOString() } })
        for (const o of objs) if (o?.data) occurrencesFromICS(o.data, start, end, out, kind)
      } catch { /* Kalender überspringen */ }
    }))
  } catch { /* iCloud nicht erreichbar */ }
}

// Öffentliche iCal-Feeds (ICS-URLs / webcal://)
async function collectIcalFeeds(start, end, out) {
  await Promise.all(config.icalUrls.map(async raw => {
    try {
      const url = raw.replace(/^webcal:\/\//i, 'https://')
      const res = await fetch(url, { cache: 'no-store' })
      if (!res.ok) return
      occurrencesFromICS(await res.text(), start, end, out, 'ical') // öffentliche Feeds = rot
    } catch { /* Feed überspringen */ }
  }))
}

// -> { days: [{label, isToday, allDay:[titles], events:[{startMin,endMin,title}]}, ...] } oder null
export async function getCalendar() {
  if (!config.icloudUser && !config.icalUrls.length) return null

  const now = new Date()
  const start = new Date(now.getTime() - DAY_MS)
  const end = new Date(now.getTime() + 3 * DAY_MS)

  const items = []
  await Promise.all([collectICloud(start, end, items), collectIcalFeeds(start, end, items)])

  const today = new Date(now)
  const tomorrow = new Date(now.getTime() + DAY_MS)
  const dayAfter = new Date(now.getTime() + 2 * DAY_MS)
  const dayKeys = [ymd(today), ymd(tomorrow), ymd(dayAfter)]
  const days = [
    { key: dayKeys[0], label: dayLabel(today), isToday: true, allDay: [], events: [] },
    { key: dayKeys[1], label: dayLabel(tomorrow), isToday: false, allDay: [], events: [] },
    { key: dayKeys[2], label: dayLabel(dayAfter), isToday: false, allDay: [], events: [] },
  ]

  const rank = { primary: 3, ical: 2, secondary: 1 } // bei Dublette gewinnt höherer Rang
  const seenAllDay = new Set()
  const eventByKey = new Map()
  for (const it of items) {
    const dayKey = ymd(it.start)
    const idx = dayKeys.indexOf(dayKey)
    if (idx < 0) continue
    if (it.allDay) {
      const k = `${dayKey}|${it.summary}`
      if (seenAllDay.has(k)) continue; seenAllDay.add(k)
      days[idx].allDay.push(it.summary)
      continue
    }
    let startMin = minutesOfDay(it.start)
    let endMin = minutesOfDay(it.end)
    if (endMin <= startMin) endMin = 24 * 60
    const k = `${dayKey}|${startMin}|${endMin}|${it.summary}`
    const existing = eventByKey.get(k)
    if (existing) { if (rank[it.kind] > rank[existing.kind]) existing.kind = it.kind; continue }
    const obj = { startMin, endMin, title: it.summary, kind: it.kind }
    eventByKey.set(k, obj)
    days[idx].events.push(obj)
  }
  for (const d of days) d.events.sort((a, b) => a.startMin - b.startMin)

  return { days }
}
