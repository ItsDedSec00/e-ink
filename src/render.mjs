// eInk-Renderer: EinkData -> Satori (JSX-frei) -> SVG -> PNG, 800x480, 4-Farb-Look (BWRY).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { rgbaToBwryPacked } from './quantize.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FONT_DIR = path.join(__dirname, '..', 'fonts')

// ── 4-Farb-Palette (Panel: nur Schwarz/Weiß/Rot/Gelb, KEINE Graustufen) ──
const INK = '#111111', PAPER = '#FFFFFF', RED = '#D81E1E', AMBER = '#E8A200'
// Event-Stile je Kalender-Typ
const EVENT_STYLE = {
  primary:   { bg: AMBER, fg: INK,   fw: 700, border: 'none' },               // primäre iCloud-Kalender
  ical:      { bg: RED,   fg: PAPER, fw: 700, border: 'none' },               // öffentliche iCal-Feeds
  secondary: { bg: PAPER, fg: INK,   fw: 400, border: `1.5px solid ${INK}` }, // andere iCloud: Rahmen (BWRY-tauglich)
}

// ── Hyperscript-Helfer (satori akzeptiert {type, props}) ──
const h = (type, props, ...children) => ({ type, props: { ...(props || {}), children: children.flat().filter(c => c !== null && c !== false) } })
const styled = (dir, props, c) => h('div', { ...props, style: { display: 'flex', flexDirection: dir, ...(props?.style || {}) } }, ...c)
const row = (props, ...c) => styled('row', props, c)
const col = (props, ...c) => styled('column', props, c)
const txt = (style, s) => h('div', { style: { display: 'flex', ...style } }, String(s))
const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s }
// Emojis entfernen — die Inter-Schrift hat keine Emoji-Glyphen (sonst Tofu-Kaestchen),
// und auf dem BWRY-Panel sind sie ohnehin nicht sinnvoll darstellbar. Ziffern/Text bleiben.
const stripEmoji = s => String(s)
  .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}︎️‍⃣]/gu, '')
  .replace(/\s{2,}/g, ' ')
  .trim()

// BWRY-Lesbarkeit: Amber/Gelb ist als Text auf Weiss auf echtem eInk NICHT lesbar.
// -> Amber (und Rot) nur als FUELLUNG mit Schrift drauf: schwarz auf Amber / weiss auf Rot.
const badge = (text, bg, fg, fontSize = 14) => h('div', {
  style: { display: 'flex', backgroundColor: bg, color: fg, fontSize, fontWeight: 700, padding: '1px 7px', borderRadius: 5 },
}, String(text))
// Delta-Anzeige je Ampelstufe: crit = weiss auf Rot, warn = schwarz auf Amber,
// sonst schlicht schwarze Schrift OHNE Badge (kein Highlight, wenn alles ok).
const deltaBadge = (text, level) =>
  level === 'crit' ? badge(text, RED, PAPER)
  : level === 'warn' ? badge(text, AMBER, INK)
  : txt({ fontSize: 14, fontWeight: 700, color: INK, paddingLeft: 7 }, text)

// ── Business kompakt: nur Summen (Label + Total + Delta-Badge), keine App-Aufschluesselung ──
const KPI_TOTAL_W = 66, KPI_DELTA_W = 80
const kpiRow = k => row({ style: { alignItems: 'center', height: 30 } },
  txt({ flex: 1, fontSize: 16, fontWeight: 700, color: INK }, k.label),
  txt({ width: KPI_TOTAL_W, fontSize: 18, fontWeight: 700, color: INK, justifyContent: 'flex-end' }, k.total),
  h('div', { style: { display: 'flex', width: KPI_DELTA_W, justifyContent: 'flex-start', paddingLeft: 10 } }, deltaBadge(k.delta, k.level)))

// Kleine Akkuanzeige (Icon + %). Rot bei <=15%. Batteriestand kommt vom ESP32.
const batteryIcon = pct => {
  const p = Math.max(0, Math.min(100, Math.round(pct)))
  const c = p <= 15 ? RED : INK
  return row({ style: { alignItems: 'center' } },
    h('div', { style: { display: 'flex', width: 22, height: 11, border: `2px solid ${c}`, borderRadius: 2, padding: '1px', alignItems: 'center' } },
      h('div', { style: { display: 'flex', width: `${p}%`, height: '100%', backgroundColor: c, borderRadius: 1 } })),
    h('div', { style: { display: 'flex', width: 2, height: 4, backgroundColor: c, marginLeft: 1, borderRadius: 1 } }),
    txt({ fontSize: 11, fontWeight: 700, color: c, marginLeft: 5 }, `${p}%`))
}

// ── Server-Metrik: ok = schwarze Zahl; warn = schwarz auf Amber; crit = weiss auf Rot ──
const metricVal = pct => {
  if (pct <= 50) return txt({ fontSize: 20, fontWeight: 700, color: INK }, `${pct}%`)
  return pct <= 80 ? badge(`${pct}%`, AMBER, INK, 18) : badge(`${pct}%`, RED, PAPER, 18)
}
const metric = (label, pct) => row({ style: { alignItems: 'center', flex: 1 } },
  txt({ fontSize: 14, fontWeight: 700, color: INK, marginRight: 6 }, label),
  metricVal(pct))

// ── Erinnerungen: Kreis-Bullet + Titel; ueberfaellig in Rot (Bullet + Schrift) ──
const REM_MAX = 11   // so viele passen in den Bereich unter der Ueberschrift
const reminderRow = r => row({ style: { alignItems: 'center', paddingTop: 4, paddingBottom: 4 } },
  h('div', { style: { display: 'flex', width: 12, height: 12, borderRadius: 6, border: `2px solid ${r.overdue ? RED : INK}`, marginRight: 9, flexShrink: 0 } }),
  // volle Breite nutzen: einzeilig, am tatsaechlichen Rand mit … abschneiden
  h('div', { style: { display: 'flex', flex: 1, minWidth: 0, fontSize: 14, fontWeight: r.overdue ? 700 : 400, color: r.overdue ? RED : INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, stripEmoji(r.title)))
function renderReminders(rem) {
  if (!rem || !rem.length) return [txt({ fontSize: 14, color: INK, marginTop: 2 }, 'Nichts fällig heute/morgen')]
  return rem.slice(0, REM_MAX).map(reminderRow)
}

// ── Fenster-Status: flacher Streifen, weiss (zu) / komplett rot (offen).
// Links die aktuelle Aussentemperatur, mittig der "Fenster"-Text. ──
const fensterStrip = (open, temp) => h('div', {
  style: { display: 'flex', height: 44, borderTop: `2px solid ${INK}`, backgroundColor: open ? RED : PAPER, alignItems: 'center', justifyContent: 'center', position: 'relative' },
},
  temp != null ? txt({ position: 'absolute', left: 16, fontSize: 17, fontWeight: 700, color: open ? PAPER : INK }, `${temp}°C`) : false,
  txt({ fontSize: 17, fontWeight: 700, color: open ? PAPER : INK }, 'Fenster'))

// ── Kalender als iOS-artige Tages-Timeline (heute + morgen), volle Hoehe ──
// HEAD_H = Spaltenkopf (Datum + gross gesetztes Wetter). Es gibt keinen Seiten-
// kopf mehr — das Datum steht nur noch hier in den Spalten.
const TIMELINE_H = 390, HEAD_H = 84, AXIS_W = 30, EVENT_MIN_H = 24
const pad2 = n => String(n).padStart(2, '0')

// UV-Index: niedrig = schwarze Zahl, hoch (>=6) = Amber-Badge, sehr hoch (>=8) = Rot
const uvBadge = uv => {
  if (uv == null) return txt({ fontSize: 13, color: INK }, 'UV –')
  if (uv >= 8) return badge(`UV ${uv}`, RED, PAPER, 13)
  if (uv >= 6) return badge(`UV ${uv}`, AMBER, INK, 13)
  return txt({ fontSize: 13, fontWeight: 700, color: INK }, `UV ${uv}`)
}

// Ein Spaltenkopf pro Kalendertag (gestapelt, zentriert):
//   Datum (klein)  /  Wetterlage LINKS neben Temperatur (gross)  /  UV
const dayHeaderCell = (d, w, i) => col({
  style: { flex: 1, height: HEAD_H, alignItems: 'center', justifyContent: 'center', padding: '0 6px', overflow: 'hidden', borderLeft: i === 0 ? 'none' : `1px solid ${INK}` },
},
  txt({ fontSize: 13, fontWeight: d.isToday ? 700 : 600, color: INK }, d.label),
  row({ style: { alignItems: 'baseline', marginTop: 4 } },
    txt({ fontSize: 15, fontWeight: 700, color: INK, marginRight: 6 }, w ? (w.text || '—') : '—'),
    txt({ fontSize: 20, fontWeight: 700, color: INK }, w && w.tmax != null ? `${w.tmax}°` : '–'),
    txt({ fontSize: 14, fontWeight: 400, color: INK, marginLeft: 4 }, w && w.tmin != null ? `${w.tmin}°` : '')),
  h('div', { style: { display: 'flex', marginTop: 4 } }, uvBadge(w?.uvMax)))

// iOS-Kalender-Stil: ueberlappende Termine nebeneinander. Weist jedem Event
// _col (Spaltenindex) + _cols (Spaltenanzahl im Ueberlappungs-Cluster) zu.
function layoutDayEvents(events) {
  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin)
  let columns = [], group = [], groupMaxEnd = -Infinity
  const flush = () => { for (const e of group) e._cols = columns.length; group = []; columns = []; groupMaxEnd = -Infinity }
  for (const ev of sorted) {
    if (ev.startMin >= groupMaxEnd) flush()                    // Cluster zu Ende -> neuer Cluster
    let ci = columns.findIndex(end => end <= ev.startMin)      // erste freie Spalte
    if (ci === -1) { ci = columns.length; columns.push(ev.endMin) } else { columns[ci] = ev.endMin }
    ev._col = ci
    group.push(ev)
    groupMaxEnd = Math.max(groupMaxEnd, ev.endMin)
  }
  flush()
  return sorted
}

function eventBlock(ev, winStart, winLen) {
  const top = Math.round((ev.startMin - winStart) / winLen * TIMELINE_H)
  const height = Math.max(EVENT_MIN_H, Math.round((ev.endMin - ev.startMin) / winLen * TIMELINE_H))
  const st = EVENT_STYLE[ev.kind] || EVENT_STYLE.secondary
  const nCols = ev._cols || 1
  const wPct = 100 / nCols
  const leftPct = (ev._col || 0) * wPct
  // Aussen: transparenter Platzhalter (Spaltenanteil) mit 2px Innenabstand = Luecke
  // zwischen nebeneinander liegenden Terminen. Innen: der farbige Block.
  return h('div', { style: { position: 'absolute', top, height, left: `${leftPct}%`, width: `${wPct}%`, padding: '0 2px', display: 'flex' } },
    h('div', { style: { flex: 1, backgroundColor: st.bg, border: st.border, borderRadius: 4, padding: '1px 5px', display: 'flex', flexDirection: 'column', overflow: 'hidden' } },
      txt({ fontSize: 14, fontWeight: st.fw, color: st.fg, lineHeight: 1.1 }, stripEmoji(ev.title))))
}

function renderCalendar(cal, weatherDays) {
  if (!cal || !cal.days?.length) return [col({ style: { flex: 1, alignItems: 'center', justifyContent: 'center' } }, txt({ fontSize: 16, color: INK }, 'Kalender nicht erreichbar'))]

  const winStart = 0, winEnd = 24 * 60, winLen = winEnd - winStart
  const step = winLen / 60 > 9 ? 2 : 1
  const hours = []
  for (let hh = Math.ceil(winStart / 60); hh * 60 <= winEnd; hh += step) hours.push(hh)
  const yOf = hh => Math.round((hh * 60 - winStart) / winLen * TIMELINE_H)

  const axisCol = h('div', { style: { position: 'relative', display: 'flex', width: AXIS_W, height: TIMELINE_H } },
    ...hours.map(hh => txt({ position: 'absolute', top: Math.max(0, yOf(hh) - 7), width: AXIS_W, fontSize: 11, color: INK, justifyContent: 'flex-end', paddingRight: 4 }, pad2(hh))))

  // Keine grauen Linien mehr (auf dem eInk unsichtbar): weder Stundenlinien noch
  // graue Spaltentrenner. Nur ein schwarzer Trenner zwischen den beiden Tagen;
  // die Zeit liefert die Stundenachse links.
  const dayCol = (d, i) => h('div', { style: { position: 'relative', display: 'flex', flex: 1, height: TIMELINE_H, borderLeft: i === 0 ? 'none' : `1px solid ${INK}` } },
    ...layoutDayEvents(d.events).map(ev => eventBlock(ev, winStart, winLen)))

  // Spaltenkopf: Datum links + Wetter rechts, Hoehe wie der Seitenkopf (HEAD_H).
  const headRow = row({ style: { height: HEAD_H, borderBottom: `2px solid ${INK}` } },
    h('div', { style: { display: 'flex', width: AXIS_W } }),
    ...cal.days.map((d, i) => dayHeaderCell(d, weatherDays?.[i], i)))

  return [headRow, row({ style: { height: TIMELINE_H } }, axisCol, ...cal.days.map((d, i) => dayCol(d, i)))]
}

function layout(d) {
  const win = d.windows || { open: false }
  return row({ style: { width: 800, height: 480, backgroundColor: PAPER, fontFamily: 'Inter', color: INK } },
    // LINKE Spalte: schmaler, damit rechts 3 Kalendertage komfortabel passen.
    // Kein Datum-Kopf (steht im Kalender), keine Server-Stats (nicht live).
    col({ style: { width: 285, borderRight: `2px solid ${INK}` } },
      // Business (nur Summen) — Ueberschrift links, Akkuanzeige rechts in der Ecke
      col({ style: { padding: '14px 16px 10px' } },
        row({ style: { alignItems: 'center', marginBottom: 6 } },
          txt({ fontSize: 12, fontWeight: 700, color: INK, letterSpacing: 2, flex: 1 }, 'BUSINESS'),
          d.battery != null ? batteryIcon(d.battery) : false),
        ...d.kpis.map(kpiRow)),
      // Erinnerungen: Ueberschrift + klar darunter beginnende Liste (Ueberlauf geklippt,
      // damit nichts vor die Ueberschrift rutscht); nur so viele wie Platz.
      col({ style: { borderTop: `2px solid ${INK}`, padding: '10px 18px', flex: 1, overflow: 'hidden' } },
        txt({ fontSize: 12, fontWeight: 700, color: INK, letterSpacing: 2, marginBottom: 12 }, 'ERINNERUNGEN'),
        col({ style: { flex: 1, overflow: 'hidden' } }, ...renderReminders(d.reminders))),
      // Fenster-Streifen (unten, ueber die volle Breite eingefaerbt)
      fensterStrip(win.open, d.header.temp)),
    // RECHTE Spalte: Kalender ueber die VOLLE Hoehe (kein Kopfbalken darueber).
    // KEIN seitliches Padding -> die Unterlinie des Spaltenkopfs stoesst luecken-
    // los an die Trennlinie der linken Spalte (Zellen haben eigenes Innen-Padding).
    col({ style: { flex: 1, padding: '0 0 6px' } },
      ...renderCalendar(d.calendar, d.weatherDays)))
}

let fontsCache = null
function loadFonts() {
  if (!fontsCache) fontsCache = [
    { name: 'Inter', data: fs.readFileSync(path.join(FONT_DIR, 'Inter-Regular.ttf')), weight: 400, style: 'normal' },
    { name: 'Inter', data: fs.readFileSync(path.join(FONT_DIR, 'Inter-SemiBold.ttf')), weight: 600, style: 'normal' },
    { name: 'Inter', data: fs.readFileSync(path.join(FONT_DIR, 'Inter-Bold.ttf')), weight: 700, style: 'normal' },
  ]
  return fontsCache
}

// Gemeinsamer Schritt: Layout -> Satori-SVG -> resvg-Render (RGBA + asPng()).
async function renderResvg(d) {
  const svg = await satori(layout(d), { width: 800, height: 480, fonts: loadFonts() })
  return new Resvg(svg, { fitTo: { mode: 'width', value: 800 } }).render()
}

// 800x480 PNG (fuer Vorschau / GET /eink).
export async function renderEinkPng(d) {
  return Buffer.from((await renderResvg(d)).asPng())
}

// Gepackter 4-Farb-Puffer (2 Bit/Pixel, 96000 Bytes) fuer den ESP32 (GET /eink.bin).
export async function renderEinkPacked(d) {
  const img = await renderResvg(d)
  return rgbaToBwryPacked(img.pixels, img.width, img.height)
}
