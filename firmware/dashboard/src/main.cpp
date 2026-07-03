// ─────────────────────────────────────────────────────────────────────────────
//  eInk Wanddashboard — Stufe 2 (Thin Client)
//
//  Aufwachen -> WLAN -> GET /eink.bin (96000 B, 4-Farb gepackt) -> beim Empfang
//  direkt ins Panel dekodieren -> Vollrefresh -> Deep Sleep bis zum naechsten Mal.
//
//  Refresh-Zeitplan (lokale Zeit, Europe/Berlin inkl. Sommerzeit):
//    04–12 Uhr und 16–22 Uhr  -> alle 30 min
//    sonst                    -> alle 60 min
//
//  Board : Seeed XIAO ESP32-S3 (Plus) / EE04 / GDEM075F52 800x480 BWRY
// ─────────────────────────────────────────────────────────────────────────────
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <bb_epaper.h>
#include <time.h>
#include "esp_sleep.h"
#include "driver/rtc_io.h"   // RTC-Pullups fuer das ext1-Button-Wakeup
#include "secrets.h"   // WIFI_SSID, WIFI_PASS, IMG_HOST, EINK_KEY, IMG_URL

// Panel-Pins (Seeed XIAO ePaper Board EE04)
#define DC_PIN     10
#define BUSY_PIN   4
#define CS_PIN     44
#define RESET_PIN  38
#define SCK_PIN    7
#define MOSI_PIN   9

// Onboard-Taster (Seeed XIAO ePaper Board EE04): KEY0/1/2, active-low. Alle
// RTC-faehig (<=21) -> koennen den ESP32-S3 per ext1 aus dem Deep Sleep wecken.
#define BTN0_PIN   2
#define BTN1_PIN   3
#define BTN2_PIN   5
#define BTN_MASK   ((1ULL << BTN0_PIN) | (1ULL << BTN1_PIN) | (1ULL << BTN2_PIN))

// Akku-Messung: EE04 hat einen eingebauten, schaltbaren 1:2-Spannungsteiler
// (Seeed-Wiki: ADC an A0/GPIO1, Enable an GPIO6). Enable nur beim Messen -> kein
// Ruhestrom. BAT_DIVIDER ggf. gegen echte Multimeter-Messung nachkalibrieren.
#define BAT_ADC_PIN 1
#define BAT_EN_PIN  6
#define BAT_DIVIDER 2.0f

#define EP_W  800
#define EP_H  480
#define PITCH (EP_W / 4)            // 200 Bytes/Zeile (2 Bit je Pixel)
#define IMG_BYTES ((long)PITCH * EP_H)   // 96000

// Europe/Berlin mit automatischer Sommer-/Winterzeit-Umschaltung
#define TZ_STR "CET-1CEST,M3.5.0,M10.5.0/3"

#define RETRY_MIN 15               // Deep-Sleep-Retry (Akkuschutz nach langer Stoerung)
#define RETRY_SEC 30               // Fehlerpfad: WACH bleiben, so oft neu versuchen
#define MAX_AWAKE_RETRIES 20       // danach doch Deep Sleep (Akkuschutz) — ~10 min wach
#define FLASH_WINDOW_S 30          // frischer Boot: so lange USB wach lassen -> flashbar

BBEPAPER bbep(EP75YR_800x480);

// true, wenn dieser Start KEIN Timer-Wake war (also Power-On / RESET / USB-Einstecken)
// -> ein Mensch ist am Werk -> wir halten vor dem Deep Sleep ein Flash-Fenster offen.
bool g_freshBoot = false;
// zaehlt aufeinanderfolgende erfolglose Wach-Retries (ueberlebt ESP.restart)
RTC_DATA_ATTR int g_awakeRetries = 0;

// ── Deep Sleep (Akkubetrieb) ─────────────────────────────────────────────────
// Bei frischem Boot (RESET/USB) VOR dem Schlafen ein Flash-Fenster: der USB-Port
// bleibt ~FLASH_WINDOW_S an, sodass `pio run -t upload` das Board ganz normal
// erwischt — ohne die BOOT+RESET-Turnerei. Beim Timer-Wake wird sofort geschlafen
// (kein wasted uptime -> Akku).
static void sleepMinutes(int m) {
  if (g_freshBoot) {
    Serial.printf("Frischer Boot -> Flash-Fenster %ds offen (USB an) ...\n", FLASH_WINDOW_S);
    Serial.flush();
    for (int i = FLASH_WINDOW_S; i > 0; i--) { delay(1000); }   // USB-CDC bleibt enumeriert
  }
  Serial.printf("Deep sleep fuer %d min.\n", m);
  Serial.flush();
  WiFi.disconnect(true, false);
  WiFi.mode(WIFI_OFF);
  // Zusaetzlich per Tastendruck aufwachen: RTC-Pullups an den 3 Tastern (active-low),
  // dann ext1 auf "irgendein Pin LOW". So wecken die Buttons aus dem Deep Sleep.
  for (int p : { BTN0_PIN, BTN1_PIN, BTN2_PIN }) {
    rtc_gpio_pullup_en((gpio_num_t)p);
    rtc_gpio_pulldown_dis((gpio_num_t)p);
  }
  esp_sleep_enable_ext1_wakeup(BTN_MASK, ESP_EXT1_WAKEUP_ANY_LOW);
  esp_sleep_enable_timer_wakeup((uint64_t)m * 60ULL * 1000000ULL);
  esp_deep_sleep_start();           // kehrt nie zurueck; beim Timer-/Button-Wake startet setup() neu
}

// ── Fehlerpfad: NICHT schlafen ───────────────────────────────────────────────
// Wach bleiben (USB/COM3 an -> einfaches Flashen + schnelles automatisches Neu-
// verbinden), alle RETRY_SEC per Neustart neu versuchen. Erst nach vielen
// erfolglosen Versuchen doch Deep Sleep, damit ein Dauerausfall (Router/Server
// stundenlang weg) im Akkubetrieb nicht die Batterie leersaugt.
static void retryOrSleep() {
  if (++g_awakeRetries > MAX_AWAKE_RETRIES) {
    Serial.println("Dauerstoerung -> Deep Sleep zum Akkuschutz.");
    g_awakeRetries = 0;
    sleepMinutes(RETRY_MIN);        // kehrt nie zurueck
  }
  Serial.printf("Fehler: bleibe WACH, Versuch %d/%d, neuer Versuch in %ds (USB an).\n",
                g_awakeRetries, MAX_AWAKE_RETRIES, RETRY_SEC);
  Serial.flush();
  for (int i = RETRY_SEC; i > 0; i--) delay(1000);   // USB bleibt sichtbar
  ESP.restart();                    // frischer Versuch (Fehlerbild bleibt dank g_lastError-Guard)
}

// Intervall nach lokaler Stunde. Ohne gueltige Zeit: 30 min (haeufiger = sicherer).
static int chooseIntervalMinutes() {
  struct tm t;
  if (!getLocalTime(&t, 5000)) {
    Serial.println("Keine NTP-Zeit -> Default 30 min.");
    return 30;
  }
  int h = t.tm_hour;
  bool dense = (h >= 4 && h < 12) || (h >= 16 && h < 22);
  Serial.printf("Lokale Zeit %02d:%02d -> %s-Fenster.\n", h, t.tm_min, dense ? "30min" : "60min");
  return dense ? 30 : 60;
}

// ── WLAN ─────────────────────────────────────────────────────────────────────
static bool connectWiFi(uint32_t timeoutMs = 30000) {
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);   // volle Sendeleistung erzwingen
  uint32_t t0 = millis();
  bool retried = false;
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) {
    delay(250);
    if (!retried && millis() - t0 > timeoutMs / 2) {   // nach der Haelfte einmal neu anstossen
      retried = true;
      WiFi.disconnect();
      delay(100);
      WiFi.begin(WIFI_SSID, WIFI_PASS);
    }
  }
  return WiFi.status() == WL_CONNECTED;
}

// ── Akku ─────────────────────────────────────────────────────────────────────
// LiPo-Spannung -> grober Ladezustand (stueckweise lineare Kurve, LiPo ist flach).
static int batteryPercent(float v) {
  static const float vt[] = { 3.30f, 3.50f, 3.60f, 3.70f, 3.75f, 3.85f, 4.00f, 4.20f };
  static const int   pt[] = { 0,     10,    20,    35,    45,    60,    85,    100  };
  if (v <= vt[0]) return 0;
  if (v >= vt[7]) return 100;
  for (int i = 1; i < 8; i++)
    if (v <= vt[i]) return pt[i - 1] + (int)((pt[i] - pt[i - 1]) * (v - vt[i - 1]) / (vt[i] - vt[i - 1]));
  return 100;
}
static int readBatteryPercent() {
  pinMode(BAT_EN_PIN, OUTPUT);
  digitalWrite(BAT_EN_PIN, HIGH);          // Teiler einschalten
  delay(10);
  uint32_t mv = 0;
  for (int i = 0; i < 8; i++) mv += analogReadMilliVolts(BAT_ADC_PIN);  // kalibriert
  mv /= 8;
  digitalWrite(BAT_EN_PIN, LOW);           // Teiler wieder aus (kein Ruhestrom)
  float vbat = (mv * BAT_DIVIDER) / 1000.0f;
  int pct = batteryPercent(vbat);
  Serial.printf("Akku: %u mV@Pin -> %.2f V -> %d%%\n", mv, vbat, pct);
  return pct;
}

// ── Bild holen und beim Empfang direkt ins Panel-Buffer dekodieren ───────────
// Erwartet, dass das Panel-Buffer bereits allokiert ist. Zeichnet 4 Pixel je Byte.
// bat (0..100) wird als &bat=... an den Renderer mitgeschickt (Akkuanzeige).
static bool fetchAndDraw(int bat) {
  char url[176];
  snprintf(url, sizeof(url), "%s&bat=%d", IMG_URL, bat);   // IMG_URL hat bereits ?key=...
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(20000);
  if (!http.begin(url)) { Serial.println("http.begin fehlgeschlagen"); return false; }

  int code = http.GET();
  if (code != 200) { Serial.printf("HTTP-Status %d\n", code); http.end(); return false; }

  WiFiClient *s = http.getStreamPtr();
  uint8_t chunk[512];
  long bc = 0;                       // verarbeitete Bytes (= Pixel/4)
  uint32_t tIdle = millis();

  while (bc < IMG_BYTES) {
    int avail = s->available();
    if (avail <= 0) {
      if (!http.connected() && s->available() == 0) break;
      if (millis() - tIdle > 20000) { Serial.println("Stream-Timeout"); break; }
      delay(2);
      continue;
    }
    tIdle = millis();
    int want = (int)min((long)sizeof(chunk), IMG_BYTES - bc);
    int n = s->readBytes(chunk, min(avail, want));
    for (int k = 0; k < n; k++) {
      uint8_t b = chunk[k];
      long idx = bc + k;
      int y = idx / PITCH;
      int x = (int)(idx % PITCH) * 4;
      bbep.drawPixel(x + 0, y, (b >> 6) & 3);
      bbep.drawPixel(x + 1, y, (b >> 4) & 3);
      bbep.drawPixel(x + 2, y, (b >> 2) & 3);
      bbep.drawPixel(x + 3, y, (b)      & 3);
    }
    bc += n;
  }
  http.end();
  Serial.printf("Bild dekodiert: %ld/%ld Bytes\n", bc, IMG_BYTES);
  return bc == IMG_BYTES;
}

// ── Button an HA melden ──────────────────────────────────────────────────────
// POST /button/<idx> ans Add-on -> feuert in HA das Event eink_dashboard_button.
static void postButton(int idx) {
  char url[176];
  snprintf(url, sizeof(url), "http://%s/button/%d?key=%s", IMG_HOST, idx, EINK_KEY);
  HTTPClient http;
  http.setConnectTimeout(6000);
  http.setTimeout(8000);
  if (!http.begin(url)) { Serial.println("Button-POST: http.begin fehlgeschlagen"); return; }
  int code = http.POST((uint8_t *)nullptr, 0);
  Serial.printf("Button %d -> POST -> HTTP %d\n", idx, code);
  http.end();
}

// ── Fehlerbildschirm ─────────────────────────────────────────────────────────
// Zeigt AN, warum nichts aktualisiert wurde (kein WLAN / Server weg), statt das
// Panel stumm unveraendert zu lassen. Wird nur neu gezeichnet, wenn sich der
// Fehler geaendert hat (spart den 22s-Refresh + Strom). Die RTC-Variable
// ueberlebt ESP.restart und Deep Sleep.
RTC_DATA_ATTR int g_lastError = -1;   // -1 unbekannt, 0 = ok, 1 = WLAN, 2 = Server

static void showError(int code, const char *title, const char *detail, const char *hint, int retryMin) {
  if (g_lastError == code) {
    Serial.printf("Fehler %d unveraendert -> kein Repaint.\n", code);
    return;
  }
  Serial.printf("Fehlerbildschirm (Code %d): %s\n", code, title);

  bbep.fillScreen(BBEP_WHITE);
  bbep.drawRect(0, 0, EP_W, EP_H, BBEP_RED);
  bbep.drawRect(4, 4, EP_W - 8, EP_H - 8, BBEP_RED);

  // Roter Kopfbalken
  bbep.fillRect(0, 0, EP_W, 72, BBEP_RED);
  bbep.setTextColor(BBEP_WHITE, BBEP_TRANSPARENT);
  bbep.setFont(FONT_16x16);
  bbep.setCursor(30, 28);
  bbep.print("!  DASHBOARD OFFLINE");

  // Titel
  bbep.setTextColor(BBEP_BLACK, BBEP_TRANSPARENT);
  bbep.setFont(FONT_16x16);
  bbep.setCursor(32, 118);
  bbep.print(title);

  // Detail + Hinweis
  bbep.setFont(FONT_12x16);
  int y = 176;
  bbep.setCursor(32, y); bbep.print(detail); y += 36;
  if (hint && hint[0]) { bbep.setCursor(32, y); bbep.print(hint); y += 36; }

  // WLAN-Status
  y += 12;
  bbep.setCursor(32, y);
  if (WiFi.status() == WL_CONNECTED) {
    char buf[100];
    snprintf(buf, sizeof(buf), "WLAN ok  -  IP %s  RSSI %d dBm",
             WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
    bbep.print(buf);
  } else {
    bbep.setTextColor(BBEP_RED, BBEP_TRANSPARENT);
    bbep.print("WLAN nicht verbunden");
    bbep.setTextColor(BBEP_BLACK, BBEP_TRANSPARENT);
  }
  y += 36;

  // Zeitstempel + naechster Versuch
  char line[100];
  struct tm t;
  if (getLocalTime(&t, 500)) {
    char ts[32]; strftime(ts, sizeof(ts), "%d.%m. %H:%M", &t);
    snprintf(line, sizeof(line), "Stand %s  -  verbindet automatisch neu ...", ts);
  } else {
    snprintf(line, sizeof(line), "Verbindet automatisch neu ...");
  }
  bbep.setCursor(32, y); bbep.print(line);

  bbep.writePlane();
  bbep.refresh(REFRESH_FULL, true);
  g_lastError = code;
}

// ── WLAN-Fehler MIT Scan-Diagnose ────────────────────────────────────────────
// Zeigt, ob die Ziel-SSID ueberhaupt in Reichweite ist + Signalstaerke + alle
// sichtbaren Netze. Antwortet direkt auf "ist die Sendeleistung/Antenne zu
// schlecht?". Malt bewusst bei JEDEM Versuch neu (frischer Scan beim Debuggen).
static void showWifiError(int retryMin) {
  Serial.println("WLAN-Scan fuer Diagnose ...");
  int n = WiFi.scanNetworks();
  int msRssi = -127; bool found = false;
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == String(WIFI_SSID)) { found = true; if ((int)WiFi.RSSI(i) > msRssi) msRssi = WiFi.RSSI(i); }
  }
  Serial.printf("Scan: %d Netze, Ziel-SSID %s (%d dBm)\n", n, found ? "gefunden" : "NICHT gefunden", msRssi);

  bbep.fillScreen(BBEP_WHITE);
  bbep.drawRect(0, 0, EP_W, EP_H, BBEP_RED);
  bbep.drawRect(4, 4, EP_W - 8, EP_H - 8, BBEP_RED);
  bbep.fillRect(0, 0, EP_W, 72, BBEP_RED);
  bbep.setTextColor(BBEP_WHITE, BBEP_TRANSPARENT);
  bbep.setFont(FONT_16x16);
  bbep.setCursor(30, 28);
  bbep.print("!  KEIN WLAN");

  char buf[120];
  bbep.setFont(FONT_12x16);
  int y = 96;
  bbep.setTextColor(BBEP_BLACK, BBEP_TRANSPARENT);
  bbep.setCursor(28, y); bbep.print("Ziel-SSID: " WIFI_SSID); y += 32;

  if (found) {
    const char *q = msRssi >= -67 ? "(gut)" : msRssi >= -75 ? "(schwach)" : "(sehr schwach)";
    snprintf(buf, sizeof(buf), "-> gefunden, Signal %d dBm %s", msRssi, q);
    bbep.setTextColor(msRssi >= -75 ? BBEP_BLACK : BBEP_RED, BBEP_TRANSPARENT);
  } else {
    snprintf(buf, sizeof(buf), "-> NICHT in Reichweite  (Antenne? Standort?)");
    bbep.setTextColor(BBEP_RED, BBEP_TRANSPARENT);
  }
  bbep.setCursor(28, y); bbep.print(buf); y += 40;
  bbep.setTextColor(BBEP_BLACK, BBEP_TRANSPARENT);

  bbep.setCursor(28, y); bbep.print("Sichtbare Netze:"); y += 30;
  if (n <= 0) {
    bbep.setTextColor(BBEP_RED, BBEP_TRANSPARENT);
    bbep.setCursor(28, y); bbep.print("  KEINE gefunden -> Antenne locker/ab?");
    bbep.setTextColor(BBEP_BLACK, BBEP_TRANSPARENT);
    y += 28;
  }
  for (int i = 0; i < n && i < 8; i++) {
    snprintf(buf, sizeof(buf), "  %-22.22s  %d dBm", WiFi.SSID(i).c_str(), (int)WiFi.RSSI(i));
    bbep.setCursor(28, y); bbep.print(buf); y += 26;
  }

  snprintf(buf, sizeof(buf), "Antenne fest? 2.4-GHz aktiv?  -  verbindet automatisch neu ...");
  bbep.setCursor(28, EP_H - 42); bbep.print(buf);

  WiFi.scanDelete();
  bbep.writePlane();
  bbep.refresh(REFRESH_FULL, true);
  g_lastError = 1;
}

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\n=== eInk Dashboard: aufgewacht ===");

  // Wake-Grund: Timer (Akku-Refresh), ext1 (Tastendruck) oder frischer Boot
  // (Power-On/RESET/USB). Flash-Fenster NUR beim echten frischen Boot (nicht bei
  // Taste — sonst wuerde jeder Druck 30s USB offenhalten).
  esp_sleep_wakeup_cause_t wake = esp_sleep_get_wakeup_cause();
  g_freshBoot = (wake == ESP_SLEEP_WAKEUP_UNDEFINED);
  int pressedBtn = -1;
  if (wake == ESP_SLEEP_WAKEUP_EXT1) {
    uint64_t st = esp_sleep_get_ext1_wakeup_status();
    if      (st & (1ULL << BTN0_PIN)) pressedBtn = 0;
    else if (st & (1ULL << BTN1_PIN)) pressedBtn = 1;
    else if (st & (1ULL << BTN2_PIN)) pressedBtn = 2;
  }
  Serial.printf("Wake-Grund: %s\n",
                wake == ESP_SLEEP_WAKEUP_TIMER ? "Timer-Wake" :
                pressedBtn >= 0 ? "Button-Wake" :
                g_freshBoot ? "frischer Boot -> Flash-Fenster aktiv" : "sonstiger Wake");
  if (pressedBtn >= 0) Serial.printf("Taste %d gedrueckt.\n", pressedBtn);

  // Panel FRUEH initialisieren, damit auch Verbindungsfehler angezeigt werden koennen.
  bbep.initIO(DC_PIN, RESET_PIN, BUSY_PIN, CS_PIN, MOSI_PIN, SCK_PIN);
  bbep.allocBuffer();

  // Akku FRUEH messen — VOR dem WLAN, damit der Sende-/Idle-Strom die Messung
  // nicht nach unten drueckt (naeher an der Ruhespannung = genauer).
  int bat = readBatteryPercent();

  if (!connectWiFi()) {
    Serial.println("WLAN fehlgeschlagen.");
    showWifiError(RETRY_MIN);
    retryOrSleep();                  // wach bleiben + automatisch neu versuchen
  }
  Serial.printf("WLAN ok: IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());

  configTzTime(TZ_STR, "pool.ntp.org", "time.nist.gov");  // NTP startet im Hintergrund

  // Taste 0/1 -> HA-Event (Szenen); Taste 2 = nur Panel aktualisieren (kein Event -
  // der Fetch+Render unten ist der Refresh, mit LIVE-Fensterstatus vom Add-on).
  if (pressedBtn == 0 || pressedBtn == 1) postButton(pressedBtn);

  // Bild streamend ins Panel-Buffer dekodieren (bat wurde oben schon gemessen)
  bbep.fillScreen(BBEP_WHITE);
  if (!fetchAndDraw(bat)) {
    Serial.println("Bild holen fehlgeschlagen.");
    showError(2, "Server nicht erreichbar", "Ziel: " IMG_HOST, "Laeuft der Renderer? IP korrekt?", RETRY_MIN);
    retryOrSleep();                  // wach bleiben + automatisch neu versuchen
  }

  Serial.println("Vollrefresh (~22s) ...");
  bbep.writePlane();
  bbep.refresh(REFRESH_FULL, true);
  bbep.sleep(DEEP_SLEEP);            // Panel-Controller schlafen legen (Ghosting/Strom)
  g_lastError = 0;                   // erfolgreicher Update -> Fehlerzustand loeschen
  g_awakeRetries = 0;                // Erfolg -> Wach-Retry-Zaehler zuruecksetzen
  Serial.println("Panel aktualisiert.");

  sleepMinutes(chooseIntervalMinutes());
}

void loop() {
  // Wird nie erreicht — nach setup() geht der Chip in Deep Sleep.
}
