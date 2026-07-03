# eInk Dashboard Server - HA-Add-on-Image.
#
# Build-Context = dieses Add-on-Verzeichnis (eink_dashboard/). COPY sieht src/,
# fonts/, package.json, package-lock.json und rootfs/ direkt daneben.
#
# Base: offizielles HA-Debian/glibc-Base. Grund (siehe Recherche R2): resvg
# liefert zwar auch musl-Prebuilts, aber der glibc/gnu-Pfad ist der am besten
# getestete, emulationsrobuste Weg (kein Rust-from-source-Fallback unter QEMU).
#
# Multi-Arch: Der HA-Builder setzt BUILD_FROM pro Arch aus build.yaml. Fuer
# lokale/Standalone-Builds (docker build .) greift der Default. Seit Supervisor
# 2026.04 wird BUILD_FROM nicht mehr auto-injiziert -> expliziter ARG-Default.
ARG BUILD_FROM=ghcr.io/home-assistant/amd64-base-debian:bookworm-2026.06.1
FROM ${BUILD_FROM}

# s6-overlay ist im Base bereits /init -> KEIN eigenes ENTRYPOINT/CMD.
# (config.yaml: init: false)
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# ---------------------------------------------------------------------------
# System-Deps: Node 20 LTS (glibc) via NodeSource + Python 3 fuer die
# pyicloud-Reminder-Bridge. tzdata, damit EINK_TZ (Europe/Berlin) greift.
# base-debian bringt nicht alles mit -> curl/ca-certificates zuerst.
# ---------------------------------------------------------------------------
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg tzdata \
      python3 python3-pip \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# pyicloud fuer die Reminder-Bridge (keyring-frei, Passwort kommt aus ENV).
# Pin auf 2.6.5 (die 2.5->2.6-Serie hat die Auth-/Session-Logik umgebaut).
# --break-system-packages: Debian bookworm markiert das System-Python als
# "externally managed" (PEP 668); im isolierten Add-on-Container ist ein
# globales pip-Install unkritisch und gewollt.
RUN pip3 install --no-cache-dir --break-system-packages "pyicloud==2.6.5"

# ---------------------------------------------------------------------------
# App-Code (unveraendert). Manifeste zuerst -> Layer-Cache fuer node_modules.
# ---------------------------------------------------------------------------
WORKDIR /app
COPY package.json package-lock.json ./

# npm ci --omit=dev entfernt NUR devDependencies, NICHT optionalDependencies.
# resvg fuehrt seine Plattform-Binaries als optionalDeps -> npm waehlt anhand
# von os/cpu/libc des (emulierten) Build-Containers automatisch das passende
# @resvg/resvg-js-linux-<arch>-gnu. Das committete package-lock.json enthaelt
# bereits alle vier linux-Prebuilts (x64/arm64 x gnu/musl) - verifiziert.
# NIEMALS --no-optional/--omit=optional setzen (wuerde resvg zerstoeren).
RUN npm ci --omit=dev --no-audit --no-fund

# Restlicher App-Code inkl. fonts/ (render.mjs liest fonts/Inter-*.ttf zur
# Laufzeit relativ zum Modul). .dockerignore haelt node_modules, *.png, .env
# usw. aus dem Context.
COPY package.json package-lock.json ./
COPY src ./src
COPY fonts ./fonts

# ---------------------------------------------------------------------------
# s6-Service-Tree + Bridge/Setup-Skripte aus rootfs/ einhaengen.
# ---------------------------------------------------------------------------
COPY rootfs /
RUN chmod +x /etc/services.d/eink/run /etc/services.d/eink/finish

# ---------------------------------------------------------------------------
# Pflicht-Labels (frueher build.yaml, seit 2026 hier). BUILD_ARCH/BUILD_VERSION
# liefert der Supervisor; Defaults fuer lokale Builds.
# ---------------------------------------------------------------------------
ARG BUILD_ARCH=amd64
ARG BUILD_VERSION=1.0.0
ARG BUILD_DATE
ARG BUILD_REF
LABEL \
  io.hass.name="eInk Dashboard Server" \
  io.hass.description="Rendert das eInk-Framebuffer und liefert es an ESP32-Clients im LAN" \
  io.hass.type="addon" \
  io.hass.version="${BUILD_VERSION}" \
  io.hass.arch="aarch64|amd64" \
  org.opencontainers.image.title="eInk Dashboard Server" \
  org.opencontainers.image.created="${BUILD_DATE}" \
  org.opencontainers.image.revision="${BUILD_REF}"
