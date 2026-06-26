# pi-web in a Renku 2.0 session (custom image)

Shortest path to getting the **forked, base-path-patched [pi-web](https://github.com/jmfederico/pi-web)**
serving inside a Renkulab session. This deliberately ignores the pi-bridge / buildpack / Tailscale
work — it's a standalone custom session image. Renku's gateway provides TLS + auth + the
`RENKU_BASE_URL_PATH` proxy; the image just serves the app under that prefix.

## What's here

| File | Role |
|------|------|
| `Dockerfile` | Clones the pinned upstream commit, applies `../renku-base-path.patch`, builds, packages. |
| `entrypoint.sh` | Starts `sessiond` + the web server on the session port under the base path. |
| `../renku-base-path.patch` | The base-path retrofit (REST/WS/asset URLs + server prefix mount). |

## Build & push

Build context is the **repo root** (so the patch and `pi/` skeleton are in scope):

```bash
cd /home/wjdj/repos/sdsc/my-opencode-buildpack-project
docker build -f pi-web-renku/Dockerfile -t harbor.renkulab.io/apps-demo/pi-web-renku:slim .
docker push harbor.renkulab.io/apps-demo/pi-web-renku:slim
```

Multi-stage: a `node:22-bookworm` build stage compiles node-pty + runs `npm run build`, then a
`node:22-bookworm-slim` runtime stage carries only `dist/`, a production-pruned `node_modules`, the
pi skeleton, and the entrypoint. Result: **~710 MB** (vs ~2.1 GB single-stage).

> Note: `@earendil-works/*` (the pi SDK) are dev/peer deps in the fork but required at runtime, so
> the build promotes them to dependencies before `npm prune --omit=dev` — otherwise the agent and
> its provider SDKs get pruned away. The fat single-stage variant is kept in git history if needed.

## Run as a Renku 2.0 session

1. In Renku, create a **Session Launcher → custom image**, set the image to `<registry>/pi-web-renku:dev`.
2. Set the launcher **port to `8080`** (matches `PI_WEB_PORT` / `EXPOSE`).
3. Launch. Renku injects `RENKU_BASE_URL_PATH` and proxies the session under it; the patched app
   resolves all REST/WS/asset URLs against that prefix.

## Verified (built image, run as a container)

Confirmed against `pi-web-renku:dev` with `RENKU_BASE_URL_PATH=/sessions/demo/`:

```
GET  /sessions/demo/                            -> 200, <base href="/sessions/demo/">, relative ./assets
GET  /sessions/demo/api/config                  -> 200   (REST mounted under the prefix)
GET  /sessions/demo/assets/index-*.js           -> 200   (assets resolve under the prefix)
WS   /sessions/demo/api/machines/local/events   -> 101   (WebSocket upgrades under the prefix)
GET  /                                           -> 404   (correctly not served at root)
config seeding                                   -> ~/.pi/agent/models.json, key injected, mode 0600
arbitrary non-root UID (1234567:0)               -> 200   (HOME falls back to /tmp/pi-web-home)
```

## Provide the model key in Renku

The entrypoint seeds `~/.pi/agent` from the baked skeleton and injects the SDSC vLLM key from
either `SDSC_API_KEY` or `SDSC_API_KEY_FILE` (a mounted Renku User Secret). Without it the UI still
loads but model calls 401. Set one of those in the session launcher / secrets.

## Remaining caveats

- **WebSocket through a *real* Renku gateway is unconfirmed.** The app side is proven (101 upgrade
  under the prefix); only the live gateway's WS proxying remains to verify in an actual session.
- **Fork tax.** This pins an upstream commit (`PIWEB_REF`), so rebasing the patch onto newer
  pi-web is the recurring cost flagged in the assessment. ~710 MB is mostly the pi SDK
  (`@earendil-works/*` ~178 MB) + provider SDKs + node-pty — all required runtime deps.
