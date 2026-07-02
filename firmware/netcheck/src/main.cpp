// NETCHECK — Netzwerk-Diagnose fuer das eInk-Dashboard.
// Bleibt wach und wiederholt die Tests alle 15 s, damit der Log live lesbar ist.
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>

// Vor dem Flashen ausfuellen (eigenstaendiger Diagnose-Sketch, nutzt kein secrets.h):
#define WIFI_SSID "DEIN_WLAN_SSID"
#define WIFI_PASS "DEIN_WLAN_PASSWORT"
#define HOST      "192.168.1.100"
#define PORT      8080
#define URL       "http://192.168.1.100:8080/eink.bin?key=DEIN_EINK_KEY"

static void scan() {
  Serial.println("--- WLAN-Scan (ESP32-S3 sieht NUR 2.4 GHz) ---");
  int n = WiFi.scanNetworks();
  if (n <= 0) { Serial.println("  (keine Netze gefunden)"); return; }
  bool found = false;
  for (int i = 0; i < n; i++) {
    bool isTarget = (WiFi.SSID(i) == WIFI_SSID);
    found |= isTarget;
    Serial.printf("  %2d) Kanal %2d  %4d dBm  %s%s\n",
                  i, WiFi.channel(i), WiFi.RSSI(i), WiFi.SSID(i).c_str(),
                  isTarget ? "   <== ZIEL (also auf 2.4 GHz sichtbar)" : "");
  }
  if (!found) Serial.println("  !! '" WIFI_SSID "' NICHT im 2.4-GHz-Scan -> vermutlich 5-GHz-only -> ESP32 kann nicht rein.");
  WiFi.scanDelete();
}

static bool connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Verbinde mit '" WIFI_SSID "'");
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 20000) { delay(300); Serial.print("."); }
  Serial.println();
  int st = WiFi.status();
  Serial.printf("WiFi.status()=%d  (3=WL_CONNECTED, sonst Fehler)\n", st);
  if (st == WL_CONNECTED) {
    Serial.printf("  IP %s  GW %s  DNS %s  RSSI %d dBm\n",
                  WiFi.localIP().toString().c_str(),
                  WiFi.gatewayIP().toString().c_str(),
                  WiFi.dnsIP().toString().c_str(),
                  (int)WiFi.RSSI());
  }
  return st == WL_CONNECTED;
}

static void tcpTest() {
  Serial.printf("--- TCP-Connect zu %s:%d ---\n", HOST, PORT);
  WiFiClient c;
  c.setTimeout(5000);
  if (c.connect(HOST, PORT)) {
    Serial.println("  TCP OK  -> PC erreichbar (keine Client-Isolation, Firewall laesst durch)");
    c.stop();
  } else {
    Serial.println("  TCP FEHLGESCHLAGEN  -> PC-Firewall blockt ODER WLAN-Client-Isolation");
  }
}

static void httpTest() {
  Serial.println("--- HTTP GET /eink.bin ---");
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(15000);
  if (!http.begin(URL)) { Serial.println("  http.begin() fehlgeschlagen"); return; }
  int code = http.GET();
  Serial.printf("  GET -> %d\n", code);
  if (code == 200) Serial.printf("  Content-Length: %d Bytes (erwartet 96000)\n", http.getSize());
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(1200);
  Serial.println("\n\n===== NETCHECK =====");
  scan();
  if (connectWiFi()) { tcpTest(); httpTest(); }
  else Serial.println("Keine WLAN-Verbindung -> SSID/Passwort/2.4-GHz pruefen (Scan oben).");
}

void loop() {
  delay(5000);
  Serial.println("\n----- Durchlauf -----");
  if (WiFi.status() != WL_CONNECTED) {
    scan();                       // bei fehlender Verbindung: zeigt 2.4-GHz-Sichtbarkeit
    if (!connectWiFi()) return;
  }
  tcpTest();
  httpTest();
}
