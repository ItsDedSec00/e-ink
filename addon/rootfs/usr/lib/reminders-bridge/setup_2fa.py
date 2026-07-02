"""Einmaliges 2FA-Setup im HA-Add-on-Container. Interaktiv via `docker exec -it`.

Schreibt Session + Trust-Token nach /data/pyicloud -> ueberlebt Neustarts &
Add-on-Updates. Danach findet bridge.py eine getrustete Session und
reminders.mjs bekommt Daten, ohne dass der Render-Pfad je 2FA anfassen muss.

Aufruf (Add-on laeuft, Optionen icloud_apple_id + icloud_apple_password gesetzt):

  docker exec -it addon_local_eink_dashboard \
      python3 /usr/lib/reminders-bridge/setup_2fa.py

Der Slug-Teil `local_eink_dashboard` = "local_" + slug aus config.yaml. Falls
du einen anderen slug nutzt, den Containernamen via `docker ps` pruefen.

Wiederholung nur noetig, wenn der Trust-Cookie (~1 Jahr) abgelaufen ist.
"""

import os
import sys

from pyicloud import PyiCloudService

COOKIE_DIR = os.environ.get("ICLOUD_COOKIE_DIR", "/data/pyicloud")

# reminders.mjs uebergibt beim spawn ICLOUD_USERNAME; im interaktiven Setup
# liegt die Apple-ID in ICLOUD_USERNAME (vom run-Skript exportiert). Fallback
# auf ICLOUD_APPLE_ID, falls jemand das Skript mit anderer Env aufruft.
username = (
    os.environ.get("ICLOUD_USERNAME")
    or os.environ.get("ICLOUD_APPLE_ID")
    or ""
).strip()
password = (os.environ.get("ICLOUD_APPLE_PASSWORD") or "").strip()

if not username or not password:
    sys.exit(
        "ICLOUD_USERNAME/ICLOUD_APPLE_ID oder ICLOUD_APPLE_PASSWORD nicht gesetzt.\n"
        "-> Add-on-Optionen `icloud_apple_id` und `icloud_apple_password` "
        "ausfuellen, Add-on neu starten, dann dieses Skript erneut ausfuehren."
    )

os.makedirs(COOKIE_DIR, mode=0o700, exist_ok=True)
print(f"Melde {username} an ... (Session-Verzeichnis: {COOKIE_DIR})")
api = PyiCloudService(username, password, cookie_directory=COOKIE_DIR)

if api.requires_2fa:
    print(
        "2FA erforderlich. Apple hat den 6-stelligen Code auf deine Trusted "
        "Devices gepusht (iPhone/iPad/Mac)."
    )
    code = input("2FA-Code (6 Ziffern): ").strip()
    if not api.validate_2fa_code(code):
        sys.exit("2FA-Code ungueltig. Skript erneut ausfuehren.")
    print("2FA OK.")
else:
    print("Kein 2FA noetig - Session war bereits getrustet.")

# is_trusted_session ist die 2.6.x-Property. trust_session() setzt das
# ~1-Jahr-Trust-Cookie, damit kuenftige Neustarts kein 2FA mehr brauchen.
if not api.is_trusted_session:
    print("Aktiviere Device-Trust (spart kuenftiges 2FA ~1 Jahr) ...")
    if not api.trust_session():
        print(
            "Warnung: trust_session schlug fehl - naechster Start braucht "
            "evtl. wieder 2FA."
        )

# Smoke-Test: Listen sichtbar? Bestaetigt, dass Reminders funktionieren.
try:
    lists = list(api.reminders.lists())
    print(f"OK - {len(lists)} Reminder-Listen sichtbar. Session in {COOKIE_DIR} persistiert.")
    for l in lists:
        title = getattr(l, "title", None) or getattr(l, "name", None) or "?"
        print(f"  - {title}")
except Exception as e:  # noqa: BLE001
    print(f"Warnung: Listen konnten nicht gelesen werden: {e}")
    print("Trust wurde aber gesetzt - starte das Add-on neu und pruefe die Logs.")

print("\nFertig. Add-on neu starten (oder weiterlaufen lassen) - "
      "der naechste Reminder-Refresh nutzt die getrustete Session.")
