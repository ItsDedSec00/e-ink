// Wetter über Open-Meteo (kostenlos, kein API-Key). Geocodet die Stadt einmalig.
import { config } from '../config.mjs'

// WMO-Wettercodes -> kurze deutsche Bezeichnung
function wmoText(code) {
  if (code === 0) return 'Klar'
  if (code === 1) return 'Heiter'
  if (code === 2) return 'Wolkig'
  if (code === 3) return 'Bedeckt'
  if (code === 45 || code === 48) return 'Nebel'
  if (code >= 51 && code <= 57) return 'Niesel'
  if (code >= 61 && code <= 67) return 'Regen'
  if (code >= 71 && code <= 77) return 'Schnee'
  if (code >= 80 && code <= 82) return 'Schauer'
  if (code === 85 || code === 86) return 'Schneeschauer'
  if (code >= 95) return 'Gewitter'
  return ''
}

let coordsCache = null // { lat, lon, name }

async function resolveCoords() {
  if (coordsCache) return coordsCache
  if (config.weatherLat != null && config.weatherLon != null) {
    coordsCache = { lat: config.weatherLat, lon: config.weatherLon, name: config.weatherCity }
    return coordsCache
  }
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(config.weatherCity)}&count=1&language=de&format=json`
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`geocoding ${res.status}`)
  const r = (await res.json())?.results?.[0]
  if (!r) throw new Error('Stadt nicht gefunden')
  coordsCache = { lat: r.latitude, lon: r.longitude, name: r.name || config.weatherCity }
  return coordsCache
}

// -> { weather: 'Heiter 21°C', city: 'München',
//      days: [ { text, tmax, tmin, uvMax }, ... ] (heute, morgen) }  oder null bei Fehler
export async function getWeather() {
  try {
    const { lat, lon, name } = await resolveCoords()
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
      + `&current=temperature_2m,weather_code`
      + `&daily=weather_code,temperature_2m_max,temperature_2m_min,uv_index_max`
      + `&forecast_days=3&timezone=auto`
    const res = await fetch(url, { cache: 'no-store' })
    if (!res.ok) throw new Error(`forecast ${res.status}`)
    const json = await res.json()
    const cur = json?.current
    if (!cur) throw new Error('keine current-Daten')
    const temp = Math.round(cur.temperature_2m)
    const desc = wmoText(cur.weather_code)

    // Tagesvorhersage heute + morgen (parallel zu den Kalenderspalten)
    const dly = json?.daily
    const days = []
    if (dly && Array.isArray(dly.time)) {
      for (let i = 0; i < dly.time.length && i < 3; i++) {
        days.push({
          text: wmoText(dly.weather_code?.[i]),
          tmax: Math.round(dly.temperature_2m_max?.[i]),
          tmin: Math.round(dly.temperature_2m_min?.[i]),
          uvMax: dly.uv_index_max?.[i] != null ? Math.round(dly.uv_index_max[i]) : null,
        })
      }
    }
    return { weather: `${desc ? desc + ' ' : ''}${temp}°C`, city: name, temp, days }
  } catch {
    return null
  }
}
