// BWRY-Quantisierung: RGBA (von resvg) -> gepackter 2-Bit/Pixel-Puffer fuer bb_epaper.
// 4 Pixel pro Byte, MSB-first (Bits [7:6][5:4][3:2][1:0]) — identisch zur internen
// Packung von bb_epaper (bbepSetPixelFast4Clr). Farbcodes passend zu drawPixel:
//   0 = BBEP_BLACK, 1 = BBEP_WHITE, 2 = BBEP_YELLOW, 3 = BBEP_RED
//
// WICHTIG — kein naiver euklidischer Nearest-Color:
// Anti-aliaste Graukanten schwarzer Schrift (z.B. RGB 136,136,136) liegen im
// RGB-Abstand NAEHER an Gelb/Rot als an Schwarz/Weiss und wuerden sonst bunte
// Farbsaeume erzeugen. Stattdessen: erst nach Buntheit (Chroma) trennen.
//   - graue/neutrale Pixel  -> nur Schwarz oder Weiss (per Helligkeit)
//   - bunte Pixel           -> Gelb oder Rot (Amber hat viel Gruen -> g-b gross,
//                              Rot hat g≈b -> g-b klein)
const CHROMA_MIN = 60   // ab hier gilt ein Pixel als "bunt" (Amber/Rot, auch aufgehellt)
const LUM_BLACK  = 140  // neutrale Pixel dunkler als das -> Schwarz, sonst Weiss
const YB_SPLIT   = 25   // g-b oberhalb -> Gelb (Amber), darunter -> Rot

function classify(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b)
  const chroma = mx - mn
  if (chroma < CHROMA_MIN) {
    const lum = (r * 299 + g * 587 + b * 114) / 1000
    return lum < LUM_BLACK ? 0 : 1            // Schwarz / Weiss
  }
  return (g - b) > YB_SPLIT ? 2 : 3           // Gelb / Rot
}

// rgba: Uint8Array/Buffer der Laenge w*h*4. Liefert Buffer der Laenge ceil(w/4)*h.
export function rgbaToBwryPacked(rgba, w, h) {
  const pitch = (w + 3) >> 2            // Bytes pro Zeile (200 bei 800)
  const out = Buffer.alloc(pitch * h)   // 0-initialisiert; Code 0 (schwarz) traegt 0 bei
  for (let y = 0; y < h; y++) {
    const rowBase = y * w * 4
    const outBase = y * pitch
    for (let x = 0; x < w; x++) {
      const o = rowBase + x * 4
      const code = classify(rgba[o], rgba[o + 1], rgba[o + 2])
      out[outBase + (x >> 2)] |= code << ((3 - (x & 3)) * 2)
    }
  }
  return out
}
