// API-Kosten der letzten 30 Tage je App (USD), aus Venice / fal.ai / OpenRouter.
// Portiert aus dem Dashboard-lib usage.ts (nur der 30-Tage-Kostenanteil, den die Marge braucht).
import { config } from '../config.mjs'

export function classifyApp(label) {
  const l = String(label).toLowerCase()
  // Zuordnung nach Cost-Key-/Produktnamen aus der Config (via .env) — so bleibt der
  // Code frei von konkreten Produktnamen. Keine Treffer -> Bucket 'Others'.
  if (config.secondaryAppMatch.some(m => l.includes(m))) return 'app2'
  if (config.primaryAppMatch.some(m => l.includes(m))) return 'app1'
  return 'Others'
}

const emptyByApp = () => ({ app1: 0, app2: 0, Others: 0 })
const ymd = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

function addRows(into, rows) {
  for (const r of rows) into[classifyApp(r.label)] += Number(r.usd) || 0
}

async function venice(into) {
  if (!config.veniceKey) return
  try {
    const now = new Date()
    const start = ymd(new Date(now.getTime() - 30 * 86400 * 1000))
    const url = `https://api.venice.ai/api/v1/billing/usage-analytics?startDate=${start}&endDate=${ymd(now)}`
    const res = await fetch(url, { cache: 'no-store', headers: { Authorization: `Bearer ${config.veniceKey}`, Accept: 'application/json' } })
    if (!res.ok) return
    const json = await res.json()
    addRows(into, (json.byKey ?? []).map(r => ({ label: r.description?.trim() || String(r.apiKeyId ?? r.id ?? 'unknown'), usd: r.totalUsd })))
  } catch { /* still */ }
}

async function fal(into) {
  if (!config.falKey) return
  try {
    const now = new Date()
    const start = new Date(now.getTime() - 30 * 86400 * 1000).toISOString()
    const url = `https://api.fal.ai/v1/models/usage?start=${encodeURIComponent(start)}&end=${encodeURIComponent(now.toISOString())}&expand=summary,auth_method`
    const res = await fetch(url, { cache: 'no-store', headers: { Authorization: `Key ${config.falKey}`, Accept: 'application/json' } })
    if (!res.ok) return
    const json = await res.json()
    addRows(into, (json.summary ?? []).map(r => ({ label: String(r.auth_method ?? 'unknown'), usd: r.cost })))
  } catch { /* still */ }
}

async function openrouter(into) {
  if (!config.openrouterKey) return
  try {
    // WICHTIG: NICHT das /keys-Feld usage_monthly nehmen — das ist nur der KALENDER-
    // Monat-bis-heute (am 2. eines Monats also fast 0). Stattdessen /activity (Tages-
    // Granularitaet) summieren = echte rollierende 30 Tage.
    const res = await fetch('https://openrouter.ai/api/v1/activity', { cache: 'no-store', headers: { Authorization: `Bearer ${config.openrouterKey}`, Accept: 'application/json' } })
    if (!res.ok) return
    const rows = (await res.json())?.data ?? []
    const cutoff = Date.now() - 30 * 86400 * 1000
    let total = 0
    for (const r of rows) {
      const t = new Date(String(r.date).replace(' ', 'T') + 'Z').getTime()
      if (isFinite(t) && t >= cutoff) total += Number(r.usage ?? 0)
    }
    // /activity ist kontoweit OHNE Key/App-Dimension. Laeuft aktuell komplett ueber
    // den App-1-Key (App 2 / Others = $0), daher der Gesamtbetrag auf App 1. Falls
    // spaeter mehrere Apps OpenRouter nutzen, muss hier pro Key aufgeteilt werden.
    into.app1 += total
  } catch { /* still */ }
}

// Summe der API-Kosten (USD, 30d) je App über alle drei Provider.
export async function getCost30dUsdByApp() {
  const into = emptyByApp()
  await Promise.all([venice(into), fal(into), openrouter(into)])
  return into
}

// USD->EUR (frankfurter.app), mit Fallback.
export async function getUsdToEur() {
  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=USD&to=EUR', { cache: 'no-store' })
    if (!res.ok) throw new Error()
    const rate = Number((await res.json())?.rates?.EUR)
    if (isFinite(rate) && rate > 0) return rate
  } catch { /* fall through */ }
  return config.fxFallbackUsdToEur
}
