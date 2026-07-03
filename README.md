# e-ink — Wanddashboard fuer einen batteriebetriebenen ESP32-eInk-Rahmen

800x480-Wanddashboard: ein Node-Renderer (Satori + resvg) baut das Bild aus
Kalender, Wetter, Business-KPIs und Apple-Erinnerungen; ein ESP32-S3 zieht es
periodisch als gepackten 4-Farb-Puffer (BWRY) und schlaeft zwischen den
Refreshes tief. Alle Zugangsdaten kommen aus `.env` bzw. den Add-on-Optionen —
im Repo sind **keine** Secrets oder persoenlichen Daten.

## Repo-Struktur

Dieses Repo ist zugleich ein **Home-Assistant-Add-on-Repository**.

| Pfad | Inhalt |
|---|---|
| `repository.yaml` | HA-Repository-Deskriptor (macht das Repo in HA hinzufuegbar) |
| `eink_dashboard/` | Das HA-Add-on **und** der Node-Renderer (`src/`, `fonts/`, `Dockerfile`, `config.yaml`) |
| `eink_dashboard/DOCS.md` | Installation auf HA OS, iCloud-2FA, ENV-Referenz, Fehlersuche |
| `firmware/` | PlatformIO-ESP32-S3-Sketches (`dashboard` = Produktiv, plus Diagnose-Sketches) |

## In Home Assistant installieren

1. **Einstellungen → Add-ons → Add-on-Store → ⋮ (oben rechts) → Repositories**
2. `https://github.com/ItsDedSec00/e-ink` einfuegen → **Hinzufuegen**.
3. Das Add-on **„eInk Dashboard Server"** erscheint im Store → installieren.
4. Konfigurieren + starten: siehe **[eink_dashboard/DOCS.md](eink_dashboard/DOCS.md)**.

Der ESP32 zieht das Bild dann von `http://<ha-ip>:8080/eink.bin`.

## Lokal ausfuehren (ohne HA)

```bash
cd eink_dashboard
cp .env.example .env      # ausfuellen (oder leer lassen -> Mock-Daten)
npm install
npm start                 # lauscht auf :8080
```

Die `.env` wird modul-relativ geladen und daher unabhaengig vom Arbeits-
verzeichnis gefunden.

### Endpunkte

- `GET /eink.bin` — gepackter Framebuffer (2 Bit/Pixel, 96000 Bytes; fuer den ESP32)
- `GET /eink.png` — PNG-Vorschau
- `GET /healthz` — Health-Check

## Firmware

Die ESP32-S3-Firmware liegt unter `firmware/dashboard/`. WLAN-/Renderer-Zugang
wird aus `firmware/dashboard/src/secrets.h` gelesen — Vorlage:
`firmware/dashboard/src/secrets.h.example` (kopieren und ausfuellen).
