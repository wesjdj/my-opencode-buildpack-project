#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# CNB exec.d script — runs at session launch, before the main process.
#
# The init-scripts buildpack copies this to <layer>/exec.d/. At launch the
# CNB lifecycle executes it and reads env-var definitions from fd 3 as TOML
# (key="value" pairs). Those vars are then set for the main process (and
# inherited by every terminal the frontend spawns).
#
# What it does:
#   1. Downloads the opencode CLI if not already cached on disk.
#   2. Prepends it to PATH via fd 3.
#   3. Reads Renku User Secrets from /secrets and exports API keys via fd 3.
#   4. Stages any opencode config/auth files from the secrets mount.
# ---------------------------------------------------------------------------

INSTALL_DIR="${HOME}/.local/bin"
mkdir -p "${INSTALL_DIR}"

# --- 1. Install opencode binary (cached across session restarts) -----------

if [ ! -x "${INSTALL_DIR}/opencode" ]; then
  arch="$(uname -m)"
  case "${arch}" in
    x86_64)  arch="x64" ;;
    aarch64) arch="arm64" ;;
  esac

  target="linux-${arch}"
  if [ "${arch}" = "x64" ] && ! grep -qwi avx2 /proc/cpuinfo 2>/dev/null; then
    target="${target}-baseline"
  fi

  filename="opencode-${target}.tar.gz"
  url="https://github.com/sst/opencode/releases/latest/download/${filename}"

  echo "Installing opencode (${target})..." >&2
  tmp_dir="$(mktemp -d)"
  curl -fsSL "${url}" -o "${tmp_dir}/${filename}"
  tar -xzf "${tmp_dir}/${filename}" -C "${tmp_dir}"

  if [ ! -f "${tmp_dir}/opencode" ]; then
    echo "ERROR: opencode binary not found after extraction" >&2
    rm -rf "${tmp_dir}"
    exit 0
  fi

  install -m 0755 "${tmp_dir}/opencode" "${INSTALL_DIR}/opencode"
  rm -rf "${tmp_dir}"
  echo "opencode installed to ${INSTALL_DIR}/opencode" >&2
else
  echo "opencode already installed at ${INSTALL_DIR}/opencode" >&2
fi

# --- 2. Set PATH via fd 3 (TOML format) -----------------------------------

echo "PATH=\"${INSTALL_DIR}:${PATH}\"" >&3

# --- 3. Wire Renku User Secrets into env vars -----------------------------

secrets_dir="${RENKU_OPENCODE_SECRETS_DIR:-/secrets}"

if [ -d "${secrets_dir}" ]; then
  for pair in \
    "ANTHROPIC_API_KEY:ANTHROPIC_API_KEY" \
    "anthropic-api-key:ANTHROPIC_API_KEY" \
    "OPENAI_API_KEY:OPENAI_API_KEY" \
    "openai-api-key:OPENAI_API_KEY" \
    "OPENROUTER_API_KEY:OPENROUTER_API_KEY" \
    "openrouter-api-key:OPENROUTER_API_KEY" \
    "GROQ_API_KEY:GROQ_API_KEY" \
    "groq-api-key:GROQ_API_KEY" \
    "GOOGLE_GENERATIVE_AI_API_KEY:GOOGLE_GENERATIVE_AI_API_KEY" \
    "google-generative-ai-api-key:GOOGLE_GENERATIVE_AI_API_KEY" \
    "GEMINI_API_KEY:GEMINI_API_KEY" \
    "gemini-api-key:GEMINI_API_KEY" \
    "DEEPSEEK_API_KEY:DEEPSEEK_API_KEY" \
    "deepseek-api-key:DEEPSEEK_API_KEY" \
    "AWS_ACCESS_KEY_ID:AWS_ACCESS_KEY_ID" \
    "AWS_SECRET_ACCESS_KEY:AWS_SECRET_ACCESS_KEY" \
    "AWS_SESSION_TOKEN:AWS_SESSION_TOKEN"
  do
    file="${pair%%:*}"
    var="${pair##*:}"
    if [ -z "${!var-}" ] && [ -s "${secrets_dir}/${file}" ]; then
      val="$(tr -d '\r\n' < "${secrets_dir}/${file}")"
      val="${val//\\/\\\\}"
      val="${val//\"/\\\"}"
      echo "${var}=\"${val}\"" >&3
    fi
  done

  # --- 4. Stage opencode config/auth files --------------------------------

  config_dir="${XDG_CONFIG_HOME:-${HOME}/.config}/opencode"
  data_dir="${XDG_DATA_HOME:-${HOME}/.local/share}/opencode"
  mkdir -p "${config_dir}" "${data_dir}" 2>/dev/null || true

  for src in "opencode.json" "opencode.jsonc" "config.json"; do
    if [ -s "${secrets_dir}/${src}" ] && [ ! -e "${config_dir}/opencode.json" ] && [ ! -e "${config_dir}/opencode.jsonc" ]; then
      dest="${config_dir}/opencode.json"
      [ "${src##*.}" = "jsonc" ] && dest="${config_dir}/opencode.jsonc"
      cp "${secrets_dir}/${src}" "${dest}"
      chmod 0600 "${dest}"
      break
    fi
  done

  if [ -s "${secrets_dir}/auth.json" ] && [ ! -e "${data_dir}/auth.json" ]; then
    cp "${secrets_dir}/auth.json" "${data_dir}/auth.json"
    chmod 0600 "${data_dir}/auth.json"
  fi
fi
