// BOOTTEST — zeichnet ein eindeutiges Bild OHNE jeglichen WiFi-Code.
// Erscheint es -> Flash/Boot/Display funktionieren, und der Fehler liegt im WLAN-Teil.
#include <Arduino.h>
#include <bb_epaper.h>

#define DC_PIN 10
#define BUSY_PIN 4
#define CS_PIN 44
#define RESET_PIN 38
#define SCK_PIN 7
#define MOSI_PIN 9

BBEPAPER bbep(EP75YR_800x480);

static void line(int y, int color, const char *s) {
  bbep.setTextColor(color, BBEP_TRANSPARENT);
  bbep.setCursor(40, y);
  bbep.print(s);
}

void setup() {
  bbep.initIO(DC_PIN, RESET_PIN, BUSY_PIN, CS_PIN, MOSI_PIN, SCK_PIN);
  bbep.allocBuffer();
  bbep.fillScreen(BBEP_WHITE);
  bbep.drawRect(0, 0, 800, 480, BBEP_RED);
  bbep.drawRect(6, 6, 788, 468, BBEP_RED);

  bbep.setFont(FONT_16x16);
  line(70,  BBEP_RED,   "BOOT + DISPLAY OK");
  bbep.setFont(FONT_12x16);
  line(140, BBEP_BLACK, "Reiner Anzeige-Test - KEIN WiFi.");
  line(180, BBEP_BLACK, "Wenn du das siehst: Flash, Boot und Panel sind ok.");
  line(220, BBEP_BLACK, "Damit liegt der Fehler eindeutig im WLAN-Teil.");
  line(290, BBEP_BLACK, "Naechster Schritt: WLAN-Diagnose isoliert testen.");

  bbep.writePlane();
  bbep.refresh(REFRESH_FULL, true);
  // bbep.sleep(DEEP_SLEEP);   // (DEBUG) Panel-Controller wach lassen
}

void loop() {}
