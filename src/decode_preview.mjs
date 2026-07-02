// Verifikation: holt /eink.bin vom laufenden Server, entpackt es mit EXAKT der
// Logik, die spaeter die ESP32-Firmware nutzt, und schreibt ein PNG zum Anschauen.
// So sehen wir das echte Geraete-Ergebnis (inkl. BWRY-Quantisierung) vor dem Flashen.
import http from 'node:http'
import zlib from 'node:zlib'
import fs from 'node:fs'

const KEY = process.env.EINK_KEY || ''
const W = 800, H = 480, PITCH = W / 4
// Anzeigefarben pro Code (0=schwarz,1=weiss,2=gelb,3=rot) — wie auf dem Panel.
const PAL = [[17, 17, 17], [255, 255, 255], [232, 162, 0], [216, 30, 30]]

function fetchBin() {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:8080/eink.bin?key=${KEY}`, r => {
      if (r.statusCode !== 200) { reject(new Error('HTTP ' + r.statusCode)); return }
      const chunks = []
      r.on('data', c => chunks.push(c))
      r.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
}

// Minimaler PNG-Encoder (8-bit RGB, eine IDAT) — keine Extra-Abhaengigkeit.
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)) }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
function encodePNG(rgb, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2 // 8-bit, Truecolor
  const raw = Buffer.alloc(h * (w * 3 + 1))
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) }
  const idat = zlib.deflateSync(raw)
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

const bin = await fetchBin()
if (bin.length !== PITCH * H) throw new Error(`unerwartete Groesse ${bin.length}, erwartet ${PITCH * H}`)
const rgb = Buffer.alloc(W * H * 3)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const b = bin[y * PITCH + (x >> 2)]
    const code = (b >> ((3 - (x & 3)) * 2)) & 3
    const [r, g, bl] = PAL[code]
    const o = (y * W + x) * 3
    rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = bl
  }
}
const out = 'preview_eink_decoded.png'
fs.writeFileSync(out, encodePNG(rgb, W, H))
console.log(`OK: ${out} geschrieben (${bin.length} Bytes bin -> ${W}x${H} PNG)`)
