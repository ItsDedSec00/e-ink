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
// Textbox mit display:block. Satori verlangt dafuer, dass children KEIN Array ist
// (sonst: "Expected <div> to have explicit display: flex") - deshalb hier von Hand
// statt ueber h(). Nur auf diesem Pfad greift lineClamp (siehe reminderRow).
const blockTxt = (style, s) => ({ type: 'div', props: { style: { display: 'block', ...style }, children: String(s) } })
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

// ── Erinnerungen: Kreis-Bullet + Titel; ueberfaellig in Rot (Bullet + Schrift) ──
// Seit dem Wegfall des Business-Blocks fuellt die Liste die linke Spalte und darf
// MEHRZEILIG umbrechen (vorher: eine Zeile, Rest mit … abgeschnitten). Wie viele
// Eintraege passen, haengt damit von der Textlaenge ab -> Zeilen schaetzen und
// gegen die verfuegbare Hoehe budgetieren, statt stur N Eintraege zu nehmen.
const REM_FONT = 14
const REM_LINE_H = 1.3                       // Zeilenabstand (auch im Style gesetzt)
const REM_MAX_LINES = 3                      // danach kappt lineClamp mit …
const REM_ROW_PAD = 8                        // paddingTop + paddingBottom je Eintrag
const REM_LIST_H = 380                       // Platz unter der Ueberschrift (siehe layout)
// Textbreite = Spaltenbreite - seitliches Padding (2x18) - Bullet (12) - Abstand (9).
const REM_TEXT_W = 285 - 36 - 21
// Inter-Mischtext liegt bei gut der halben Schriftgroesse pro Zeichen; das reicht
// als Schaetzer fuer den Umbruch (Satori bricht exakt um, wir planen nur den Platz).
const REM_CHARS_PER_LINE = Math.max(10, Math.floor(REM_TEXT_W / (REM_FONT * 0.52)))
const remLines = title => Math.min(REM_MAX_LINES, Math.max(1, Math.ceil(String(title).length / REM_CHARS_PER_LINE)))
const remRowH = lines => REM_ROW_PAD + Math.round(lines * REM_FONT * REM_LINE_H)

const reminderRow = r => row({ style: { alignItems: 'flex-start', paddingTop: 4, paddingBottom: 4 } },
  // Bullet auf der ersten Zeile ausrichten (marginTop ~ (Zeilenhoehe - Bullet) / 2)
  h('div', { style: { display: 'flex', width: 12, height: 12, borderRadius: 6, border: `2px solid ${r.overdue ? RED : INK}`, marginRight: 9, marginTop: 3, flexShrink: 0 } }),
  // Mehrzeilig: display:block + lineClamp kappt nach REM_MAX_LINES Zeilen mit …
  // (mit display:flex bricht Satori endlos um und ignoriert lineClamp).
  blockTxt({
    flex: 1, minWidth: 0, fontSize: REM_FONT, lineHeight: REM_LINE_H,
    fontWeight: r.overdue ? 700 : 400, color: r.overdue ? RED : INK,
    lineClamp: REM_MAX_LINES,
  }, stripEmoji(r.title)))

function renderReminders(rem) {
  if (!rem || !rem.length) return [txt({ fontSize: REM_FONT, color: INK, marginTop: 2 }, 'Nichts fällig heute/morgen')]
  const out = []
  let used = 0
  for (const r of rem) {
    const need = remRowH(remLines(stripEmoji(r.title)))
    if (out.length && used + need > REM_LIST_H) break   // mind. ein Eintrag, dann nach Platz
    used += need
    out.push(reminderRow(r))
  }
  return out
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
    // Kein Datum-Kopf (steht im Kalender), keine Business-KPIs mehr.
    col({ style: { width: 285, borderRight: `2px solid ${INK}` } },
      // Erinnerungen ganz oben (der Business-Block ist entfallen) und ueber die
      // volle Spaltenhoehe: Ueberschrift links, Akkuanzeige rechts in der Ecke.
      // Ueberlauf geklippt, damit nichts in den Fenster-Streifen rutscht.
      col({ style: { padding: '14px 18px 10px', flex: 1, overflow: 'hidden' } },
        row({ style: { alignItems: 'center', marginBottom: 10 } },
          txt({ fontSize: 12, fontWeight: 700, color: INK, letterSpacing: 2, flex: 1 }, 'ERINNERUNGEN'),
          d.battery != null ? batteryIcon(d.battery) : false),
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
