// App-Admin-APIs (URLs aus der Config): liefern Server-Metriken + Nutzerzahlen.
import { config } from '../config.mjs'

async function fetchLive(baseUrl, key) {
  if (!key) return null
  const url = key ? `${baseUrl}?key=${encodeURIComponent(key)}` : baseUrl
  try {
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// Wert nach 0..100 normalisieren (cpu/mem_pct/load5_pct kommen mal als 0..1, mal als 0..100).
function pct(v) {
  if (typeof v !== 'number' || !isFinite(v)) return 0
  const p = v <= 1 ? v * 100 : v
  return Math.round(Math.max(0, Math.min(100, p)))
}

export async function getApps() {
  const [a1, a2] = await Promise.all([
    fetchLive(config.app1.url, config.app1.key),
    fetchLive(config.app2.url, config.app2.key),
  ])

  const num = v => (typeof v === 'number' && isFinite(v) ? v : null)

  return {
    // Server-Performance kommt NUR von App 1 (primaerer Server)
    server: a1
      ? { cpu: pct(a1.cpu), mem: pct(a1.mem_pct), load: pct(a1.load5_pct) }
      : null,
    users: {
      app1: { total: num(a1?.total_users), new30d: num(a1?.new_users_30d) },
      app2: { total: num(a2?.total_users), new30d: num(a2?.new_users_30d) },
    },
    ok: { app1: Boolean(a1), app2: Boolean(a2) },
  }
}
