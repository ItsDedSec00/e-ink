// DIAG — Netzwerk-Diagnose, Ausgabe DIREKT aufs eInk-Panel (kein Serial noetig).
// Testet: 2.4-GHz-Sichtbarkeit, WLAN-Verbindung, TCP-Erreichbarkeit des PCs, HTTP.
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <bb_epaper.h>

// Vor dem Flashen ausfuellen (eigenstaendiger Diagnose-Sketch, nutzt kein secrets.h):
#define WIFI_SSID "DEIN_WLAN_SSID"
#define WIFI_PASS "DEIN_WLAN_PASSWORT"
#define HOST      "192.168.1.100"
#define PORT      8080
#define URL       "http://192.168.1.100:8080/eink.bin?key=DEIN_EINK_KEY"

// Panel-Pins (XIAO ePaper Board EE04)
#define DC_PIN 10
#define BUSY_PIN 4
#define CS_PIN 44
#define RESET_PIN 38
#define SCK_PIN 7
#define MOSI_PIN 9

BBEPAPER bbep(EP75YR_800x480);

static String  g_lines[20];
static int     g_colors[20];
static int     g_n = 0;
static void add(const String &s, int color = BBEP_BLACK) {
  if (g_n < 20) { g_lines[g_n] = s; g_colors[g_n] = color; g_n++; }
}

static void runTests() {
  add("NETCHECK  -  eInk Dashboard Diagnose");
  add("");

  // 1) Scan: ist die Ziel-SSID (WIFI_SSID) auf 2.4 GHz sichtbar?
  WiFi.mode(WIFI_STA);
  int n = WiFi.scanNetworks();
  bool seen = false; int ch = 0, rssi = 0;
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == WIFI_SSID) { seen = true; ch = WiFi.channel(i); rssi = WiFi.RSSI(i); }
  }
  WiFi.scanDelete();
  if (seen) add(String("Scan: '" WIFI_SSID "' auf 2.4 GHz sichtbar (Kanal ") + ch + ", " + rssi + " dBm)");
  else      add(String("Scan: '" WIFI_SSID "' NICHT auf 2.4 GHz! (5-GHz-only?)  [") + n + " Netze]", BBEP_RED);

  // 2) Verbinden
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) delay(200);

  if (WiFi.status() != WL_CONNECTED) {
    add(String("WLAN: KEINE Verbindung (status=") + WiFi.status() + ")", BBEP_RED);
    add("  -> Passwort falsch oder nicht auf 2.4 GHz", BBEP_RED);
    return;
  }
  add("WLAN: verbunden");
  add(String("  IP ") + WiFi.localIP().toString() + "   GW " + WiFi.gatewayIP().toString());
  add(String("  RSSI ") + WiFi.RSSI() + " dBm");

  // 3) Roher TCP-Connect zum PC (trennt Firewall/Isolation von HTTP)
  WiFiClient c; c.setTimeout(5000);
  if (!c.connect(HOST, PORT)) {
    add(String("TCP " HOST ":") + PORT + ": FEHLGESCHLAGEN", BBEP_RED);
    add("  -> PC-Firewall blockt ODER WLAN-Client-Isolation", BBEP_RED);
    return;
  }
  add(String("TCP " HOST ":") + PORT + ": OK (PC erreichbar)");
  c.stop();

  // 4) HTTP GET
  HTTPClient http; http.setConnectTimeout(8000); http.setTimeout(15000);
  http.begin(URL);
  int code = http.GET();
  if (code == 200) add(String("HTTP GET /eink.bin: 200 OK  (") + http.getSize() + " Bytes)");
  else             add(String("HTTP GET /eink.bin: FEHLER ") + code, BBEP_RED);
  http.end();

  add("");
  if (code == 200) add(">> Alles gruen: Dashboard-Firmware sollte laufen!");
}

static void drawToPanel() {
  bbep.initIO(DC_PIN, RESET_PIN, BUSY_PIN, CS_PIN, MOSI_PIN, SCK_PIN);
  bbep.allocBuffer();
  bbep.fillScreen(BBEP_WHITE);
  bbep.drawRect(0, 0, 800, 480, BBEP_BLACK);
  bbep.setFont(FONT_12x16);
  int y = 24;
  for (int i = 0; i < g_n; i++) {
    bbep.setTextColor(g_colors[i], BBEP_TRANSPARENT);
    bbep.setCursor(24, y);
    bbep.print(g_lines[i]);
    y += 28;
  }
  bbep.writePlane();
  bbep.refresh(REFRESH_FULL, true);
  // bbep.sleep(DEEP_SLEEP);   // (DEBUG) Panel-Controller wach lassen
}

void setup() {
  runTests();
  drawToPanel();
}
void loop() {}
