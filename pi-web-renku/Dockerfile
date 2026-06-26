# pi-web (jmfederico/pi-web) + Renku base-path patch, packaged as a Renku 2.0 custom session image.
#
# Multi-stage: a full build stage (toolchain + dev deps) produces dist/ + a compiled node-pty and a
# pruned production node_modules; a slim runtime stage carries only what's needed to serve. Renku
# launches the image and the gateway provides TLS + auth + the RENKU_BASE_URL_PATH proxy in front.
#
# Build context MUST be the repo root so renku-base-path.patch and pi/ are in scope:
#   docker build -f pi-web-renku/Dockerfile -t <registry>/pi-web-renku:dev .

# ---- Stage 1: build ---------------------------------------------------------------------------
# node:22-bookworm => glibc + Node 22 (N-API/ABI 127). node-pty ships no linux prebuild, so it
# compiles here via node-gyp (python3/make/g++).
FROM node:22-bookworm AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pin the exact upstream commit the patch was authored against, then apply it.
ARG PIWEB_REF=deb4f9feca15394a601ea1e1a344e34c9921793f
RUN git clone https://github.com/jmfederico/pi-web.git . \
 && git checkout "$PIWEB_REF"
COPY renku-base-path.patch /tmp/renku-base-path.patch
RUN git apply --verbose /tmp/renku-base-path.patch

# Full install (compiles node-pty) + build (compiled server/sessiond + vite client bundle).
RUN npm install --no-audit --no-fund \
 && npm run build

# Slim node_modules to the production closure. @earendil-works/* (the pi SDK) are dev/peer deps in
# the fork but REQUIRED at runtime, so promote them to dependencies before pruning — otherwise
# `npm prune --omit=dev` drops the agent and its provider-SDK subtree. Then remove node-pty's
# darwin/win32 prebuilds (Linux loads the compiled build/Release/pty.node).
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.dependencies=p.dependencies||{};for(const k of Object.keys(p.devDependencies||{}))if(k.startsWith('@earendil-works/')){p.dependencies[k]=p.devDependencies[k];delete p.devDependencies[k];}fs.writeFileSync('package.json',JSON.stringify(p,null,2));" \
 && npm prune --omit=dev \
 && rm -rf node_modules/node-pty/prebuilds

# ---- Stage 1b: Nix-built CLI tools ------------------------------------------------------------
# Bakes the user's homelab home-common.nix toolset (core CLIs + neovim's extraPackages LSP stack)
# plus terraform, pinned to that flake.lock's nixpkgs rev so versions match their machines. Only the
# tool closure is copied to the runtime (not Nix itself) and put on PATH — read-only, no runtime Nix
# daemon, works fine as the non-root session user. allowUnfree: terraform is BUSL (unfree).
# ignoreCollisions: a large mixed env (multiple LSPs/node tools) can ship overlapping files.
FROM nixos/nix:latest AS nixtools
ARG NIXPKGS_REV=a4bf06618f0b5ee50f14ed8f0da77d34ecc19160
RUN printf 'experimental-features = nix-command flakes\n' >> /etc/nix/nix.conf
RUN OUT=$(nix build --impure --no-link --print-out-paths --expr \
      "let pkgs = import (builtins.fetchTarball \"https://github.com/NixOS/nixpkgs/archive/${NIXPKGS_REV}.tar.gz\") { config.allowUnfree = true; }; \
       in pkgs.buildEnv { name = \"pi-session-tools\"; ignoreCollisions = true; paths = with pkgs; [ \
         fd ripgrep jq glow bat fzf zoxide lazygit htop tealdeer git neovim \
         gcc \
         lua-language-server pyright ruff gopls rust-analyzer \
         nodePackages.typescript-language-server vscode-langservers-extracted nil terraform-ls \
         nodePackages.bash-language-server nodePackages.vim-language-server templ zls \
         terraform ]; }") \
 && mkdir -p /closure/nix/store \
 && for p in $(nix-store --query --requisites "$OUT"); do cp -a "$p" /closure/nix/store/; done \
 && ln -s "$OUT" /closure/profile

# ---- Stage 2: runtime -------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

# git is needed at runtime for cloning repos, pi-web's git features, and the coding agent.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json

# Core CLI tools from the user's Nix config (nixtools stage) — on PATH for the terminal + agent.
COPY --from=nixtools /closure/nix/store /nix/store
COPY --from=nixtools /closure/profile /opt/pi-tools
ENV PATH=/opt/pi-tools/bin:$PATH

# Bake the pi agent config skeleton (settings/models/permissions) so the entrypoint can seed
# ~/.pi/agent at launch and inject the SDSC vLLM key. World-readable; never contains a secret.
COPY pi/ /opt/pi-skel/

COPY pi-web-renku/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
 # Renku/Amalthea may run the container as an arbitrary UID with gid 0. Make the app tree
 # group-writable so data dirs under it stay writable regardless of the runtime UID.
 && chgrp -R 0 /app && chmod -R g=u /app \
 # Renku sets the session working dir + HOME to /home/<project-slug> and runs non-root, but that
 # path isn't writable in a custom image. Make /home sticky-writable (like /tmp) so the session
 # user can create its own home/project dir there — fixes EACCES mkdir '/home/<slug>'.
 && chmod 1777 /home

ENV PI_WEB_HOST=0.0.0.0 \
    PI_WEB_PORT=8080 \
    NODE_ENV=production
EXPOSE 8080

ENTRYPOINT ["bash", "/usr/local/bin/entrypoint.sh"]
