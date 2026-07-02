# Dashboard-eInk

800x480-Wanddashboard fuer einen batteriebetriebenen ESP32-eInk-Rahmen.
Ein Node-Renderer (Satori + resvg) baut das Bild aus Kalender, Wetter, KPIs und
Apple-Erinnerungen; der ESP32 zieht es periodisch als gepackten 4-Farb-Puffer.

## Zwei Betriebsarten

- **Lokal (Windows-PC):** `npm start` -> `src/server.mjs` lauscht auf `:8080`.
  Konfiguration via `.env` (siehe `.env.example`).
- **Home Assistant Add-on (Ziel):** Dieses Repo ist zugleich ein lokales
  HA-Add-on. `config.yaml` + `Dockerfile` im Root paketieren denselben Renderer,
  mappen die Add-on-Optionen auf die ENV-Variablen und portieren die
  Apple-Reminder-Bridge nach Linux. **Setup + 2FA: siehe [DOCS.md](DOCS.md).**

## Add-on auf einen Blick

| Datei | Zweck |
|---|---|
| `config.yaml` | Add-on-Metadaten, Optionen/Schema, Port 8080, /data |
| `build.yaml` | Per-Arch HA-Debian-Base (amd64 + aarch64) |
| `Dockerfile` | Base + Node 20 + Python/pyicloud + App (Build-Context = Repo-Root) |
| `addon/rootfs/etc/services.d/eink/run` | s6-Startskript: Optionen -> ENV -> `node src/server.mjs` |
| `addon/rootfs/usr/lib/reminders-bridge/bridge.py` | pyicloud-NDJSON-Bridge (Linux/ENV/`/data`) |
| `addon/rootfs/usr/lib/reminders-bridge/setup_2fa.py` | Einmaliges interaktives iCloud-2FA |
| `.dockerignore` | haelt `node_modules/`, `firmware/`, `.env`, `*.png` aus dem Image |

Der Code unter `src/` und `fonts/` bleibt fuer beide Betriebsarten identisch.

## Endpunkte

- `GET /eink.bin` - gepackter Framebuffer (ESP32)
- `GET /eink.png` - PNG-Vorschau
- `GET /healthz` - Health-Check

Alles Weitere (Installation auf HA OS, iCloud-2FA, ENV-Referenz, Fehlersuche) in
**[DOCS.md](DOCS.md)**.
