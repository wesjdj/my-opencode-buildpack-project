#!/usr/bin/env bash
# Launch pi-web inside a Renku 2.0 session: sessiond (agent runtimes) + web server, listening on
# the session port and honoring the RENKU_BASE_URL_PATH proxy prefix (handled by the patch).
set -euo pipefail
cd /app

# Renku may run us as an arbitrary UID whose $HOME isn't writable; fall back to /tmp.
if [ -z "${HOME:-}" ] || ! { mkdir -p "$HOME/.pi-web" 2>/dev/null && [ -w "$HOME/.pi-web" ]; }; then
  export HOME=/tmp/pi-web-home
fi
export PI_WEB_DATA_DIR="${PI_WEB_DATA_DIR:-$HOME/.pi-web}"
mkdir -p "$PI_WEB_DATA_DIR"

export PI_WEB_HOST="${PI_WEB_HOST:-0.0.0.0}"
# Prefer an explicit PI_WEB_PORT; else the Renku-injected session port; else the image default.
export PI_WEB_PORT="${PI_WEB_PORT:-${RENKU_SESSION_PORT:-8080}}"
export PI_WEB_SESSIOND_SOCKET="${PI_WEB_SESSIOND_SOCKET:-$PI_WEB_DATA_DIR/sessiond.sock}"

echo "[pi-web] base='${RENKU_BASE_URL_PATH:-/}' host=$PI_WEB_HOST port=$PI_WEB_PORT data=$PI_WEB_DATA_DIR" >&2

# Scope pi-web's file browser / @-mention explorer to the work volume. NOTE: this only limits the
# file picker, not the agent's tool execution — pi-web runs the agent autonomously and the session
# container is the real sandbox.
export PI_WEB_CONFIG="${PI_WEB_CONFIG:-$PI_WEB_DATA_DIR/pi-web-config.json}"
WORK_DIR="${RENKU_MOUNT_DIR:-/app/work}"
if [ ! -f "$PI_WEB_CONFIG" ]; then
  printf '{ "pathAccess": { "allowedPaths": ["%s"] } }\n' "$WORK_DIR" > "$PI_WEB_CONFIG"
fi

# --- pi agent config: seed ~/.pi/agent from the baked skeleton, inject the SDSC vLLM key -------
# pi-web embeds the pi-coding-agent SDK, which reads model/provider config from ~/.pi/agent
# (same as the bridge). Mirror the bridge's start.sh seeding so the agent has models on launch.
PI_SKEL="${PI_SKEL:-/opt/pi-skel}"
PI_AGENT_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
if [ -d "$PI_SKEL" ]; then
  mkdir -p "$PI_AGENT_DIR"
  # settings.json is managed config — always refresh from the skeleton. (pi-permission-system is
  # intentionally NOT loaded: pi-web has no interactive-approval UI to surface its prompts.)
  cp "$PI_SKEL/settings.json" "$PI_AGENT_DIR/settings.json"

  # Resolve the key from env, else a mounted secret file. Defaults to the Renku User Secret path
  # (mount the secret there and no launcher env var is needed); override with SDSC_API_KEY_FILE.
  SDSC_API_KEY_FILE="${SDSC_API_KEY_FILE:-/secrets/sdsc-vllm-api-key.txt}"
  if [ -z "${SDSC_API_KEY:-}" ] && [ -f "$SDSC_API_KEY_FILE" ]; then
    SDSC_API_KEY="$(tr -d '\r\n' < "$SDSC_API_KEY_FILE")"
  fi
  if [ -n "${SDSC_API_KEY:-}" ]; then
    # Inject via env (not sed argv) so the key never appears in /proc/<pid>/cmdline.
    SDSC_API_KEY="$SDSC_API_KEY" node -e '
      const fs = require("fs");
      const out = fs.readFileSync(process.argv[1], "utf8").replaceAll("__SDSC_API_KEY__", process.env.SDSC_API_KEY);
      fs.writeFileSync(process.argv[2], out, { mode: 0o600 });
    ' "$PI_SKEL/models.json" "$PI_AGENT_DIR/models.json"
    echo "[pi-web] seeded ~/.pi/agent (sdsc models.json with injected key)" >&2
  else
    cp "$PI_SKEL/models.json" "$PI_AGENT_DIR/models.json"
    echo "[pi-web] WARN: no SDSC_API_KEY/_FILE — models.json keeps its placeholder (model calls will 401)" >&2
  fi
else
  echo "[pi-web] WARN: no pi skeleton at $PI_SKEL — agent has no model config" >&2
fi

# --- optional: clone a git repo into the Renku mount dir ----------------------------------------
# Renku doesn't auto-clone repos into bring-your-own images (the git-proxy sidecar only provides
# auth). Set CLONE_REPO=<git-url> in the launcher to clone it once into RENKU_MOUNT_DIR (/app/work),
# which is also where pi-web should open the project. For private repos / push, set GIT_PROXY_PORT
# (Renku's git-proxy, typically 65480) so git auth is routed through it.
if [ -n "${CLONE_REPO:-}" ] && command -v git >/dev/null 2>&1; then
  if [ -n "${GIT_PROXY_PORT:-}" ]; then
    git config --global http.proxy "http://localhost:${GIT_PROXY_PORT}"
    git config --global https.proxy "http://localhost:${GIT_PROXY_PORT}"
  fi
  repo_name="$(basename "${CLONE_REPO%.git}")"
  if [ ! -e "$WORK_DIR/$repo_name" ]; then
    mkdir -p "$WORK_DIR"
    echo "[pi-web] cloning $CLONE_REPO -> $WORK_DIR/$repo_name" >&2
    git clone "$CLONE_REPO" "$WORK_DIR/$repo_name" 2>&1 | sed 's/^/[pi-web] git: /' >&2 \
      || echo "[pi-web] WARN: clone failed (private repo without GIT_PROXY_PORT?)" >&2
  else
    echo "[pi-web] repo already present at $WORK_DIR/$repo_name" >&2
  fi
fi

# Run the server with the image's Node 22 explicitly. pi-coding-agent's bundled undici needs
# Node >= 22 (markAsUncloneable); the baked Nix toolset can put an older `node` on PATH, so we
# must not let PATH resolution pick it for the server.
NODE_BIN=/usr/local/bin/node

# Session daemon owns agent runtimes; the web server proxies to it over the unix socket.
"$NODE_BIN" dist/server/sessiond.js &
SESSIOND_PID=$!
trap 'kill "$SESSIOND_PID" 2>/dev/null || true' EXIT INT TERM

# Give the daemon a moment to bind its socket so the first request doesn't race it.
for _ in $(seq 1 40); do [ -S "$PI_WEB_SESSIOND_SOCKET" ] && break; sleep 0.25; done

exec "$NODE_BIN" dist/server/index.js
