// Lokaler Test: Daten holen (Mock oder Live) und nach preview.png rendern.
import fs from 'node:fs'
import { getEinkData } from './aggregate.mjs'
import { renderEinkPng } from './render.mjs'

const data = await getEinkData()
const png = await renderEinkPng(data)
fs.writeFileSync('preview.png', png)
console.log(`preview.png geschrieben (${png.length} bytes) — Quelle: ${data._mock ? 'MOCK' : 'LIVE'}${data._note ? ` (${data._note})` : ''}`)
