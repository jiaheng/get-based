# Deployment

getbased is deployed on Vercel. The app is static — no server-side code, no API routes, no backend. Vercel serves the files directly and injects security headers.

## Vercel configuration

`vercel.json` uses the legacy `routes` array (not `rewrites` or `headers`):

```json
{
  "routes": [
    {
      "src": "/(.*)",
      "headers": { "...CSP and security headers..." },
      "continue": true
    },
    { "src": "^/guide/(.*)", "status": 301, "headers": { "Location": "/docs/guide/$1" } },
    { "src": "^/docs(?:/.*)?$", "status": 301, "headers": { "Location": "https://docs.getbased.health/" } },
    { "src": "^/app/?$", "dest": "/index.html" }
  ]
}
```

| Route | Destination |
|---|---|
| `/` | `index.html` — the application (served by Vercel filesystem default) |
| `/app` | `index.html` — explicit app alias |
| `/docs` and `/docs/*` | 301 redirect to Mintlify at `https://docs.getbased.health/` |
| Everything else | Served as-is from the filesystem (JS, CSS, images, manifest) |

## Domain layout

The app and landing page are deployed as two separate Vercel projects on the same domain:

| Subdomain | Vercel project | Repo |
|---|---|---|
| `getbased.health` | `get-based-site` | [elkimek/get-based-site](https://github.com/elkimek/get-based-site) |
| `app.getbased.health` | `get-based` | [elkimek/get-based](https://github.com/elkimek/get-based) |

DNS (Namecheap): A record `@` → `76.76.21.21` (Vercel), CNAME `app` → `cname.vercel-dns.com`, CNAME `www` → `cname.vercel-dns.com`.

The landing page is self-contained (all CSS/JS inline) and depends only on three icon files. CTA links point to `https://app.getbased.health`. A small inline script rewrites these to `/app` on `localhost` for local development.

### Local dev server

`node dev-server.js` mirrors the production layout. If the site repo is cloned as a sibling (`../get-based-site`), the server routes:

| Path | Destination |
|---|---|
| `/` | Landing page from `../get-based-site/index.html` |
| `/app` | App from `index.html` |
| `/docs/*` | 301 redirect to `https://docs.getbased.health/` |

Without the sibling repo, `/` serves the app directly. Override the site path with `SITE_DIR=/path/to/site node dev-server.js`.

## Docker runtime

The Docker image runs `npm start`, which launches `dev-server.js` with `HOST=0.0.0.0` and `PORT=8000` from the `Dockerfile`. Static responses served by `dev-server.js` read the production header route from `vercel.json`, so Vercel and Docker share the same source of truth for CSP and security headers.

When changing the production header policy:

1. Update the first `/(.*)` header route in `vercel.json`.
2. Keep this document's CSP summary in sync.
3. Run the Docker/header smoke check against a running container or local server:

```sh
npm run smoke:docker-headers -- http://127.0.0.1:8000/
```

The smoke check fails if `/` does not return `Content-Security-Policy` or if the policy is missing `default-src 'self'`, `frame-src 'none'`, `object-src 'none'`, or `base-uri 'self'`.

## CSP headers

The Content-Security-Policy in `vercel.json` allows exactly what the app needs, and `dev-server.js` applies the same value for Docker-served static files:

```
default-src 'self'
script-src  'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:
            https://umami-iota-olive.vercel.app
            https://cdn.jsdelivr.net
style-src   'self' 'unsafe-inline'
font-src    'self'
connect-src 'self' https: wss:
            http://localhost:*
            http://127.0.0.1:*
            ws://localhost:*
            ws://*.onion
            http://*.onion
img-src     'self' data: blob:
worker-src  'self' blob:
manifest-src 'self'
frame-src   'none'
object-src  'none'
base-uri    'self'
```

`'unsafe-inline'` is required for scripts because `index.html` has inline `onclick` attributes (by design — the architecture relies on window-exported functions called from HTML). `blob:` and `'wasm-unsafe-eval'` support browser-side model/runtime workers.

All JS libraries and fonts should stay bundled locally in `vendor/` unless the `vercel.json` CSP is deliberately updated. `https://cdn.jsdelivr.net` is currently allowed for the transformers/ONNX runtime path. Run `./update-vendor.sh` to re-download vendored dependencies when bumping versions.

`localhost:*`, `127.0.0.1:*`, `ws://localhost:*`, and onion endpoints in `connect-src` support local/self-hosted AI and decentralized nodes. LAN IPs (e.g. `192.168.x.x`) are not supported from the hosted HTTPS app due to browser mixed-content blocking — this is a browser security fundamental, not a CSP limitation.

If a new AI provider or external asset host is added, update `vercel.json` first, then verify Docker with the smoke command above.

## Service worker

The service worker (`service-worker.js`) manages PWA caching. The cache name includes a version number:

```js
const CACHE_NAME = 'labcharts-v55';
```

**When to bump the version:** Any time you change an app file — JS, CSS, HTML, manifest, images. Incrementing the version busts the cache for existing users, who will download fresh files on next visit.

The service worker uses three caching strategies:

| Resource type | Strategy |
|---|---|
| AI API calls (OpenRouter, Routstr, PPQ, Venice, Local AI) | **Bypass** — `return` without `event.respondWith`. Streaming ReadableStreams must go directly to the page without SW IPC buffering |
| App shell (HTML, CSS, JS, vendor libs, fonts, images) | **Stale-while-revalidate** — serve cached, update in background |

The API bypass is critical for streaming. If the service worker intercepts a streaming SSE response, the IPC pipe between the SW and the page buffers the chunks, breaking the streaming experience. The bypass (returning without calling `event.respondWith`) routes requests directly to the network. Local/private hosts are bypassed only when they are cross-origin, so same-origin app-shell requests can still be cached. Normal localhost development unregisters the SW to avoid stale module caches; use `/app?dev-sw=1` for an explicit local offline smoke test.

## PWA manifest

`manifest.json` makes the app installable as a native app on desktop and mobile:

```json
{
  "name": "getbased",
  "short_name": "getbased",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#0f1117",
  "theme_color": "#0f1117",
  "icons": [
    { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/icon.svg",     "sizes": "any",     "type": "image/svg+xml" }
  ]
}
```

## Vendor dependencies

Chart.js, pdf.js, and Google Fonts are bundled locally in `vendor/`. To update:

1. Edit the version pins at the top of `update-vendor.sh`
2. Run `./update-vendor.sh`
3. Bump `version.js` to bust the SW cache
4. Commit the updated `vendor/` directory
