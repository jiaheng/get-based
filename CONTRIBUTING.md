# Contributing to getbased

Thanks for wanting to help. Here's everything you need to know.

---

## Prerequisites

- A modern browser (Chrome or Firefox recommended)
- Node.js for the local dev server and headless test suite
- An AI provider API key or local Ollama instance (optional — only needed for PDF import and chat features)
- Puppeteer if you want to run the headless test suite (`npm i -g puppeteer`)

---

## Running locally

```bash
git clone https://github.com/elkimek/get-based
cd get-based
node dev-server.js
```

Open `http://localhost:8000`. That's it — no install step, no build step.

---

## Architecture overview

getbased has no build system. It's 42 native ES modules under `js/`, loaded via `<script type="module" src="js/main.js">` in `index.html`. There's nothing to compile.

```
index.html        — HTML structure, script/CSS includes
styles.css        — all CSS, dark/light themes, 10 responsive breakpoints
js/
  main.js         — DOMContentLoaded init, event listeners, entry point
  schema.js       — MARKER_SCHEMA, reference ranges, unit conversions
  state.js        — single shared mutable state object
  api.js          — AI provider routing, all 6 providers, model management
  views.js        — dashboard, category views, modals, navigation
  data.js         — getActiveData() pipeline, unit conversion, storage
  ... (36 more modules — see CLAUDE.md for full list)
service-worker.js — PWA cache, API bypass strategies
manifest.json     — PWA manifest
```

The full architecture — data flow, module dependencies, storage keys, AI pipeline, every feature — is documented in [CLAUDE.md](CLAUDE.md). Read it before making non-trivial changes.

---

## Code patterns to follow

**HTML onclick handlers** — functions called from inline `onclick` attributes must be exposed on `window`. Each module does this at the bottom:

```js
Object.assign(window, { myFunction, anotherFunction });
```

**Cross-module calls** — use normal `import` when possible. Use `window.fn()` when a direct import would create a circular dependency (e.g., `views.js` calling a function from `data.js` that also imports from `views.js`):

```js
// normal — use imports for direct dependencies
import { showNotification } from './utils.js';

// circular dep breaker — call via window
window.refreshDashboard();
```

**HTML interpolation** — always use `escapeHTML()` when inserting user-controlled or data-derived strings into innerHTML:

```js
el.innerHTML = `<span>${escapeHTML(markerName)}</span>`;
```

There is no linter. Just follow the patterns you see in the existing code.

---

## Tests

Test files live in `tests/test-*.js` — a mix of Puppeteer-driven browser tests and a few node-side ones. Browser tests are self-executing IIFEs that run assertions against the live DOM, source code, CSS, and behavior. They don't use a test framework — just a small `assert(name, condition, detail)` helper pattern. Run `ls tests/test-*.js | wc -l` for the current count.

Run all headlessly:

```bash
./run-tests.sh
```

This auto-starts a server on port 8000 if needed, runs each file through headless Chrome via Puppeteer, and prints pass/fail per file. Exit code 0 = all pass.

If you add a feature or fix a bug, add assertions to the relevant test file (or create a new `test-yourfeature.js`). Cover what you changed — source inspection, DOM state, function behavior, CSS rules, whatever applies.

---

## Pull request guidelines

- Keep PRs focused. One thing at a time is easier to review.
- Test your changes with `./run-tests.sh` before opening a PR.
- If you touch any app files (JS, CSS, HTML, manifest), bump the version in `version.js`. This busts the service worker cache for existing users.
- Update `CLAUDE.md` if you change architecture, add a module, or change how something works at a system level.

---

## Where to look for things

- **CLAUDE.md** — comprehensive architecture reference. Start here for any non-trivial change.
- `js/schema.js` — all biomarker definitions, reference ranges, units
- `js/api.js` — AI provider routing and model management
- `js/views.js` — all dashboard and category rendering
- `js/data.js` — `getActiveData()`, the central data pipeline
- `js/context-cards.js` — the 9 lifestyle context card editors and health dots

---

## Roadmap

Check the [project board](https://github.com/users/elkimek/projects/2) for planned features and ideas. If something interests you, comment on the issue to discuss the approach before starting work.

## Reporting bugs

Open a GitHub issue or use the feedback button in the app (flag icon in the header). Include browser, OS, and steps to reproduce.
