// ─────────────────────────────────────────────────────────────────────────────
//  eInk First Light  —  Hardware-Bring-up fuer das Wanddashboard
//
//  Zweck: Board + Panel + Verkabelung validieren, BEVOR wir die WLAN-Pipeline
//  bauen. Zeichnet ein statisches 4-Farb-Testbild (BWRY) und geht dann schlafen.
//
//  Board : Seeed XIAO ESP32-S3 (Plus) auf XIAO ePaper Driver Board EE04
//  Panel : GDEM075F52  7.5"  800x480  Schwarz/Weiss/Rot/Gelb  (JD79665)
//  Lib   : bb_epaper (bitbank2)  —  Panel-Enum EP75YR_800x480
// ─────────────────────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <bb_epaper.h>

// Pins laut bb_epaper-Beispiel "Seeed Xiao ePaper Display Board (ESP32-S3)"
#define DC_PIN     10
#define BUSY_PIN   4
#define CS_PIN     44
#define RESET_PIN  38
#define SCK_PIN    7
#define MOSI_PIN   9

#define EP_W 800
#define EP_H 480

BBEPAPER bbep(EP75YR_800x480);

// Ein beschriftetes Farbfeld zeichnen (Fuellung + schwarzer Rahmen + Label)
static void swatch(int x, int y, int w, int h, int fill, int textColor, const char *label) {
  bbep.fillRect(x, y, w, h, fill);
  bbep.drawRect(x, y, w, h, BBEP_BLACK);
  bbep.setTextColor(textColor, BBEP_TRANSPARENT);
  bbep.setFont(FONT_12x16);
  bbep.setCursor(x + 14, y + h / 2 - 8);
  bbep.print(label);
}

void setup() {
  Serial.begin(115200);
  delay(1500);                       // kurz warten, damit der USB-CDC-Monitor mitliest
  Serial.println();
  Serial.println("=== eInk First Light ===");
  Serial.println("initIO ...");

  bbep.initIO(DC_PIN, RESET_PIN, BUSY_PIN, CS_PIN, MOSI_PIN, SCK_PIN);

  int rc = bbep.allocBuffer();
  Serial.printf("allocBuffer rc=%d  (Panel %dx%d)\n", rc, bbep.width(), bbep.height());

  // ── Bild aufbauen ──────────────────────────────────────────────────────────
  bbep.fillScreen(BBEP_WHITE);

  // Doppelter schwarzer Rahmen rund ums Panel -> prueft, dass alle 4 Kanten adressiert werden
  bbep.drawRect(0, 0, EP_W,     EP_H,     BBEP_BLACK);
  bbep.drawRect(2, 2, EP_W - 4, EP_H - 4, BBEP_BLACK);

  // Kopfzeile (schwarz) + Unterzeile (rot)
  bbep.setTextColor(BBEP_BLACK, BBEP_TRANSPARENT);
  bbep.setFont(FONT_12x16);
  bbep.setCursor(28, 22);
  bbep.print("eInk First Light  -  GDEM075F52  800x480 BWRY");
  bbep.setTextColor(BBEP_RED, BBEP_TRANSPARENT);
  bbep.setCursor(28, 46);
  bbep.print("Siehst du alle vier Farben + Rahmen? Dann ist die Verkabelung ok.");

  // 4 Farbfelder (2x2) — bestaetigt, dass jede der vier Farben sauber rendert
  const int sw = 360, sh = 95, x0 = 30, y0 = 80, gap = 20;
  swatch(x0,            y0,            sw, sh, BBEP_BLACK,  BBEP_WHITE, "BLACK");
  swatch(x0 + sw + gap, y0,            sw, sh, BBEP_WHITE,  BBEP_BLACK, "WHITE");
  swatch(x0,            y0 + sh + gap, sw, sh, BBEP_RED,    BBEP_WHITE, "RED");
  swatch(x0 + sw + gap, y0 + sh + gap, sw, sh, BBEP_YELLOW, BBEP_BLACK, "YELLOW");

  // Farbstreifen unten -> prueft, dass auch die untersten Zeilen sauber kommen
  const int by = 320, bh = 70, seg = EP_W / 4;
  bbep.fillRect(0 * seg, by, seg, bh, BBEP_BLACK);
  bbep.fillRect(1 * seg, by, seg, bh, BBEP_WHITE);
  bbep.fillRect(2 * seg, by, seg, bh, BBEP_RED);
  bbep.fillRect(3 * seg, by, seg, bh, BBEP_YELLOW);
  bbep.drawRect(0, by, EP_W, bh, BBEP_BLACK);

  // Eck-Marker (rote Linien) -> Orientierung/Adressierung der Ecken pruefen
  bbep.drawLine(0, 0, 60, 0, BBEP_RED);     bbep.drawLine(0, 0, 0, 60, BBEP_RED);
  bbep.drawLine(EP_W - 1, EP_H - 1, EP_W - 61, EP_H - 1, BBEP_RED);
  bbep.drawLine(EP_W - 1, EP_H - 1, EP_W - 1, EP_H - 61, BBEP_RED);

  bbep.setTextColor(BBEP_BLACK, BBEP_TRANSPARENT);
  bbep.setCursor(28, 420);
  bbep.print("Naechster Schritt: WLAN holt das echte Dashboard vom Renderer.");

  // ── Ans Panel schreiben (Vollrefresh ~22s) ──────────────────────────────────
  Serial.println("writePlane + refresh(FULL) ... (~22s, bitte warten)");
  bbep.writePlane();
  bbep.refresh(REFRESH_FULL, true);
  Serial.println("Refresh fertig. -> Deep sleep.");

  // bbep.sleep(DEEP_SLEEP);          // (DEBUG) Panel-Controller wach lassen
}

void loop() {
  // First-Light ist statisch — nichts zu tun.
}
