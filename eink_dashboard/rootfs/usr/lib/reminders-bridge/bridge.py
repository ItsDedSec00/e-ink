"""Pyicloud bridge sidecar - Home-Assistant-Add-on-Variante.

NDJSON-Protokoll IDENTISCH zur lokalen Windows-Bridge, damit src/sources/reminders.mjs
UNVERAENDERT bleibt:
  Request:  {"id": "<id>", "op": "<op>", "args": {...}}
  Response: {"id": "<echo>", "result": <...>}  |  {"id": "<echo>", "error": "<msg>"}

Unterschiede zur lokalen Windows-Bridge:
  * Passwort aus ENV ICLOUD_APPLE_PASSWORD  (kein Windows Credential Manager / keyring)
  * cookie_directory = /data/pyicloud        (persistent ueber Add-on-Neustarts/-Updates)

reminders.mjs spawnt uns mit ICLOUD_USERNAME + ICLOUD_REMINDER_LISTS in der Env
und erbt den Rest von process.env des Node-Servers. Das run-Skript des Add-ons
exportiert deshalb ICLOUD_APPLE_PASSWORD (und ICLOUD_COOKIE_DIR) global, bevor
der Node-Server startet.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import traceback
from datetime import datetime
from typing import Any, Callable

# UTF-8 erzwingen (Umlaute in Reminder-Titeln). Vor jedem I/O.
for _stream in (sys.stdout, sys.stderr, sys.stdin):
    try:
        _stream.reconfigure(encoding="utf-8", newline="\n")  # type: ignore[union-attr]
    except Exception:
        pass

from pyicloud import PyiCloudService
from pyicloud.exceptions import PyiCloudAPIResponseException

MAX_INDEX_RETRIES = 6
DEFAULT_BACKOFF_S = 35

# Persistentes Session-/Cookie-Verzeichnis. HA gibt Add-ons /data als einziges
# Volume, das Neustarts (und Add-on-Updates) ueberlebt.
COOKIE_DIR = os.environ.get("ICLOUD_COOKIE_DIR", "/data/pyicloud")

_api: PyiCloudService | None = None


# -- Auth / API session --------------------------------------------------------

def get_api() -> PyiCloudService:
    """Return a logged-in PyiCloudService. Re-uses session if available."""
    global _api
    username = (os.environ.get("ICLOUD_USERNAME") or "").strip()
    if not username:
        raise RuntimeError("ICLOUD_USERNAME ist nicht gesetzt.")

    if _api is None:
        # Passwort aus ENV statt keyring. Wird vom Add-on aus der Option
        # `icloud_apple_password` (bashio config) in die Umgebung gereicht.
        password = (os.environ.get("ICLOUD_APPLE_PASSWORD") or "").strip()
        if not password:
            raise RuntimeError(
                "needs_reauth: ICLOUD_APPLE_PASSWORD ist leer - "
                "Add-on-Option `icloud_apple_password` setzen."
            )
        # Verzeichnis sicherstellen, damit pyicloud dort schreiben darf.
        try:
            os.makedirs(COOKIE_DIR, mode=0o700, exist_ok=True)
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"cookie_directory {COOKIE_DIR} nicht anlegbar: {e}") from e
        try:
            # cookie_directory explizit auf /data -> Session + Trust landen in
            # {COOKIE_DIR}/{sanitized_apple_id}.session und bleiben ueber
            # Neustarts erhalten. Ohne dieses Argument schreibt pyicloud nach
            # tempdir und verliert alles beim Container-Restart.
            _api = PyiCloudService(
                username,
                password,
                cookie_directory=COOKIE_DIR,
            )
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(f"Auth fehlgeschlagen: {e}") from e

    if _api.requires_2fa:
        # Trust-Cookie abgelaufen ODER Erst-Login: interaktives 2FA noetig.
        # Der eInk-Render-Pfad kann das nicht - der Setup-Flow (setup_2fa.py)
        # muss einmalig laufen. Bis dahin jede op sauber mit needs_reauth
        # beantworten, damit reminders.mjs sauber auf null faellt.
        raise RuntimeError(
            "needs_reauth: 2FA verlangt - Trust abgelaufen oder Erst-Login. "
            "2FA-Setup ausfuehren: docker exec -it addon_local_eink_dashboard "
            "python3 /usr/lib/reminders-bridge/setup_2fa.py"
        )
    return _api


# -- CloudKit retry helper -----------------------------------------------------

def with_index_retry(fn: Callable[[], Any]) -> Any:
    """Run `fn` and auto-retry on Apple's TRY_AGAIN_LATER."""
    last_exc: Exception | None = None
    for attempt in range(1, MAX_INDEX_RETRIES + 1):
        try:
            return fn()
        except PyiCloudAPIResponseException as e:
            msg = str(e)
            if "TRY_AGAIN_LATER" not in msg and "retryAfter" not in msg:
                raise
            wait = parse_retry_after(msg) or DEFAULT_BACKOFF_S
            last_exc = e
            print(
                f"[bridge] TRY_AGAIN_LATER {attempt}/{MAX_INDEX_RETRIES}, warte {wait}s",
                file=sys.stderr, flush=True,
            )
            time.sleep(wait + 2)
    assert last_exc is not None
    raise last_exc


def parse_retry_after(msg: str) -> int | None:
    m = re.search(r'"retryAfter"\s*:\s*(\d+)', msg)
    return int(m.group(1)) if m else None


# -- List matching (name -> list_id) -------------------------------------------

def match_lists(lists: list, needle: str) -> list:
    n = needle.strip().lower()
    if not n:
        return list(lists)
    by_id = [l for l in lists if n in str(_attr(l, "id", "identifier", "guid", default="")).lower()]
    if by_id:
        return by_id
    return [
        l for l in lists
        if str(_attr(l, "title", "name", default="")).lower().startswith(n)
        or n in str(_attr(l, "title", "name", default="")).lower()
    ]


def parse_whitelist() -> list[str] | None:
    raw = os.environ.get("ICLOUD_REMINDER_LISTS", "").strip()
    if not raw:
        return None
    return [s.strip() for s in raw.split(",") if s.strip()]


def apply_whitelist(lists: list) -> list:
    wl = parse_whitelist()
    if not wl:
        return list(lists)
    keep: list = []
    for entry in wl:
        for hit in match_lists(lists, entry):
            if hit not in keep:
                keep.append(hit)
    if not keep:
        print("[bridge] ICLOUD_REMINDER_LISTS matched nothing - using all lists",
              file=sys.stderr, flush=True)
        return list(lists)
    return keep


# -- Helpers -------------------------------------------------------------------

def _attr(obj: Any, *names: str, default: Any = None) -> Any:
    for n in names:
        if hasattr(obj, n):
            v = getattr(obj, n)
            if v is not None:
                return v
        if isinstance(obj, dict) and obj.get(n) is not None:
            return obj[n]
    return default


def _fmt_dt(v: Any) -> str | None:
    if v is None:
        return None
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return str(v)


def _parse_iso(v: str | None) -> datetime | None:
    if not v:
        return None
    s = v.strip()
    if not s:
        return None
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    return datetime.fromisoformat(s)


# -- Operations ----------------------------------------------------------------

def op_list_lists(_args: dict) -> Any:
    rem = get_api().reminders
    lists = apply_whitelist(list(rem.lists()))
    return [
        {
            "id": str(_attr(l, "id", "identifier", "guid", default="")),
            "title": _attr(l, "title", "name", default=""),
            "count": _attr(l, "count", "size"),
        }
        for l in lists
    ]


def op_list_reminders(args: dict) -> Any:
    rem = get_api().reminders
    list_filter = (args.get("list") or "").strip()
    only_open = bool(args.get("only_open", True))

    all_lists = apply_whitelist(list(rem.lists()))
    if list_filter:
        target = match_lists(all_lists, list_filter)
        if not target:
            return {"error": f"Keine Reminder-Liste matcht '{list_filter}'"}
    else:
        target = all_lists

    out: list[dict] = []
    for lst in target:
        list_id = str(_attr(lst, "id", "identifier", "guid", default=""))
        list_title = _attr(lst, "title", "name", default="?")
        try:
            reminders = with_index_retry(lambda lid=list_id: list(rem.reminders(list_id=lid)))
        except Exception as e:  # noqa: BLE001
            print(f"[bridge] Liste {list_title} uebersprungen: {e}", file=sys.stderr, flush=True)
            continue
        for r in reminders:
            done = bool(_attr(r, "completed", "is_completed", default=False))
            if only_open and done:
                continue
            out.append({
                "id": str(_attr(r, "id", "identifier", "guid", default="")),
                "title": _attr(r, "title", "summary", default=""),
                "due": _fmt_dt(_attr(r, "due", "due_date", "due_at")),
                "completed": done,
                "notes": _attr(r, "description", "notes", "desc"),
                "list": list_title,
            })

    out.sort(key=lambda x: (
        x["completed"],
        x["due"] or "9999-12-31T00:00:00",
        x["title"] or "",
    ))
    return out


def op_create_reminder(args: dict) -> Any:
    if not args.get("title"):
        return {"error": "title fehlt"}
    title = str(args["title"]).strip()
    list_filter = (args.get("list") or "").strip()
    due_iso = args.get("due_iso")
    notes = args.get("notes")

    rem = get_api().reminders
    all_lists = apply_whitelist(list(rem.lists()))
    target = None
    if list_filter:
        matches = match_lists(all_lists, list_filter)
        if not matches:
            return {"error": f"Keine Reminder-Liste matcht '{list_filter}'"}
        target = matches[0]
    else:
        default = (os.environ.get("ICLOUD_DEFAULT_WRITE_REMINDER_LIST") or "").strip()
        if default:
            matches = match_lists(all_lists, default)
            if matches:
                target = matches[0]
        if target is None:
            if not all_lists:
                return {"error": "Keine Reminder-Liste gefunden."}
            target = all_lists[0]

    due_dt = _parse_iso(due_iso) if isinstance(due_iso, str) else None
    list_title = _attr(target, "title", "name", default="?")
    list_id = str(_attr(target, "id", "identifier", "guid", default=""))

    try:
        created = rem.create(
            list_id=list_id, title=title,
            desc=notes if isinstance(notes, str) and notes.strip() else None,
            due_date=due_dt,
        )
    except TypeError:
        created = rem.create(title, list_id, due_dt, notes)  # type: ignore[misc]

    return {
        "success": True,
        "message": f'"{title}" in {list_title} angelegt',
        "id": str(_attr(created, "id", "identifier", default="")),
        "list": list_title,
    }


def op_complete_reminder(args: dict) -> Any:
    rid = (args.get("id") or "").strip()
    if not rid:
        return {"error": "id fehlt"}
    rem = get_api().reminders
    target = rem.get(rid)
    if target is None:
        return {"error": f"Reminder {rid} nicht gefunden"}
    setattr(target, "completed", True)
    rem.update(target)
    return {"success": True}


def op_delete_reminder(args: dict) -> Any:
    rid = (args.get("id") or "").strip()
    if not rid:
        return {"error": "id fehlt"}
    rem = get_api().reminders
    target = rem.get(rid)
    if target is None:
        return {"error": f"Reminder {rid} nicht gefunden"}
    rem.delete(target)
    return {"success": True}


OPS: dict[str, Callable[[dict], Any]] = {
    "list_lists": op_list_lists,
    "list_reminders": op_list_reminders,
    "create_reminder": op_create_reminder,
    "complete_reminder": op_complete_reminder,
    "delete_reminder": op_delete_reminder,
}


# -- Stdin/stdout NDJSON loop --------------------------------------------------

def send(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
    print("[bridge] ready", file=sys.stderr, flush=True)
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            send({"error": f"bad JSON: {e}"})
            continue
        req_id = req.get("id")
        op_name = req.get("op")
        args = req.get("args") or {}
        try:
            handler = OPS.get(op_name)
            if not handler:
                send({"id": req_id, "error": f"unknown op: {op_name}"})
                continue
            result = handler(args)
            if isinstance(result, dict) and "error" in result and "success" not in result:
                send({"id": req_id, "error": result["error"]})
            else:
                send({"id": req_id, "result": result})
        except Exception as e:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            send({"id": req_id, "error": str(e)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
