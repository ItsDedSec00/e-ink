# eInk Dashboard Server

Rendert das 800x480-Dashboard (Kalender, Wetter, KPIs, Apple-Erinnerungen) und
liefert es an den batteriebetriebenen ESP32-eInk-Rahmen im LAN. Der Node-Renderer
aus `src/` laeuft dabei **unveraendert** im Container; dieses Add-on paketiert ihn
nur, mappt die Optionen auf die erwarteten ENV-Variablen und portiert die
Apple-Reminder-Bridge von Windows (Credential Manager) auf Linux (ENV + `/data`).

## Endpunkte (Port 8080)

| Pfad | Zweck |
|---|---|
| `GET /eink.bin` | Gepackter 4-Farb-Puffer (96000 B) - der ESP32 streamt ihn direkt ins Panel |
| `GET /eink.png` (`/eink`, `/`) | 800x480 PNG (Vorschau im Browser) |
| `GET /healthz` | Health-Check (der Add-on-Watchdog nutzt den TCP-Port) |
| `POST /button/<n>` | Platzhalter fuer Tastendruck (HA-Aktion noch nicht verdrahtet) |

Optionaler Schutz: Ist `eink_key` gesetzt, muss der Client `?key=<eink_key>`
anhaengen (`.../eink.bin?key=...`). Akkustand meldet der ESP32 via `?bat=87`.

---

## Installation (Home Assistant OS)

### 1. Add-on-Ordner auf den HA-Host bringen

Das lokale Add-on muss unter `/addons/<slug>/` auf dem HA-Host liegen. Zugang via
**Samba share** oder **Advanced SSH & Web Terminal** (nur dieses zeigt das echte
Host-`/addons`; das offizielle "Terminal & SSH" nicht).

Lege den **kompletten Repo-Inhalt** (dieses Verzeichnis) nach
`/addons/eink-dashboard/` (Samba: `\\<ha-ip>\addons\eink-dashboard\`). Der
Supervisor baut das Image aus dem Repo-Root (`Dockerfile` + `config.yaml` liegen
dort; Build-Context = Repo-Root, damit `src/` und `fonts/` mit ins Image kommen).

> Wichtig: `package-lock.json` muss mitkopiert werden (liegt im Repo). `npm ci`
> braucht es, und es enthaelt bereits alle vier Linux-resvg-Prebuilts. `node_modules/`
> **nicht** kopieren - `.dockerignore` schliesst es aus, npm installiert im
> Container die arch-korrekten Binaries frisch.

### 2. Store neu laden & installieren

Settings -> Add-ons -> **Add-on Store** -> oben rechts drei Punkte -> **Check for
updates** (oder Seite neu laden). Das Add-on erscheint unter **Local add-ons**.
Oeffnen -> **Install** (der erste Build dauert einige Minuten, v. a. unter
aarch64-Emulation).

### 3. Konfigurieren

Tab **Configuration**. Alles ist optional - ohne Keys laufen die betroffenen
Kacheln mit Mock-Daten. Sinnvolles Minimum:

```yaml
eink_tz: Europe/Berlin
eink_weather_city: München
# Live-KPIs brauchen BEIDES (stripe + App-1-Admin-API):
stripe_secret_key: sk_live_...
app1_api_key: ...
# iCloud-Kalender (CalDAV, app-spezifisches Passwort von appleid.apple.com):
icloud_user: du@icloud.com
icloud_app_pw: xxxx-xxxx-xxxx-xxxx
icloud_calendars: "Familie,Privat"
# Apple-Erinnerungen (pyicloud, ECHTES Apple-ID-Passwort - siehe 2FA unten):
icloud_apple_id: du@icloud.com
icloud_apple_password: dein-apple-id-passwort
icloud_reminder_lists: "Einkaufen,Haushalt"
```

Danach **Start**. Logs im Tab **Log** (Live-stdout des Node-Servers), oder CLI:
`ha addons logs local_eink_dashboard`.

### 4. ESP32 umbiegen

Der ESP32 zieht das Bild jetzt vom HA-Host statt vom Windows-PC. In der Firmware
die URL anpassen:

```cpp
// vorher: dein Windows-PC im LAN
// #define IMG_URL "http://192.168.x.PC:8080/eink.bin"
#define IMG_URL "http://<ha-host-ip>:8080/eink.bin"
// optional mit Shared Secret:
// #define IMG_URL "http://<ha-host-ip>:8080/eink.bin?key=<eink_key>"
```

Host-IP = die IP deiner HA-Instanz. Port 8080 wird per `ports:` vom Container auf
den Host gemappt.

---

## Einmaliges iCloud-2FA-Setup (nur fuer Apple-Erinnerungen)

CalDAV-Kalender (`icloud_user`/`icloud_app_pw`) und oeffentliche iCal-Feeds laufen
sofort. Die **Erinnerungen** gehen ueber pyicloud und brauchen beim ersten Mal
einen 6-stelligen 2FA-Code (Apple pusht ihn auf deine Geraete). Das geht komplett
ueber die **Add-on-Weboberflaeche** in der HA-Seitenleiste - kein SSH / kein `docker exec`:

1. Optionen `icloud_apple_id` + `icloud_apple_password` (das **echte** Apple-ID-
   Passwort, nicht das App-spezifische) setzen, Add-on **starten** bzw. neu starten.
2. Add-on-Seite -> **"OPEN WEB UI"** (oder das Panel in der HA-Seitenleiste). Im
   Abschnitt **iCloud-Erinnerungen** auf **"Mit iCloud anmelden & Code anfordern"**
   klicken -> Apple pusht den Code auf deine Trusted Devices (iPhone/iPad/Mac). Der
   Login passiert NUR auf diesen Klick (kein Auto-Login beim Seitenladen), damit
   Apple nicht wegen zu vieler Versuche mit **503** sperrt - fordere den Code **nicht
   mehrfach hintereinander** an. Die Oberflaeche ist ueber HA authentifiziert
   (Ingress) - keine IP/kein Port noetig. Direkt-Alternative: `http://<ha-ip>:8080/`
   (mit `eink_key`: `…/?key=DEIN_KEY`).
3. Code eingeben -> **Bestaetigen**. Die Seite ruft `validate_2fa_code()` +
   `trust_session()`; Session + Trust landen in `/data/pyicloud` und **ueberleben
   Neustarts und Add-on-Updates**. Kein Code angekommen? **Neuen Code anfordern**.
4. Fertig ("✅ Eingerichtet"). Der naechste Reminder-Refresh (ein paar Minuten)
   nutzt die getrustete Session. Der Trust-Cookie haelt ~1 Jahr; erst dann ist das
   Setup zu wiederholen.

Die Weboberflaeche zeigt ausserdem eine **Live-Vorschau** des gerenderten Panels und
einen **Status** (welche Quellen live/mock sind). Ueber Ingress ist sie von HA
authentifiziert; am direkten Port greift - falls gesetzt - der `eink_key`. Der alte
Shell-Weg (`python3 /usr/lib/reminders-bridge/setup_2fa.py` via `docker exec`) bleibt
als Fallback fuer Fortgeschrittene erhalten.

---

## Persistenz & Backup

Alles Zustandsbehaftete liegt in `/data` (im HA-Backup enthalten):

- `/data/pyicloud/…session` - iCloud-Session + Trust-Token
- `/data/.reminders-cache.json` - letzter Reminder-Stand (sofort warm nach Neustart)

Ein Add-on-Update baut das Image neu, laesst `/data` aber unangetastet - 2FA muss
also nach Updates **nicht** erneut gemacht werden.

---

## Sicherheit

Das Add-on läuft im **Protection-Mode** ohne erhöhte Rechte: kein `host_network`,
kein `privileged`, kein `full_access`, kein Docker-API-Zugriff, keine
`hassio_role`. Es bringt ein **AppArmor-Profil** mit (`apparmor.txt`), das dem
Container nur die von s6-overlay/Node/Python benötigten Rechte lässt und die
gefährlichen Kernel-/Netz-Capabilities (`SYS_ADMIN`, `SYS_MODULE`, `SYS_RAWIO`,
`SYS_PTRACE`, `NET_ADMIN`, `NET_RAW`, …) sperrt. Damit erreicht das Add-on das
**HA-Security-Rating 6/6** (Maximum).

**Wichtiger Resthinweis — der eInk-Port ist bewusst offen:** Damit ein headless
ESP32 das Bild ziehen kann (der kann die HA-Ingress-Authentifizierung nicht
durchlaufen), wird TCP **8080 direkt im LAN** exponiert. Dieser Endpunkt ist
standardmäßig **nicht** authentifiziert. Setze deshalb im Configuration-Tab einen
`eink_key` (freies Shared Secret) — dann liefert der Server nur bei
`http://<ha-ip>:8080/eink.bin?key=…` aus und antwortet sonst mit **403**. Den
gleichen Key trägst du in der ESP32-`secrets.h` (`IMG_URL`) ein. Das Add-on selbst
speichert oder überträgt keine Daten nach außen außer den von dir konfigurierten
API-Aufrufen; alle Secrets bleiben in den (maskierten) Add-on-Optionen bzw. in
`/data`.

---

## Fehlersuche

| Symptom | Ursache / Fix |
|---|---|
| Log: `needs_reauth: 2FA verlangt` / `kein Trust hinterlegt` | 2FA-Setup (oben) noch nicht gelaufen oder Trust abgelaufen |
| Login-Fehler `503` / "Apple hat die Anmeldung blockiert" | Apple-Cooldown durch zu viele Anmeldeversuche. ~15-60 Min warten, Seite/Code **nicht** spammen. Hintergrund-Refreshes loesen KEINEN Login aus (erst nach erfolgreichem Setup), also nur der manuelle Klick zaehlt |
| Reminders bleiben leer, kein 2FA-Hinweis | `icloud_apple_id` gesetzt, aber `icloud_apple_password` fehlt |
| KPIs zeigen Mock-Werte | Live-KPIs brauchen `stripe_secret_key` **und** `app1_api_key` |
| ESP32 bekommt 403 | `eink_key` gesetzt -> URL braucht `?key=...` |
| Build bricht bei `npm ci` | `package-lock.json` fehlt im Ordner, oder `node_modules/` wurde mitkopiert |
| Kalender leer | `icloud_calendars` muss die **Anzeigenamen** treffen; app-spezifisches PW pruefen |

Build-/Laufzeit-Details und Risiken stehen in der Architektur-Ausgabe (`design`,
`keyRisks`).
