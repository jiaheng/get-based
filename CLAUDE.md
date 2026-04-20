# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

getbased is a blood work dashboard for tracking biomarker trends over time. It visualizes lab results across 17 standard categories (biochemistry, hormones, lipids, hematology, body composition, bone density, etc.) with Chart.js line charts, data tables, and a correlation viewer. The app starts empty and is fully data-driven — users load their data via AI-powered PDF import (any lab report) or JSON files. Specialty labs (OAT, fatty acids, etc.) flow through the custom marker pipeline — each user gets their own lab's stated reference ranges from their PDF. Fatty acid tests are grouped by product/lab (Spadia, ZinZino, OmegaQuant) under a "Fatty Acids" sidebar group.

Uses AI APIs (PPQ, Routstr, OpenRouter, Venice, or Local AI) for AI-powered PDF import and an AI chat panel for interpreting results.

## Architecture

Web app (PWA) only: no build system, no bundler, no package manager — native ES modules (`<script type="module">`). The Electron shell was retired in v1.21.0; users who want hardware-accelerated RAG self-host any server that speaks the *External server* lens protocol (`POST /query` with bearer auth, see `docs/guide/interpretive-lens.md`).

- **`BRAND.md`** — brand manual (name rules, colors, typography, voice). Brand name is always `getbased` — lowercase, no space
- **`index.html`** — HTML structure only (header, sidebar, modals with `role="dialog"`, chat panel, script/CSS includes)
- **`styles.css`** — all CSS (dark/light themes, responsive layout with 10 breakpoints, touch/hover media queries)
- **`js/`** — 50 ES modules loaded via `js/main.js`:
  - `schema.js` — `MARKER_SCHEMA`, `SPECIALTY_MARKER_DEFS` (re-exported from adapters.js), `UNIT_CONVERSIONS`, `OPTIMAL_RANGES`, `PHASE_RANGES`, `CHIP_COLORS`, `MODEL_PRICING`, `SBM_2015_THRESHOLDS`, `getEMFSeverity`, `trackUsage`, `getProfileUsage`, `getGlobalUsage`
  - `adapters.js` — parser adapter registry for specialty labs. `ADAPTER_MARKERS` (217 entries), `detectProduct`, `normalizeWithAdapter`, `getAdapterByTestType`. Adapters: fattyAcids (29 markers, product detection), metabolomix (FA routing), oat (165 markers), biostarks (23 markers — amino acids, serum FA, intracellular minerals, cortisol, T/C ratio, vitamin E)
  - `constants.js` — option arrays, `CHAT_PERSONALITIES`, `CHAT_SYSTEM_PROMPT`, fake data, `COUNTRY_LATITUDES`, `EMF_ROOM_PRESETS`, `EMF_SOURCES`, `EMF_MITIGATIONS`
  - `state.js` — single mutable `state` object (importedData, unitSystem, profileSex, etc.)
  - `utils.js` — `escapeHTML`, `hashString`, `getStatus`, `formatValue`, `showNotification`, `showConfirmDialog`, `linearRegression`
  - `theme.js` — theme get/set/toggle, `getChartColors`, time format functions
  - `hardware.js` — GPU detection (WebGL renderer → GPU_DB), `detectHardware`, `assessModel` (fits/tight/toobig/cloud), `getModelSuggestions`, VRAM override. Ollama Cloud `:cloud` models recognized (no VRAM needed)
  - `image-utils.js` — `resizeImage`, `formatImageBlock`, `buildVisionContent`, `isValidImageType` (no app imports)
  - `api.js` — all 5 AI providers + `callClaudeAPI` router, `callOpenAICompatibleAPI` shared helper, key/model management, dynamic model lists, OpenRouter OAuth PKCE, `isRecommendedModel()` tiering, `getActiveModelId/Display()` helpers, `supportsVision()`, `isAIPaused()`/`setAIPaused()` global AI toggle, Venice E2EE branch (`isE2EEModel`, `isVeniceE2EEActive`)
  - `profile.js` — profile CRUD, sex/DOB/location/height, `migrateProfileData`, `migrateProfiles`, `updateProfileMeta`, `getAllTags`, `touchProfileTimestamp`
  - `data.js` — `getActiveData`, unit conversion, date range filtering, `saveImportedData`, `buildMarkerReference`
  - `pii.js` — regex + local AI PII obfuscation (Ollama & OpenAI-compatible), streaming sanitizer, diff viewer
  - `charts.js` — Chart.js plugins (4), `createLineChart`, `destroyAllCharts`
  - `crypto.js` — AES-256-GCM encryption at rest (PBKDF2), cross-tab sync (BroadcastChannel)
  - `backup.js` — backup/restore, IndexedDB auto-backup, folder backup (extracted from crypto.js)
  - `notes.js` — note editor (open/save/delete)
  - `supplements.js` — supplement editor + render section + ingredient tracking (manual, label scan, URL fetch) + impact analysis (`computeSupplementImpact`, `computeAllImpacts`, `renderSupplementImpact`) + mitochondrial warnings
  - `supplement-warnings.js` — mitochondrial compound warnings for supplements (108 entries, PubMed-cited)
  - `food-contaminants.js` — diet card pesticide/plastic contaminant scanner (EWG Dirty Dozen, PlasticList)
  - `recommendations.js` — lazy-loaded catalog, slot matching, product rendering for supplement & lifestyle recs (3 touchpoints: detail modal, chat, context cards). `buildDNAHints(slotKey)` connects genetics to recs via `snpHints` in snp-health.json
  - `cycle.js` — menstrual cycle helpers + editor + render section
  - `context-cards.js` — 9 context card editors, shared helpers, summaries, health dots, interpretive lens, `recordChange()` for change history
  - `emf.js` — Baubiologie EMF assessment editor, room CRUD, SBM-2015 severity, PDF import for consultant reports
  - `pdf-import.js` — PDF pipeline, batch import, import preview (with per-row exclude), import FAB, auto image mode for scanned PDFs, direct image import (JPG/PNG/WebP). AI detects test type and uses prefixed categories for specialty labs
  - `export.js` — JSON export/import (single-profile, per-client, full database bundle), PDF report, `clearAllData`, `buildAllDataBundle`
  - `chat.js` — chat panel, streaming, personalities, per-marker AI, image attachments, web search hints
  - `lab-context.js` — `buildLabContext`, AI context assembly, memoization (extracted from chat.js)
  - `markdown.js` — `applyInlineMarkdown`, `renderMarkdown` (extracted from chat.js)
  - `cashu-wallet.js` — in-app Cashu eCash wallet (BIP-39 seed, IndexedDB proofs, mint namespacing, Lightning fund/withdraw, Cashu token send/receive, fee splitting, pending deposit/withdraw recovery)
  - `nostr-discovery.js` — Nostr relay queries for Kind 38421 Routstr node events, health checks, caching, node selection
  - `sync.js` — Evolu CRDT sync layer, push/pull, mnemonic identity, AI settings sync, debounced `onDataSaved` hook, sync status indicator (header badge + popover)
  - `settings.js` — settings modal, privacy section, sync setup modal
  - `provider-panels.js` — AI provider panel rendering, model dropdowns, wallet UI (extracted from settings.js)
  - `lens.js` — Knowledge Base backing the Interpretive Lens. `queryLens` retrieves top-K, `injectLensChunks` folds into `[section:interpretiveLens]`. LRU cache (20/5min, profile-scoped), tight fetch options. Two backends — **`in-browser`** (OPFS + MiniLM via `lens-local*`) and **`external-server`** (user URL + Bearer key; any HTTP endpoint speaking the `POST /query` contract documented in `docs/guide/interpretive-lens.md`) — surfaced as two pill buttons in Settings → AI → Knowledge Base. The in-browser backend exposes a Library picker; `_libList`/`_libCreate`/`_libActivate`/`_libRename`/`_libDelete` dispatch to the worker. `cfg.name` is auto-synced with the active library name. `migrateLensConfig()` maps legacy `remote`/`local-browser`/`desktop-engine` values forward
  - `lens-local.js` / `lens-local-worker.js` / `lens-local-utils.js` / `lens-local-parsers.js` — browser-local lens stack. Main thread API + module Worker running transformers.js WASM + OPFS persistence via `FileSystemSyncAccessHandle` + MMR reranker (λ=0.5, 3× oversample) + pdf.js/mammoth/JSZip extraction. **Multi-library**: per-library OPFS subdirs under `/lens-local/<id>/`, `_libraries.json` at top-level tracks registry + active. ingest/query/stats/delete/clear scope to active library; create_library/rename_library/activate_library/delete_library manage the registry. **Per-library embedding model** (v1.21.4+): each library carries a `model` field pointing into the `MODELS` catalog in `lens-local-worker.js` (MiniLM, BGE-small-en, multilingual-E5-small, BGE-base-en). `MODEL_ID` + `DIM` are `let`-mutable and tracked by `_applyModelSpec()`; `_loadEmbedder()` handles model swaps on library activate. Startup benchmark (`_benchmarkEmbedder`, 5 synthetic chunks, median ms/embed) emits a tier verdict used by `_showLibraryCreateDialog` to pre-select a device-matched default. Auto-migration from legacy flat layout + auto-fill of missing `lib.model` on first launch. Lazy-loaded only when user selects the local backend
  - `glossary.js` — marker glossary modal
  - `feedback.js` — feedback modal (bug reports, feature requests)
  - `tour.js` — guided tour (spotlight walkthrough, auto-triggers after first data import) + cycle tour
  - `changelog.js` — What's New modal, auto-trigger on update (uses `window.APP_VERSION` from `/version.js`)
  - `client-list.js` — Client List modal (search/sort/filter profiles, inline create/edit form, archive/flag/pin/delete, biometrics)
  - `nav.js` — sidebar (with collapsible test-type groups), compact profile button, avatar colors
  - `views.js` — `navigate`, dashboard, category, compare, correlations, detail modal, manual entry, create custom marker, focus card, onboarding, emoji picker, category rename/icon editing, marker rename/revert, calculated marker input diagnostics
  - `main.js` — `DOMContentLoaded` init, OAuth callback, event listeners, refresh callback
- **`vendor/`** — locally bundled Chart.js, chartjs-adapter-native, pdf.js (+worker), Google Fonts (woff2), `venice-e2ee.js` (Venice E2EE — ECDH + HKDF + AES-GCM), Evolu (CRDT sync + SQLite WASM + OPFS worker), cashu-ts (Cashu eCash), bip39-minimal, qrcode-generator, mammoth (DOCX parser for browser-local lens), JSZip (ZIP extraction). `@huggingface/transformers` is NOT vendored — the npm-dist bundle has bare module specifiers that need a bundler to resolve; runtime loads it from jsdelivr. Tracked as phase 2c in memory/project_browser_local_lens.md. Run `./update-vendor.sh` to refresh vendored files
- **`data/`** — `demo-female.json`, `demo-male.json`, `emf-assessment-template.html`, `snp-health.json` (42 autosomal SNPs), `haplogroups.json` (28 mtDNA haplogroups with Wallace coupling classification), `mito-compounds.json` (108 mitochondrial compound effects)
- **`tests/`** — test files (`test-*.js`). Most run in Puppeteer (browser asserts via IIFE + `assert(name, cond)` pattern); a few run node-side on dev-server / native-dialog guard / lens-local-utils. Plus `verify-modules.js` + `spike-*.html` perf / ingest spikes + `spike-fixtures/` sample markdown

Functions called from inline HTML `onclick` handlers are exposed via `Object.assign(window, {...})` at the bottom of each module. Cross-module calls use `window.fn()` to avoid circular dependencies.

### Data Flow

1. `getActiveData()` is the central pipeline: clones `MARKER_SCHEMA` → collects dates from `importedData.entries` → populates `values` arrays → calculates ratios/PhenoAge → unit conversion if US mode
2. All data in `importedData` under `localStorage` key `labcharts-{profileId}-imported`. Legacy fields auto-migrated via `migrateProfileData()`
3. `refOverrides`, `categoryLabels`/`categoryIcons`/`markerLabels` override display. `markerNotes` for freeform notes. `changeHistory` (capped 200) for AI temporal reasoning. `biometrics` stores time-series weight/BP/pulse (height on profile object)
4. Marker values are arrays aligned with `dates`; `null` = no result. `singlePoint` categories use grid cards. Charts use `spanGaps: true`
5. Each entry has `markerSources` (per-marker provenance): `{ "category.markerKey": { file: "filename.pdf", at: unixMs } }`. `file: null` = manual entry. Detail modal shows source filename per value

### PDF Import Pipeline

1. **Text extraction** → **PII obfuscation** (Local AI streaming or regex) → **AI analysis** (`parseLabPDFWithAI`, detects testType, maps to `category.markerKey`) → **Import preview** (confirm/exclude per row) → save
2. Unknown markers become custom markers (AI suggests key/name/unit/refs/group). Manual creation via sidebar "+" button. Specialty data auto-migrated via `SPECIALTY_MARKER_DEFS`
3. Batch import (`handleBatchPDFs`), sidebar grouping by `group` field, import status FAB. See `pdf-import.js`

### Profile Context Cards

Nine cards stored as structured objects in `importedData`. Cards: Health Goals, Medical Conditions, Diet & Digestion, Exercise, Sleep & Rest, Light & Circadian, Stress, Love Life & Relationships, Environment. Each has AI health dot (green/yellow/red) + tip. `buildLabContext()` in `lab-context.js` serializes all cards to AI context. See source for data structures.

### Menstrual Cycle Tracking

Female profiles only. Phase-aware reference ranges (`PHASE_RANGES`), cycle phase bands on charts, perimenopause detection, iron alerts. See `cycle.js`.

### EMF Assessment

Baubiologie sub-module under Environment card. Room-by-room measurements with SBM-2015 severity, source/mitigation tags, AI interpretation. See `emf.js`.

### Cross-Device Sync

Opt-in Evolu CRDT sync (Settings → Data). E2E encrypted, BIP-39 mnemonic identity. Last-write-wins via `syncedAt`. Header badge shows relay status. See `sync.js`, `settings.js`.

### Calculated Markers

Free Water Deficit (sodium-based), BUN/Creatinine Ratio (US-unit conversion), PhenoAge (Levine 2018, 9 biomarkers + age, requires hs-CRP). See `data.js` for formulas.

### AI Chat Panel

Slide-out panel with streaming. 2+custom personalities, stop/discuss buttons, conversation threads (50 max), image attachments (vision-gated), web search hints (3 states: active/available/E2EE). `buildLabContext()` serializes all user data in priority order. Focus card uses `buildFocusContext()`.

### AI Provider System

Six backends: PPQ, Routstr, OpenRouter, Venice, Local AI (Ollama/LM Studio/Jan), Custom. `callClaudeAPI(opts)` routes to active provider. `hasAIProvider()` gates all AI features. Venice E2EE: ECDH + AES-256-GCM, per-chunk streaming decryption, 30-min TTL. See `api.js`, `provider-panels.js`, `cashu-wallet.js`.

### Desktop app

**Retired in v1.21.0.** The getbased Electron shell was removed. Users who want local hardware-accelerated RAG self-host any server speaking the External server protocol and wire it into Settings → Knowledge Base → External server. See `memory/project_electron_retirement.md` for the full rationale.

### Dashboard Section Order

**Has data**: Onboarding Banner → Interpretive Lens → Focus Card → Context Cards → Menstrual Cycle (female) → Supplements → Key Trends + charts → Trends & Alerts → Data & Notes + Export. Import FAB (floating button, bottom-right above chat FAB) replaces the compact drop zone.
**Empty state**: Welcome hero (drop zone + demo cards) → collapsed context cards.

### Other Features

- **Trend alerts**: `detectTrendAlerts()` — sudden change (>25% ref range jump) + linear regression (slope/R² thresholds)
- **Marker glossary**: searchable modal, all markers grouped by category with values and ranges
- **Guided tours**: 7-step app tour (auto on first visit) + 8-step cycle tour. Generic engine: `runTour(steps, storageKey, auto)`
- **What's New modal**: `CHANGELOG` array in changelog.js. `APP_VERSION` in `/version.js` — single source of truth for app + SW cache. Patch bumps skip What's New; minor/major show it
- **Chart layers**: single dropdown controlling note dots, supplement bars, cycle phase bands. Persisted per-profile
- **Onboarding**: chat-driven 5-stage wizard (profile → API → extras → cards → has-data nudge). First-time visitors get auto-opened chat instead of guided tour. Per-profile state in localStorage. Pre-lab path: no-data context assembly, context-aware chat prompts

## Development

```
node dev-server.js
```
Dev server mirrors production routing. Landing page repo (`../get-based-site`) served at `/` when present, app at `/app`. Docs at `/docs/*` route to `dist-docs/`.

### Tests

All tests (node-side + Puppeteer) run headlessly:
```
./run-tests.sh
```
Auto-starts server, runs node-side tests first (fast fail on helper regressions), then all browser tests via Puppeteer. Exits 0/1.

### Documentation Site

VitePress at `/docs` (source in `docs/`). 33 user guide pages + 9 contributor pages. Build: `npm run docs:build`. Vercel deploys to `/dist-docs/`.

### PWA

`manifest.json` + `service-worker.js`. Cache: `labcharts-v${APP_VERSION}`. Bump `version.js` to bust cache. AI API calls bypass SW entirely (avoids IPC stream buffering).

### Responsive Layout

Breakpoints: 3000/2000/1600/1400px (chat scaling), 1200px (cards 3→2 col), 1024px (sidebar → hamburger slide-out with backdrop), 768px (compact header — hides dates, range, feedback, donate; header groups with dividers), 600/480/375px (mobile). Grid items: `min-width: 0; overflow: hidden`. Touch: `@media (pointer: coarse)` 44px tap targets; `@media (hover: none)` reveals hover-only elements. Mobile sidebar: `toggleMobileSidebar()`/`closeMobileSidebar()` in nav.js, auto-closes on navigation.

## Key Patterns

- **Status**: `getStatus()` → `"normal"`, `"high"`, `"low"`, `"missing"`. Returns `"normal"` when refs are `null`
- **Theme**: Dark (default) / light. CSS vars in `:root`, overridden in `[data-theme="light"]`
- **Performance**: rendering functions accept optional `data` param to avoid redundant `getActiveData()` calls
- **Chart.js plugins**: `refBandPlugin`, `optimalBandPlugin`, `noteAnnotationPlugin`, `supplementBarPlugin`, `phaseBandPlugin`. Time scale (proportional) for multi-point markers, category scale for single-point. Custom native date adapter (`vendor/chartjs-adapter-native.js`). Plugins detect scale type and fall back to index-based positioning for category charts (correlation view)
- **Streaming**: SSE via `callClaudeAPI({ onStream })`
- **Security**: `escapeHTML(str)` for all innerHTML. Markdown URLs validated to http/https/mailto
- **Marker keys**: `category.markerKey` format (e.g., `biochemistry.glucose`) used everywhere
- **Debug**: `isDebugMode()` gates console output. Toggled in Settings → Privacy
- **Design system**: `--accent-gradient`, `--shadow-lg`/`--shadow-glow`, `.ctx-btn-group`/`.ctx-btn-option` pill buttons
