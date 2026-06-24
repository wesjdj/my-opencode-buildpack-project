#!/usr/bin/env bash
# Renku code-based session launch process (Procfile `web:`). Seeds pi config, brings up
# Tailscale (userspace, static binaries fetched at boot), then runs the pi-bridge.
#
# The custom-image equivalent is renku-session/entrypoint.sh; keep the two in sync.
set -euo pipefail
log() { echo "[start] $*" >&2; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="${BRIDGE_DIR:-$ROOT/bridge}"
if [ ! -f "$BRIDGE_DIR/src/server.ts" ]; then
  # Builder may have relocated the Node app; try to find it.
  found="$(find "$ROOT" -maxdepth 4 -path '*/src/server.ts' -print -quit 2>/dev/null || true)"
  [ -n "$found" ] && BRIDGE_DIR="$(cd "$(dirname "$found")/.." && pwd)"
fi
PI_SKEL="${PI_SKEL:-}"
if [ -z "$PI_SKEL" ]; then
  for cand in "$ROOT/renku-session/pi" "$ROOT/pi" "$ROOT/pi-skel"; do
    [ -f "$cand/settings.json" ] && { PI_SKEL="$cand"; break; }
  done
fi
log "ROOT=$ROOT  BRIDGE_DIR=$BRIDGE_DIR  PI_SKEL=$PI_SKEL"

# ---------------------------------------------------------------------------
# 1. pi config (persist on the workspace mount, seed from the baked skeleton)
# ---------------------------------------------------------------------------
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
if [ -n "${PI_PERSIST_DIR:-}" ]; then
  mkdir -p "$PI_PERSIST_DIR"
  if [ ! -e "$PI_AGENT_DIR" ] || [ -L "$PI_AGENT_DIR" ]; then
    mkdir -p "$(dirname "$PI_AGENT_DIR")"; rm -f "$PI_AGENT_DIR"
    ln -s "$PI_PERSIST_DIR" "$PI_AGENT_DIR"
    log "pi agent dir -> $PI_PERSIST_DIR (persistent)"
  fi
fi
mkdir -p "$PI_AGENT_DIR/extensions/pi-permission-system"
# settings.json is managed config — always refresh it from the baked skeleton.
cp "$PI_SKEL/settings.json" "$PI_AGENT_DIR/settings.json"
[ -f "$PI_AGENT_DIR/extensions/pi-permission-system/config.json" ] \
  || cp "$PI_SKEL/permission-system-config.json" \
        "$PI_AGENT_DIR/extensions/pi-permission-system/config.json"

# Model provider config: render models.json, injecting the SDSC vLLM API key from a
# Renku secret (env SDSC_API_KEY, or SDSC_API_KEY_FILE pointing at a mounted secret).
if [ -z "${SDSC_API_KEY:-}" ] && [ -n "${SDSC_API_KEY_FILE:-}" ] && [ -f "$SDSC_API_KEY_FILE" ]; then
  SDSC_API_KEY="$(tr -d '\r\n' < "$SDSC_API_KEY_FILE")"
fi
if [ -n "${SDSC_API_KEY:-}" ] && [ -f "$PI_SKEL/models.json" ]; then
  sed "s|__SDSC_API_KEY__|${SDSC_API_KEY}|g" "$PI_SKEL/models.json" > "$PI_AGENT_DIR/models.json"
  log "wrote models.json (sdsc provider) with injected API key"
else
  log "WARN: no SDSC_API_KEY/_FILE — pi will have no model credentials (expect 401)"
fi

# ---------------------------------------------------------------------------
# 2. Tailscale (static userspace binaries — buildpacks can't apt-install a daemon)
# ---------------------------------------------------------------------------
if [ "${TS_ENABLE:-1}" = "1" ]; then
  TS_BIN_DIR="${TS_BIN_DIR:-${PI_PERSIST_DIR:-$HOME}/.tailscale-bin}"
  TS_SOCK="${TS_SOCK:-$HOME/tailscaled.sock}"
  TS_STATE_DIR="${TS_STATE_DIR:-${PI_PERSIST_DIR:-$HOME}/.tailscale}"
  TS_VERSION="${TS_VERSION:-1.98.4}"
  mkdir -p "$TS_BIN_DIR" "$TS_STATE_DIR"

  if [ ! -x "$TS_BIN_DIR/tailscaled" ]; then
    case "$(uname -m)" in
      x86_64) tsarch=amd64 ;; aarch64|arm64) tsarch=arm64 ;; *) tsarch=amd64 ;;
    esac
    pkg="tailscale_${TS_VERSION}_${tsarch}"
    log "downloading ${pkg} static binaries…"
    curl -fsSL "https://pkgs.tailscale.com/stable/${pkg}.tgz" \
      | tar -xz -C "$TS_BIN_DIR" --strip-components=1 "${pkg}/tailscale" "${pkg}/tailscaled"
  fi
  export PATH="$TS_BIN_DIR:$PATH"
  ts() { tailscale --socket="$TS_SOCK" "$@"; }

  if [ -z "${TS_AUTHKEY:-}" ] && [ -n "${TS_AUTHKEY_FILE:-}" ] && [ -f "$TS_AUTHKEY_FILE" ]; then
    TS_AUTHKEY="$(cat "$TS_AUTHKEY_FILE")"
  fi
  [ -z "${TS_AUTHKEY:-}" ] && log "WARN: no TS_AUTHKEY/_FILE — tailscale up will block on interactive login"

  log "starting tailscaled (userspace)…"
  "$TS_BIN_DIR/tailscaled" \
    --tun=userspace-networking --socket="$TS_SOCK" --statedir="$TS_STATE_DIR" \
    --socks5-server=localhost:1055 >"$HOME/tailscaled.log" 2>&1 &
  for _ in $(seq 1 60); do ts status >/dev/null 2>&1 && break; sleep 0.5; done

  TS_HOSTNAME="${TS_HOSTNAME:-pi-$(hostname | tr '[:upper:]' '[:lower:]')}"
  log "tailscale up as '${TS_HOSTNAME}' (SSH enabled)…"
  # shellcheck disable=SC2086
  ts up --ssh --hostname="$TS_HOSTNAME" --accept-routes=false \
    ${TS_AUTHKEY:+--authkey="$TS_AUTHKEY"} \
    ${TS_TAGS:+--advertise-tags="$TS_TAGS"} \
    ${TS_EXTRA_UP_ARGS:-}
  ts ip -4 2>/dev/null | sed 's/^/[start] tailnet IP: /' >&2 || true

  if [ "${TS_SERVE:-0}" = "1" ]; then
    log "tailscale serve: tcp ${BRIDGE_PORT:-8000} -> 127.0.0.1:${BRIDGE_PORT:-8000}"
    ts serve --bg --tcp "${BRIDGE_PORT:-8000}" "tcp://127.0.0.1:${BRIDGE_PORT:-8000}" \
      || log "WARN: tailscale serve failed (HTTPS certs enabled on the tailnet?)"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Node is pre-installed by the Node Engine buildpack
# ---------------------------------------------------------------------------
NODE_ENGINE_PATH="/layers/paketo-buildpacks_node-engine/node/bin"
if [ -x "$NODE_ENGINE_PATH/node" ]; then
  export PATH="$NODE_ENGINE_PATH:$PATH"
  log "node: $(command -v node) $(node --version 2>/dev/null)"
else
  log "WARN: node-engine layer not found at $NODE_ENGINE_PATH"
fi

# ---------------------------------------------------------------------------
# 3b. pi-web — browser UI for Pi Coding Agent (port 8001)
# ---------------------------------------------------------------------------
PI_WEB_DATA_DIR="${PI_WEB_DATA_DIR:-${PI_PERSIST_DIR:-$HOME}/pi-web}"
mkdir -p "$PI_WEB_DATA_DIR"

if ! command -v pi-web >/dev/null 2>&1; then
  log "installing pi-web globally…"
  npm install -g @jmfederico/pi-web --prefix "$PI_WEB_DATA_DIR" 2>&1 | tail -5
  log "pi-web installed"
fi
# Make pi-web binaries available
export PATH="$PI_WEB_DATA_DIR/bin:$PATH"
log "pi-web binaries: $(which pi-web-sessiond 2>/dev/null || echo 'not found')"

# Start session daemon (owns active Pi sessions, keeps them alive across browser disconnects)
log "starting pi-web session daemon…"
PI_WEB_SESSIOND_LOG="$PI_WEB_DATA_DIR/sessiond.log"
nohup pi-web-sessiond > "$PI_WEB_SESSIOND_LOG" 2>&1 &
PI_WEB_SESSIOND_PID=$!
sleep 2
if ! kill -0 "$PI_WEB_SESSIOND_PID" 2>/dev/null; then
  log "WARN: pi-web sessiond failed to start (logs: $PI_WEB_SESSIOND_LOG)"
else
  log "pi-web sessiond started (PID: $PI_WEB_SESSIOND_PID)"
fi

# Start pi-web web server (serves browser UI + API)
log "starting pi-web web server on port 8001…"
PI_WEB_SERVER_LOG="$PI_WEB_DATA_DIR/web.log"
export PI_WEB_PORT=8001
export PI_WEB_HOST=0.0.0.0
nohup pi-web-server > "$PI_WEB_SERVER_LOG" 2>&1 &
PI_WEB_SERVER_PID=$!
sleep 2
if ! kill -0 "$PI_WEB_SERVER_PID" 2>/dev/null; then
  log "WARN: pi-web server failed to start (logs: $PI_WEB_SERVER_LOG)"
else
  log "pi-web server started on port 8001 (PID: $PI_WEB_SERVER_PID)"
fi

# ---------------------------------------------------------------------------
# 4. pi-bridge — run from a WRITABLE copy (/workspace/source is read-only at runtime)
# ---------------------------------------------------------------------------
RUN_DIR="${BRIDGE_RUN_DIR:-${PI_PERSIST_DIR:-$HOME}/pi-bridge}"
mkdir -p "$RUN_DIR"
# Sync source in; an existing node_modules in RUN_DIR is preserved (cp won't delete it),
# so deps persist across restarts when RUN_DIR is on the workspace mount.
cp -R "$BRIDGE_DIR/." "$RUN_DIR/" 2>/dev/null || true
cd "$RUN_DIR"
[ -d node_modules ] || { log "installing bridge deps in $RUN_DIR…"; npm install; }
export PORT="${BRIDGE_PORT:-${PORT:-8000}}"
export HOST="${PI_BRIDGE_HOST:-0.0.0.0}"
# New sessions (POST /api/sessions) are created in the project dir, not the bridge run dir.
export PI_SESSION_CWD="${PI_SESSION_CWD:-${PI_PERSIST_DIR:-$RUN_DIR}}"
log "starting pi-bridge on ${HOST}:${PORT} (cwd $RUN_DIR, sessions in $PI_SESSION_CWD)"
exec node --import tsx src/server.ts
