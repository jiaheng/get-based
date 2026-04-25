// changelog.js — What's New modal, version tracking, auto-trigger on update
// APP_VERSION comes from /version.js (loaded as classic script before modules)

import { escapeHTML } from './utils.js';

const CHANGELOG = [
  {
    version: '1.27.1', date: '2026-04-25', title: 'Apple Health daytime HR + wearables in JSON export + agent docs',
    items: [
      '<b>Apple Health users now get a daytime HR card.</b> Previously the importer skipped <code>HKQuantityTypeIdentifierHeartRate</code> samples; v1.27.1 routes them into <i>hr_day</i>, filtered to the 06:00–22:00 local window and averaged. RestingHeartRate stays in the <i>rhr</i> slot via min-aggregation.',
      '<b>JSON export carries the wearable layer.</b> <i>Settings → Data → Export Client</i> now includes <code>wearableSummary</code>, <code>wearableCardOrder</code>, and <code>wearablePrimaryOverride</code> so you can move profiles between devices or hand the JSON to an agent. OAuth tokens (<code>wearableConnections</code>) are still excluded — same shape as Evolu sync.',
      '<b>Agent Access docs updated</b> with the wearable-series toggle walkthrough at <a href="https://getbased.health/docs/guide/agent-access" target="_blank">docs/guide/agent-access</a>: section format, example output, token cost, privacy guarantees, and the <code>getbased_section(\'wearables-series-30d\')</code> MCP call.',
    ]
  },
  {
    version: '1.27.0', date: '2026-04-25', title: 'Agents can read your 30-day wearable daily series',
    items: [
      '<b>Agent Access (Settings → Integrations → Agent Access) gains a "Push 30-day wearable series" toggle.</b> When on, the browser builds a pivoted matrix of daily values (HRV, RHR, sleep, readiness, steps…) from your local L1 IndexedDB and pushes it to the gateway as <code>[section:wearables-series-30d]</code>. Any MCP-connected agent (Hermes, OpenClaw, Claude Code, etc.) can pull it via <code>getbased_section(\'wearables-series-30d\')</code>.',
      '<b>Off by default — opt in if you want time-series reasoning.</b> Adds ~400 tokens per agent prompt (real measurement on 30 days × 13 metrics; cached cleanly by the prompt cache so the marginal cost per turn is small). The always-on ~200-token L2 summary keeps working unchanged.',
      '<b>Privacy unchanged.</b> Raw daily samples still never sync via Evolu — they read from the browser\'s local IDB only. The gateway sees the rendered string. OAuth tokens stay local (still stripped by <code>stripWearableCredentials</code>).',
      '<b>Format.</b> One line per metric, chronological values separated by <code>→</code>, no-reading days as <code>—</code>. Each line includes the primary source so the agent knows whether HRV came from Oura, Apple Health, or Polar workouts. 1dp rounding to keep tokens tight without losing meaningful precision.',
      '<b>Toggle re-pushes immediately</b> so the agent sees the new section the next time it queries (no 5-second debounce wait).',
    ]
  },
  {
    version: '1.26.0', date: '2026-04-25', title: 'Wearables UX audit — source badges, honest deltas, calmer strip',
    items: [
      '<b>Every card shows its source.</b> When ≥2 wearables are connected, every populated card now carries a <i>via X</i> badge so you can see at a glance whether HRV came from Oura, sleep score from Fitbit, weight from Manual. Click any badge to switch source.',
      '<b>Honest deltas.</b> Steps no longer shows a baseline-delta arrow against an in-progress count (132 vs 997 baseline at 9 AM read like a 87% drop). Stress / activity / any "lower-is-better" metric at zero against a non-zero baseline no longer flashes "↓ 100%". Zero-baseline metrics suppress the delta entirely instead of "→ —".',
      '<b>Source picker reachable on every card.</b> A <i>via {Source} · swap</i> button now sits in the detail-modal header — previously the source switcher only appeared when ≥2 vendors declared the same metric.',
      '<b>Subtle sub-labels.</b> "HRV overnight" / "Resting HR overnight" replaced with a 🌙 sun-glyph (overnight) and ☀️ (daytime). Resting HR drops the redundant sub entirely. Screen readers still hear "overnight" / "daytime" via spoken aria.',
      '<b>Daytime empty-state row tightened.</b> Long per-vendor explanation moves to a hover/tap tooltip; the visible cell reads <i>Not from {Source} · why?</i>',
      '<b>Niche cards collapsed.</b> Cardio age + Resilience level (Oura proprietary scores) move into a <i>+ 2 more</i> disclosure unless you reorder them up. Strip drops from 12 to 10 cards by default.',
      '<b>Reorder mode visual cue.</b> An accent banner pill + dashed grid outline make it obvious you\'re in arrange-mode. Button label expanded from <code>⇄</code> to <code>⇄ Reorder</code>.',
      '<b>Manual-row count populates immediately.</b> The "Counting readings…" placeholder in Settings → Integrations → Manual now resolves on first paint, not just when you toggle the row open.',
      '<b>Apple Health export instructions are a numbered list</b> behind a <i>How to export from your iPhone</i> disclosure, not a 3-line run-on paragraph.',
      '<b>"Re-sync last 90 days" looks secondary.</b> The button is softer than the primary <i>Sync</i> action with a "(may take a moment)" hint, since it can hit vendor rate limits and take 30s+.',
      '<b>BP cards have proper aria.</b> Screen readers now hear <i>"Blood pressure systolic 135 mmHg"</i> instead of <i>"BP syst 135 mmHg"</i>.',
      '<b>Resilience level "1 /5" gap closed</b> — value + unit now render as a single token, not separated.',
      '<b>Mobile FAB no longer overlaps the strip</b> (added 80px bottom margin under 600px viewports). Source badge switches from all-caps to title-case at narrow widths so it doesn\'t shout.',
    ]
  },
  {
    version: '1.25.3', date: '2026-04-25', title: 'HRV modal explains why daytime HRV is missing per source',
    items: [
      'When the active HRV source can\'t supply daytime data (Oura/WHOOP overnight-only, Polar workout-only with no recent workouts), the detail modal now shows a <i>Daytime HRV — —</i> row with a per-vendor explanation pointing at sources that would populate it (Apple Health, Fitbit <code>dailyRmssd</code>, Polar workouts). Previously the row was just absent and users assumed the feature was broken. The latest/7d/30d sub-stats appear identically to <i>Daytime HR</i> as soon as a daytime-capable HRV source is connected.',
    ]
  },
  {
    version: '1.25.2', date: '2026-04-25', title: 'Daytime HRV / HR show 7-day + 30-day averages, not just today',
    items: [
      'A single quiet or active day can swing daytime HR by 20+ bpm, so showing only the latest value made the companion stat noisy. The HRV / RHR detail modal now adds <i>Daytime (7d)</i> and <i>Daytime (30d)</i> averages alongside <i>Daytime (latest)</i>, the same shape as the overnight stats. The 30-day cell is suppressed until there\'s at least 2 weeks of data so it doesn\'t lie about a one-week trend.',
    ]
  },
  {
    version: '1.25.1', date: '2026-04-25', title: 'Fix: Oura daytime HR backfill now populates the full 90 days',
    items: [
      'The v1.25.0 daytime-HR work fetched Oura\'s <code>heartrate</code> endpoint with a 90-day window in one shot — but the endpoint caps each query at 30 days and quietly returns 400. The error was swallowed and the backfill silently produced rows with no daytime HR. Now chunked into 29-day slices so a 90-day backfill actually populates <i>Daytime HR</i> for every day. <b>Re-sync Oura once</b> via Settings → Integrations → Oura → <i>Re-sync last 90 days</i>.',
    ]
  },
  {
    version: '1.25.0', date: '2026-04-25', title: 'Daytime HRV + heart rate, alongside overnight',
    items: [
      '<b>Wearable adapters now distinguish overnight from daytime HRV / RHR.</b> Until today, every adapter dumped whatever signal the vendor calls "daily HRV" into one slot — but Oura/WHOOP/Fitbit measure overnight rMSSD during sleep, while Polar measures workout HRV during exercise, and Withings reports a daytime spot pulse from the scale. Same slot, three different numbers. v1.25.0 splits them.',
      '<b>Per-vendor mapping</b> — Oura adds a <code>heartrate</code> stream pull and aggregates awake-tagged samples into <i>daytime HR</i>. WHOOP\'s 24h cycle-average HR routes to <i>daytime HR</i>. Fitbit splits <code>deepRmssd</code> (overnight) from <code>dailyRmssd</code> (broader day aggregate). Ultrahuman\'s 24h <code>.avg</code> fields move to the daytime slots; the overnight slots fill from <code>.sleep</code> sub-fields. Withings scale pulse moves from <i>resting HR</i> (it never was) to <i>daytime HR</i>; the overnight slot now sources from sleep summary <code>hr_min</code>. Polar workout HR + HRV move to the daytime slots; overnight RHR sources from sleep nights. Apple Health splits HRV SDNN samples by hour-of-day window (22:00–06:00 = overnight, 06:00–22:00 = daytime).',
      '<b>Strip stays calm.</b> Daytime values do NOT get their own cards — they\'d clutter the dashboard with two HRV cards and two HR cards. Instead, when you open the detail modal for HRV or RHR, the matching daytime aggregate appears as an extra stat row underneath the overnight number.',
      '<b>AI context labels both windows explicitly.</b> The chat prompt now sees <i>HRV (overnight)</i> AND <i>HRV (daytime)</i>, <i>Resting HR (overnight)</i> AND <i>Heart rate (daytime)</i> — distinct enough that the model can reason about stress reactivity vs recovery instead of conflating them.',
      '<b>Honesty fixes.</b> Withings users will see their <i>Resting HR</i> card go empty if they only have a scale connected (no sleep summary) — that\'s correct, the scale never measured RHR. Polar users similarly: workout HR isn\'t resting. The fix is to either log a sleep night or connect another wearable that measures overnight HR.',
      '<b>Re-sync your wearables once</b> to populate the new daytime slots — existing 90-day backfills don\'t auto-reprocess. Settings → Integrations → expand any vendor → <i>Re-sync last 90 days</i>.',
    ]
  },
  {
    version: '1.24.1', date: '2026-04-25', title: 'Fix: deleting manual readings actually deletes them',
    items: [
      'The × on each manual reading inside a wearable detail modal threw silently and the row stayed in storage. Confirming the dialog now removes the entry, refreshes the L2 summary, and repaints the strip card. Same fix for the <i>Delete all manual entries</i> action under Settings → Integrations → Manual.',
    ]
  },
  {
    version: '1.23.0', date: '2026-04-24', title: 'DNA + mtDNA overhaul: 5 new SNPs, 11 sub-haplogroups, valence-aware UI',
    items: [
      '<b>5 new SNPs</b> across three new categories: ALDH2 (alcohol flush + cancer risk), CYP1A2 (caffeine metabolism), MTNR1B (late-eating glucose impact), FTO (obesity, exercise-attenuated), and CETP I405V (longevity variant). Curated set: 42 → 47.',
      '<b>11 new mtDNA sub-haplogroups</b> (H1, H3, J1, J2, K1, T1, T2, U5a, U5b, U6, A2) so consumer mtDNA tests resolve to the level they were measured at — not rolled up to the parent. Total: 28 → 39 haplogroups. Smarter matcher picks the more-specific sub-clade on equal scores.',
      '<b>Genetics dashboard tells you what is good news.</b> New orange dot for mild effects (previously invisible), green dot for beneficial variants (PCSK9, CETP, LIPC, PPARG protective), white dot for informational/lab-artifact findings (FUT2 secretor status). Legend explains the scheme at the top of the section.',
      '<b>DNA interpretation recalibrated</b> against 2020s literature: MTHFR A1298C, MTR, VDR FokI, ADIPOQ +45 effect labels tightened from <i>moderate</i> to <i>mild</i> where modern meta-analyses show only modest effects. FUT2 wild-type (GG) corrected from <i>moderate</i> to <i>none</i>. CETP TaqIB strand fix: table was keyed on old reverse-strand alleles (G/T) from 2002 papers; every modern DNA vendor reports forward-strand (G/A), so every heterozygous CETP TaqIB call silently mis-matched until today. TCF7L2 notes softened from verdict-language to tendency-language.',
      '<b>Illumina GenomeStudio (DNAEra) DNA format</b> now supported. Parser handles all the wrapped probe-name variants (<code>seq-rsXXX</code>, <code>GSA-rsXXX</code>, <code>ilmnseq_rsXXX</code>, <code>BOT-</code>, <code>TOP-</code>, etc.) so wrapped probes still hit the SNP lookup. First-non-missing call wins on duplicate probes.',
      '<b>Supplement mito-effect database refreshed:</b> added Urolithin A, Methylene Blue, Spermidine, Fisetin, Caffeine, and Ethanol — the most conspicuous omissions. Mechanism notes updated for Metformin (Complex I primacy contested by 2018-2024 mGPDH/AMPK research), Aspirin (uncoupling is high-dose only), Resveratrol (SIRT1 binding contested), and Melatonin (protective antioxidant, not direct activity boost). Total compounds: 108 → 114.',
      '<b>Recommended models bumped:</b> Claude Opus 4.7 and GPT-5.5 now surface in the recommended section across OpenRouter, PPQ, Routstr, and Venice as soon as each provider catches up.',
      '<b>Existing imports keep working,</b> but <b>re-import your DNA / mtDNA file once</b> to populate the 5 new autosomal SNPs, refresh CETP TaqIB heterozygous calls (silently mis-matched until today on existing imports), and resolve the 11 new mtDNA sub-haplogroups. Recalibrated effect labels and the dot-color refresh happen automatically.',
    ]
  },
  {
    version: '1.24.0', date: '2026-04-24', title: 'Health Metrics — wearables + manual entry in one unified dashboard strip',
    items: [
      '<b>Seven wearable integrations.</b> Connect Oura, WHOOP, Withings, Ultrahuman, Fitbit, Polar, or Apple Health (file import). Each one syncs the metrics it exposes — HRV, resting heart rate, sleep, readiness, activity, steps, weight, blood pressure, and more — into a single dashboard view alongside your blood work.',
      '<b>Manual entry is a first-class source.</b> Weight, blood pressure, and resting heart rate moved from the Edit Client modal to the dashboard strip. Empty cards appear with a <code>+ log</code> affordance — tap to open an inline form (number field + date picker + optional context chips like <i>post-workout</i> or <i>morning-fasted</i>), Enter to save. Same card shape as wearable-synced metrics, labeled <i>via Manual</i>. Existing biometrics data migrates automatically on first load.',
      '<b>Per-metric source picker.</b> When two sources cover the same metric (e.g. Oura + manual both provide resting HR), tap the <i>via {vendor}</i> badge to switch which one drives the card. Per-metric, persisted, overridable.',
      '<b>Manage every reading individually.</b> Tap any card → detail modal now lists every manual entry for that metric with per-row delete and a <code>+ Add reading</code> button that accepts backfilled dates. No more "all or nothing" — fix a typo without wiping history.',
      '<b>Reorder your strip.</b> Tap the ⇄ button in the strip header → each card grows ◀ ▶ arrows → one click moves that card one slot. Works the same on mouse and touch. Order persists per-profile.',
      '<b>Settings → Integrations panel</b> for managing connections. Real vendor logos, one-click connect, expand a row to sync / re-sync 90 days / disconnect. Manual is in the same list — expand it for entry counts + a <i>Delete all manual entries</i> escape hatch (wearable data untouched).',
      '<b>Settings → AI → AI Context</b> has a toggle to include or exclude wearable data from the AI chat context. On by default; turn it off to keep metrics out of every prompt.',
      '<b>Privacy by design.</b> Wearable data stays on your device. Only a compact summary plus anomaly events sync to your other devices via the existing Evolu CRDT. We never see your raw HRV / sleep / heart-rate data. OAuth tokens stay per-device — never sync.',
      '<b>Notes.</b> Polar exposes HRV only from recorded workouts (not overnight averages like Oura / WHOOP / Fitbit). Apple Health is file-import — export from your iPhone and drop the zip in. All seven integrations are <i>beta</i>; WHOOP and Ultrahuman are waiting on partner credentials for the OAuth handshake.',
    ]
  },
  {
    version: '1.21.7–9', date: '2026-04-20', title: 'Code hygiene',
    items: [
      'Dead code removed, internal architecture doc trimmed, chat panel split into smaller modules. No user-visible change.',
    ]
  },
  {
    version: '1.21.6', date: '2026-04-20', title: 'Docs accuracy sweep',
    items: [
      'Custom API added to the provider list (it\'s been supported since v1.16.1 — the table just missed it).',
      'Personal-agents and Agent Access setup guides updated to the one-command installer.',
    ]
  },
  {
    version: '1.21.5', date: '2026-04-20', title: 'Security hardening',
    items: [
      'Attribute-safe HTML escaping across every user-authored field — closes a class of self-XSS when strings contained a bare double quote.',
      'Tightened the Vercel AI proxy so it can\'t be abused to reach private networks or cloud-metadata services.',
      'New tests covering the markdown renderer (every streamed AI response passes through it).',
    ]
  },
  {
    version: '1.21.4', date: '2026-04-20', title: 'Per-library embedding model',
    items: [
      'Pick from four embedding models when you create a new on-device Knowledge Base library — MiniLM (fast, small), BGE-small (balanced English), Multilingual-E5 (100+ languages), or BGE-base (best English quality).',
      'getbased benchmarks your hardware on first load and pre-selects the strongest model your device can run smoothly.',
      'The model is locked at creation — switching would mean re-indexing every document, so the choice is made upfront. Existing libraries continue on MiniLM with no forced migration.',
    ]
  },
  {
    version: '1.21.3', date: '2026-04-20', title: 'One-command Knowledge Base setup',
    items: [
      'External server setup is now a single terminal command: <code>curl -sSL https://getbased.health/install.sh | bash</code> (Linux). Installs the agent stack, starts the services, prints a one-click dashboard login URL.',
      '"Cautious?" footer with commands to review or verify the script before running — source is public, SHA256 is published.',
      'Linux-only for now. macOS and Windows install the package but can\'t auto-start services; the panel says so explicitly instead of silently leaving them stuck.',
    ]
  },
  {
    version: '1.21.2', date: '2026-04-20', title: 'Sync fix on Chrome for Android',
    items: [
      'Cross-device sync now works on Chrome for Android — a pre-flight check was wrongly blocking it.',
      'Updated stale Settings copy that still mentioned the retired Electron build.',
    ]
  },
  {
    version: '1.21.1', date: '2026-04-19', title: 'Knowledge Base setup polish',
    items: [
      'Simpler external-server setup flow in Settings → Knowledge Base.',
      'OpenClaw joins the list of supported MCP clients.',
    ]
  },
  {
    version: '1.21.0', date: '2026-04-18', title: 'Knowledge Base libraries',
    items: [
      'Multiple libraries — keep research papers, clinical guides, and personal notes in separate collections, switch between them from Settings.',
      'Faster retrieval on modern browsers (up to 3–10×), with a transparent fallback on older ones.',
      'More document types supported: PDF, Word, Markdown, plain text, and ZIP archives.',
      'Background indexing with cancel — close Settings and keep working while long runs process, stop early without losing what\'s already indexed.',
    ]
  },
  {
    version: '1.20.1', date: '2026-04-16', title: 'Bug fixes',
    items: [
      'Custom API key now works after page reload (#124).',
      'Context cards (diet, sleep, stress, and the rest) update on screen immediately after saving — no reload needed (#123).',
      'Closed a same-origin bypass on the dev-server proxy route (#119 follow-up).',
    ]
  },
  {
    version: '1.20.0', date: '2026-04-15', title: 'Custom Knowledge Source',
    items: [
      'Connect your own RAG knowledge endpoint to the Interpretive Lens — the AI grounds its analysis in research, clinical guides, or documents you provide.',
      'Works across chat, multi-persona discussions, and the focus card.',
      'Bug fixes: GPT-5 / o-series support in Custom API (#114), Custom API settings now persist across backup + sync (#116).',
    ]
  },
  {
    version: '1.19.2', date: '2026-04-14', title: 'Sync Context Fix',
    items: [
      'Specialty lab data (Fatty Acids, OAT, etc.) now syncs completely even when excluded from AI chat',
      'Fixed a bug where sync silently failed to push lab data to the gateway',
    ]
  },
  {
    version: '1.19.0', date: '2026-04-12', title: 'Precise Supplement Dosing',
    items: [
      'New "Doses/day" field on supplements \u2014 set once as the default multiplier for every ingredient in a combo product',
      'Per-ingredient \u00d7/day override \u2014 for stacks where different ingredients have different schedules (e.g. Mg Bisglycinate 1\u00d7 AM + Taurate 2\u00d7/day)',
      'Live daily total next to each ingredient as you type \u2014 catches entry mistakes before saving',
      'AI receives explicit daily totals (no more guessing the math from free-text dosing)',
      'Comma-decimal parsing fixed \u2014 "5,4 mg" now parses correctly instead of dropping the decimal',
      'Impact analysis cache is now per-supplement \u2014 editing one supp re-analyzes only that supp, not the whole batch',
    ]
  },
  {
    version: '1.18.4', date: '2026-04-11', title: 'Security Fixes + Codebase Refactoring',
    items: [
      'Fix Vitamin D mcg/L import \u2014 unit now correctly converts to nmol/L (#102)',
      'Custom API key now encrypted at rest when encryption is enabled (#103)',
      'Dev server locked to localhost, proxy endpoints require same-origin (#104, #105)',
      'Filename XSS fix in import preview (#106)',
      'Image import PII warning \u2014 confirmation dialog before sending images to AI (#107)',
      'Codebase refactoring \u2014 extracted markdown, backup, lab-context, provider-panels into separate modules',
    ]
  },
  {
    version: '1.18.0', date: '2026-04-10', title: 'Import Provenance + Supplement Intelligence',
    items: [
      'Import provenance \u2014 every value tracks which PDF or manual entry it came from, shown on hover in detail modal',
      'Supplement ingredients \u2014 add manually, scan a label photo, or paste a product URL to auto-extract with AI',
      'Supplement impact analysis \u2014 AI before/after biomarker comparison with health dot and cached results',
      'Focus card \u2014 respects AI context toggles, cleaner output with thinking models, bounded context',
      'Thinking model fix \u2014 reasoning content no longer leaks into chat or focus card',
    ]
  },
  {
    version: '1.16.3', date: '2026-04-08', title: 'BioStarks Adapter',
    items: [
      'BioStarks adapter \u2014 native support for BioStarks dried blood spot panels (amino acids, fatty acids, intracellular minerals, vitamins, hormones, metabolism)',
      '23 new specialty markers with BioStarks-specific reference ranges \u2014 12 amino acids, 5 serum fatty acids (\u00b5mol/L), 3 intracellular minerals (\u00b5g/gHb), cortisol, T/C ratio, vitamin E',
      'Hybrid import \u2014 standard blood markers (glucose, lipids, etc.) map to standard categories for trend tracking alongside other labs',
    ]
  },
  {
    version: '1.16.1', date: '2026-04-08', title: 'Custom API Provider',
    items: [
      'Custom API provider \u2014 connect to any OpenAI-compatible endpoint with your own base URL and API key',
      'Dynamic model list \u2014 models fetched automatically from your endpoint, with manual model ID fallback',
    ]
  },
  {
    version: '1.16.0', date: '2026-04-07', title: 'Decentralized Routstr',
    items: [
      'Decentralized AI \u2014 discover Routstr nodes via Nostr relays, connect to any node directly from your browser',
      'In-app Cashu wallet \u2014 BIP-39 seed, Lightning deposit/withdraw, Cashu token send/receive, mint selection',
      'Node picker \u2014 browse online nodes, deposit sats, withdraw back to wallet, auto-mint compatibility',
      'Wallet recovery \u2014 seed phrase restore, pending deposit/withdraw recovery, encrypted backup via sync',
    ]
  },
  {
    version: '1.15.1', date: '2026-04-07', title: 'AI Context Optimization',
    items: [
      'Memoize lab context \u2014 skip redundant rebuilds across chat messages, health dots, and focus card',
      'Trim health dot context \u2014 only send stale card sections to AI, reducing tokens per refresh',
      'Skip redundant data pipeline clone in health dot pre-check',
    ]
  },
  {
    version: '1.15.0', date: '2026-04-05', title: 'PPQ + Wallet Topups',
    items: [
      'New AI provider: PPQ \u2014 300+ models, no KYC. Bitcoin, crypto + Bitrefill topup',
      'In-app wallet topup \u2014 fund Routstr (Lightning QR + Cashu) and PPQ (Lightning, Bitcoin, Monero, Litecoin, Aqua) directly in getbased',
      'Balance display for OpenRouter, Routstr, PPQ, and Venice in settings',
      'Removed Anthropic direct provider \u2014 Claude models available via OpenRouter, PPQ, Venice, Routstr',
      'Bugfixes and improvements',
    ]
  },
  {
    version: '1.14.0', date: '2026-04-01', title: 'Routstr + Tor + Audit',
    items: [
      'New AI provider: Routstr \u2014 pay with Bitcoin eCash or Lightning. No account, no subscription',
      'Tor hidden service \u2014 full app accessible via .onion. Sync relay auto-switches to .onion. Tor Browser shows ".onion available" badge on clearnet',
      'Codebase audit \u2014 8 bug fixes, 6 accessibility fixes, 2 security hardening, dead code cleanup',
    ]
  },
  {
    version: '1.13.2', date: '2026-03-31', title: 'Agent Access',
    items: [
      'ISO timestamps on all lab values in AI context \u2014 precise dates instead of month/year for better trend analysis',
      'Delta indicators (\u2191/\u2193/\u2192) on all multi-reading markers \u2014 compares to previous reading for accurate recent-trend direction',
      'Rename OpenClaw to Agent Access \u2014 works with getbased-mcp on Hermes Agent, OpenClaw, or any MCP-compatible agent',
    ]
  },
  {
    version: '1.13.1', date: '2026-03-31', title: 'DEXA Scan Support',
    items: [
      'New Body Composition category \u2014 body fat %, lean mass, fat mass, BMI, android/gynoid fat, A/G ratio, visceral fat area',
      'New Bone Density category \u2014 BMD spine/femur, T-scores and Z-scores (total + neck) with WHO classification ranges',
      'Sex-specific reference and optimal ranges for body fat %',
      'Detail modal: hide no-data date cards, color-coded top border (green/red/yellow by status)',
    ]
  },
  {
    version: '1.13.0', date: '2026-03-29', title: 'Tips & Recommendations',
    items: [
      '80 tip slots across biomarkers and lifestyle — Nature \u2192 Whole Food \u2192 Tools \u2192 Supplements',
      'Every supplement form linked to a PubMed study (239 references). Community corrections via GitHub',
      'Fitzpatrick skin type (I\u2013VI) in Light & Circadian card',
      'Local AI CORS help now works on all browsers and shows OS-specific instructions',
    ]
  },
  {
    version: '1.12.0', date: '2026-03-27', title: 'Sync Status & Fixes',
    items: [
      'Sync status indicator in header — green/amber/red dot shows relay connectivity, push confirmation, and pull status',
      'Click the sync dot for details: relay status, last push/pull timestamps, "Sync now" button',
      'Manual mtDNA haplogroup entry in Edit Client form and chat onboarding — no mutation file needed',
      'Fix modal windows closing when drag-selecting text to outside the modal (#87)',
      'Fix 23andMe v5 raw data import — newer export header variant was unrecognized (#89)',
      'PDF report now includes "Additional notes for AI context" field (#92)',
      'PDF report shows precise dates (day + month + year) instead of month only (#93)',
    ]
  },
  {
    version: '1.11.0', date: '2026-03-26', title: 'mtDNA Haplogroup',
    items: [
      'Import mtDNA mutation files (CSV) — resolves maternal haplogroup from diagnostic mutations',
      'Mitochondrial coupling classification based on Doug Wallace\'s framework (coupled → uncoupled)',
      'Environment mismatch detection — compares your haplotype\'s climate adaptation against your latitude',
    ]
  },
  {
    version: '1.10.4', date: '2026-03-26', title: 'Biometrics',
    items: [
      'Track height, weight, blood pressure, and resting pulse in the Edit Client form',
      'Auto-calculated BMI from height + latest weight with category label',
      'Time-series entries with date, averages, and history list for weight, BP, and pulse',
      'Biometrics included in AI context, JSON export/import, and PDF report',
    ]
  },
  {
    version: '1.10.3', date: '2026-03-25', title: 'Food Contaminants',
    items: [
      'Diet card scanned for food contaminant signals — pesticide residues (EWG Dirty Dozen) and plastic chemicals (PlasticList)',
      'Clickable warning on diet card opens detail modal with sources and "Discuss with AI" prompt',
      'Both mito warnings and food contaminants now included in AI context for smarter analysis',
    ]
  },
  {
    version: '1.10.2', date: '2026-03-25', title: 'Mitochondrial Warnings',
    items: [
      'Supplements & medications scanned against independently compiled mitochondrial effects database (PubMed-cited)',
      'Warnings appear below the supplement timeline — only harmful effects flagged (inhibits, depletes, disrupts)',
      '"Ask AI for context" opens the chat with a pre-filled prompt about your specific compounds',
    ]
  },
  {
    version: '1.10.1', date: '2026-03-25', title: 'Chat Summaries',
    items: [
      'Summarize any conversation thread — generates structured notes with key findings, action items, and open questions',
      'Summary modal with copy, download (.md), and print',
      'Saved summaries persisted per-profile and listed in the thread rail',
    ]
  },
  {
    version: '1.10.0', date: '2026-03-25', title: 'Context Tags',
    items: [
      'Section tags in AI context output — machine-parsable [section:name] tags for OpenClaw bot integration',
      'Lab categories include updated:date attributes and an [index] block for selective parsing',
    ]
  },
  {
    version: '1.9.9', date: '2026-03-25', title: 'Sync reliability',
    items: [
      'Fixed sync relay quota — CRDT operations no longer silently fail when exceeding relay limits',
      'Chat messages now refresh live when synced from another device',
      'Added sync diagnostics and polling safety net for missed sync events',
    ]
  },
  {
    version: '1.9.7', date: '2026-03-23', title: 'OpenClaw',
    items: [
      'OpenClaw integration — connect your self-hosted AI bot to answer questions about your labs over any messenger (Settings → Data → OpenClaw)',
    ]
  },
  {
    version: '1.9.6', date: '2026-03-23', title: 'Sync fixes',
    items: [
      'Fixed sync relay connection — data now correctly routes to the self-hosted relay instead of the default Evolu relay',
      'Fixed mnemonic regeneration — disabling and re-enabling sync generates a fresh identity',
      'Fixed chat thread sync when encryption is enabled',
      'Fixed chat history loss when AI stream errors mid-response (#84, #85)',
    ]
  },
  {
    version: '1.9.5', date: '2026-03-22', title: 'Cross-device sync',
    items: [
      'Cross-device sync — E2E encrypted via Evolu CRDT. All profiles and AI settings sync automatically across your devices',
      'Self-hosted relay with live connectivity indicator — no third-party dependencies',
    ]
  },
  {
    version: '1.9.4', date: '2026-03-20', title: 'Proportional chart timelines',
    items: [
      'Chart x-axes now use proportional time spacing — a 1-month gap looks smaller than a 6-month gap, so trends are visually accurate',
      'Fixed phase-aware point colors and tooltips for markers that start later than your first lab draw (female profiles with cycle tracking)',
    ]
  },
  {
    version: '1.9.3', date: '2026-03-20', title: 'Context change history',
    items: [
      'AI now knows when your health context changed — diet switches, new exercise routines, stress changes, etc. are timestamped and included in AI context so it can reason about temporal correlations with your lab results (#76)',
      'Chart timelines extend to today when your last labs are more than 30 days old, so supplements and notes added since then are visible (#78)',
    ]
  },
  {
    version: '1.9.2', date: '2026-03-20', title: 'Supplements, notes & export improvements',
    items: [
      'Focus card now includes supplements with date-aware context — AI no longer attributes changes to supplements started after your last labs (#80)',
      'Add a note/reason to each supplement to track why you\'re taking it — shown in editor, chart tooltips, AI context, and PDF report (#74)',
      'Per-biomarker notes — add persistent notes to any marker from the detail modal, included in AI context (#79)',
      'Genetics section added to PDF export report — full table of findings grouped by category with effect severity (#73)',
      'Removed Sources (OpenAlex) feature — web search via OpenRouter provides better academic coverage',
    ]
  },
  {
    version: '1.9.1', date: '2026-03-19', title: 'Thinking model support + Ollama Cloud',
    items: [
      'Thinking models (Kimi K2.5, DeepSeek R1/V3, GLM-5, QwQ) no longer produce empty responses — max_tokens cap removed so reasoning and content both fit',
      'Focus card and context card health dots work with all thinking models on any provider',
      'Ollama Cloud :cloud models recognized in Model Advisor with cloud badge and fitness ratings',
    ]
  },
  {
    version: '1.9.0', date: '2026-03-19', title: 'Venice End-to-End Encryption',
    items: [
      'Venice E2EE — prompts encrypted in your browser, decrypted only inside a verified TEE. Toggle in Venice settings swaps to E2EE models',
      'Per-message lock indicator (🔒 e2ee) in chat footer when E2EE was used',
      'Web search context hints — model knows when it has web access and when to suggest enabling it',
      'Chat links in user messages now visible (white on accent gradient)',
      'Thread list no longer reorders when switching between conversations',
    ]
  },
  {
    version: '1.8.5', date: '2026-03-19', title: 'Fatty acid trends + smarter trend colors',
    items: [
      'Fatty acid panels now show trend charts across multiple tests — previously only the latest result was visible',
      'Trend arrow colors reflect whether the change is good or bad relative to reference ranges (not just direction)',
      'Raw URLs in chat responses are now clickable links',
      'Fix: importing fatty acid results alongside blood work on the same date no longer loses the FA data',
    ]
  },
  {
    version: '1.8.4', date: '2026-03-18', title: 'Web search in chat',
    items: [
      'Web search toggle in chat — AI can search the internet before responding, useful for recent studies, drug interactions, and current information',
      'Available with OpenRouter and Venice providers; toggle auto-hides for Anthropic and Local AI',
      'Cost footnote shows 🌐 web indicator when search was active; flag persists in message history',
    ]
  },
  {
    version: '1.8.3', date: '2026-03-17', title: 'Chat search + scroll fix',
    items: [
      'Search across chat messages — find any keyword across all conversations with highlighted snippets, click to jump directly to the message (#72)',
      'Smart auto-scroll during AI streaming — scroll up to read earlier text without the chat fighting you back to the bottom (thanks @NodeVonHydra)',
      'Fix: toggling AI provider no longer auto-opens the chat panel (#71)',
    ]
  },
  {
    version: '1.8.2', date: '2026-03-16', title: 'Image import + scanned PDF auto-detect',
    items: [
      'Import lab reports from photos/screenshots (JPG, PNG, WebP) — drop or browse, same AI pipeline as PDF image mode',
      'Scanned PDFs auto-switch to image mode — no manual step needed (#67)',
      'Model Advisor works with all Local AI backends — LM Studio, Jan, not just Ollama (#68)',
      'Focus card persists when AI is paused — shows cached insight instead of disappearing (#69)',
      'DNA import: detect raw data files by content, not just filename — fixes silent failure for renamed 23andMe exports (#70)',
    ]
  },
  {
    version: '1.8.1', date: '2026-03-15', title: 'Biological Age + hs-CRP/HDL',
    items: [
      'Biological Age — combines PhenoAge (Levine 2018, 9 markers) and Bortz Age (Bortz 2023, 22 markers) into a single estimate with chronological age reference line',
      'hs-CRP/HDL Ratio — composite inflammation-lipid cardiovascular risk marker (optimal < 0.24, ref < 0.94)',
      'PhenoAge now accepts standard CRP as fallback when hs-CRP is unavailable',
    ]
  },
  {
    version: '1.8.0', date: '2026-03-15', title: 'DNA Import',
    items: [
      'Drop a raw DNA file (Ancestry, 23andMe, MyHeritage, FTDNA, Living DNA) — parsed locally in a Web Worker, never transmitted',
      '42 curated SNPs across 10 categories (methylation, iron, lipids, vitamin D, B12, blood sugar, sex hormones, thyroid, bilirubin, fatty acids) mapped to your tracked biomarkers',
      'APOE haplotype auto-resolved to ε2/ε3/ε4 notation from the two component SNPs',
      'Genetics dashboard section — collapsible, grouped by category, sorted by severity, expandable to show all findings',
      'Inline SNPs in biomarker detail modals — open Vitamin D and see your VDR, GC, CYP2R1 variants right next to your lab values',
      'AI chat automatically receives your genetic context when interpreting lab results',
      'Each SNP links to its primary study (PubMed) and SNPedia for deeper reading',
      'Sidebar entry and DNA upload step in chat onboarding',
    ]
  },
  {
    version: '1.7.7', date: '2026-03-14', title: 'Local AI Model Advisor',
    items: [
      'Settings → Local AI now rates each installed model for lab analysis: ★ Recommended, Capable, Underpowered, or Inadequate',
      'GPU auto-detected — shows which models fit your VRAM (fits / tight / too large)',
      'Suggests a better model to pull when none of your installed models are recommended',
      'Model dropdown shows file size and quantization at a glance',
      'Remote Ollama servers detected — enter server VRAM manually for accurate recommendations',
    ]
  },
  {
    version: '1.7.6', date: '2026-03-14', title: 'Focus Card + Chat Polish',
    items: [
      'Focus card now considers your health goals, interpretive lens, medical conditions, and context notes',
      'Expanded from one sentence to a brief 2-3 sentence insight with a concrete next step',
      'Typewriter streaming effect — text trickles in smoothly instead of popping in after a wait',
      'Chat now renders markdown tables, blockquotes, headings, and styled callouts',
      'PhenoAge detail modal shows exactly why calculation failed — per-date gaps, CRP mismatch, unit issues',
      'Open-ended optimal ranges now display correctly on charts and in all views',
    ]
  },
  {
    version: '1.7.5', date: '2026-03-13', title: 'Smarter Imports',
    items: [
      'PDF import now captures every numeric result — no more silently dropped markers',
      'Better handling of European lab reports — specimen prefixes and local naming conventions recognized',
      'CRP and hs-CRP tracked as separate markers — PhenoAge correctly requires hs-CRP',
      'Import progress pill shows live status when you scroll away or switch views',
      'Rename any marker from its detail view',
      'PhenoAge and other calculated markers tell you exactly which inputs are missing',
      'Slow AI models no longer get false timeout errors',
    ]
  },
  {
    version: '1.7.3', date: '2026-03-13', title: 'Privacy & Self-Hosting',
    items: [
      'Bundled Chart.js, pdf.js, and fonts locally — no more external CDN calls',
      'Self-hosted analytics — replaced third-party Umami Cloud with own instance',
      'Updated landing page privacy copy to accurately reflect what the app does',
    ]
  },
  {
    version: '1.7.2', date: '2026-03-12', title: 'Issue Fixes & Category Customization',
    items: [
      'Rename categories and change icons with a built-in emoji picker',
      'Pause AI features globally — toggle in Settings → AI tab',
      'Fatty acid cards and table/heatmap rows now open the detail modal',
      'Two-step range revert: manual edit → lab range → schema default',
      'PhenoAge biological age calculation',
      'Urea renamed to "Urea (BUN)" for clarity',
      'Updated default category icons (Hormones, Electrolytes, Lipids, Diabetes, Hematology, WBC)',
      'Toggle sliders replace checkboxes in Settings Privacy section',
    ]
  },
  {
    version: '1.7.1', date: '2026-03-11', title: 'Open-Ended Ranges & Bug Fixes',
    items: [
      'Open-ended reference ranges — clear min or max to set one-sided ranges (e.g. eGFR >59), charts show solid threshold line',
      'Fixed "Ask AI about this marker" sending wrong reference range when optimal/both mode was active',
      'Fixed edited ranges showing "lab" badge instead of "edited", with revert support for both',
      'Fixed percentage biomarkers (Neutrophils %, etc.) importing with wrong reference ranges',
      'Custom markers without ranges now show a clickable placeholder to add them',
      'Fixed OpenRouter custom model pricing not updating — now fetches real pricing on Enter',
      'Fixed thinking model JSON errors — <think> tags stripped before parsing, longer error display',
      'Review & Edit panel: scroll position preserved, diff view is read-only until Edit clicked',
      'Multiple PDF imports on the same date now tracked — Settings shows all filenames',
      'Clearer error for insufficient API credits (402)',
    ]
  },
  {
    version: '1.7.0', date: '2026-03-10', title: 'Specialty Labs & Custom Markers',
    items: [
      'Improved specialty lab support — better detection and categorization for OAT, fatty acid, and combination reports',
      'Delete custom biomarkers — click any custom marker and use "Delete this marker" at the bottom',
      'Set optimal ranges when creating new biomarkers via the "+" button',
    ]
  },
  {
    version: '1.6.2', date: '2026-03-10', title: 'Create Custom Biomarkers',
    items: [
      'Manually create new biomarkers — "+" button next to Categories in the sidebar',
      'Define marker name, unit, category (existing or new), and reference range',
      'After creation, immediately prompts to add the first value',
      'Custom markers are included in the AI marker reference for future PDF imports',
    ]
  },
  {
    version: '1.6.1', date: '2026-03-10', title: 'Import Fixes, Usage Tracking & New Markers',
    items: [
      'AI usage tracking — see per-profile and total AI costs in Settings → AI tab',
      'Cost guide added to docs — real-world pricing estimates for recommended models',
      'Plateletcrit (PCT/Trombokrit) added as a built-in hematology marker',
      'Calcitriol (1,25-(OH)₂D) added as a built-in vitamin marker',
      'Hematocrit now displays with % unit (existing data auto-migrated)',
      '18 missing unit conversions added (thyroid, iron, proteins, lipids, hematology, bone, tumor markers)',
      'Insulin now syncs between Hormones and Diabetes categories regardless of how the AI mapped it',
      'Both-range mode shows reference + optimal ranges on dashboard cards',
      'Sidebar counts now match the active date range filter',
      'Sidebar date filter hides single-point categories (Fatty Acids, etc.) outside the range',
      'PDF filename shown in Settings data list',
      'Refresh all health dots button (↻) on context cards',
      'PII review: visible Edit button for obfuscated text',
      'Reference range badges from lab imports show "lab ×" instead of "edited ×"',
      'Import no longer stores redundant range overrides when lab ranges match defaults',
      'Context cards preserve open/collapsed state on save',
      'Focus card prompt improved for local models',
      'Import preview: wider modal, status badges no longer wrap',
      'Guided tour updated to 8 steps with import FAB and profile button',
      'Light theme scrollbar improved for better visibility',
    ]
  },
  {
    version: '1.6.0', date: '2026-03-09', title: 'Chat Onboarding & Cycle Overhaul',
    items: [
      'New visitors get a friendly chat walkthrough — set up your profile, connect AI, and fill context cards step by step',
      'Menstrual cycle setup integrated into onboarding — regular periods, perimenopause, menopause, pregnancy, breastfeeding',
      'Cycle status field throughout the app — stats, period log, and phase features adapt to your status',
      'LH, FSH, and prolactin added to hormone markers with phase-aware reference ranges for LH and FSH',
      'Hormonal contraception auto-detected — phase ranges and chart bands disabled when on hormonal BC',
      'Flow strength now auto-calculated from your period log entries',
      'Contraceptive field replaced with structured dropdown (hormonal and non-hormonal options)',
      'Expanded period symptoms to 17 options including hot flashes, night sweats, anxiety, and clots',
      'Perimenopause detection now checks for vasomotor symptoms and skipped cycles',
      'Quick-add supplements and medications during onboarding',
      'First-time visitors see the chat guide instead of the app tour',
    ]
  },
  {
    version: '1.5.3', date: '2026-03-08', title: 'Import & Editing Improvements',
    items: [
      'When importing a PDF, you can now exclude individual results and see the lab\'s reference ranges before confirming',
      'New import button in the bottom-right corner for quicker access to importing',
      'Changed a value? A revert button lets you go back to what the lab originally reported',
      'Use any AI model on OpenRouter by typing its ID directly',
      'AI discussions now pick up where you left off after refreshing the page',
      'Automatic backups saved daily and kept for 30 days',
    ]
  },
  {
    version: '1.5.2', date: '2026-03-08', title: 'Chat & Discuss Mode Improvements',
    items: [
      'Get a second opinion — pick which AI persona joins your chat discussion',
      'Marker charts and values display correctly in the detail view',
      'Create custom AI personas with a cleaner editor and auto-generated emoji',
      'New "Unconventional Views" option when creating AI personas',
      'Imported vs manually entered values are now labeled in Settings',
    ]
  },
  {
    version: '1.5.1', date: '2026-03-07', title: 'EMF Improvements & Mobile',
    items: [
      'EMF: sleeping vs daytime SBM-2015 thresholds — severity adjusts per room type',
      'EMF: AI interpretation modal — stream analysis of single assessments or before/after comparisons, saved with assessment',
      'EMF: meter presets with autocomplete, room photos (up to 6 per room), before/after comparison view',
      'Mobile: hamburger menu with slide-out sidebar replaces stacked category pills',
      'Mobile: cleaner header — hides dates, range toggle, feedback, and donate on small screens',
      'Desktop: header groups with subtle dividers between profile, data, and actions',
    ]
  },
  {
    version: '1.5.0', date: '2026-03-06', title: 'EMF Assessment',
    items: [
      'Environment card: Baubiologie EMF assessment sub-module — track electromagnetic field measurements room by room',
      'SBM-2015 severity grading (No Concern → Extreme Concern) for 5 measurement types: AC electric, AC magnetic, RF/microwave, dirty electricity, DC magnetic',
      'Import EMF consultant reports via PDF — AI extracts rooms, measurements, sources, and mitigations',
      'Printable consultant template for on-site assessments (download from EMF editor)',
      'EMF data included in AI chat context, JSON export/import, and environment summary',
    ]
  },
  {
    version: '1.4.3', date: '2026-03-07', title: 'Improved Fatty Acids Support',
    items: [
      'Improved support for fatty acid panels — each lab appears as its own subcategory under a "Fatty Acids" sidebar group',
      'Auto-detects fatty acid lab from PDF content',
      'Re-importing a PDF now updates category labels instead of keeping stale ones from previous imports',
    ]
  },
  {
    version: '1.4.2', date: '2026-03-07', title: 'Bugfixes & Improvements',
    items: [
      'Edit any value — click a value in the detail modal to change it inline, with "edited" badge',
      'Fix: manually added values now store correctly in US unit mode',
      'Compact drop zone on dashboard after first import',
      'Auto-backup cooldown increased to 5 minutes to avoid snapshot churn',
      'PII review: retry button stays visible after successful obfuscation',
    ]
  },
  {
    version: '1.4.1', date: '2026-03-07', title: 'Bugfixes & Improvements',
    items: [
      'Fix: lab reference ranges from US-unit PDFs now import correctly',
      'Fix: PII review diff highlighting works properly with thinking models',
      'Improved PII review editing — cursor lands where you click, highlights persist after edits',
      'Better matching for US lab markers like BUN',
    ]
  },
  {
    version: '1.4.0', date: '2026-03-05', title: 'Image Attachments',
    items: [
      'Chat: attach images via paperclip button, paste, or drag-and-drop \u2014 AI can see photos of lab reports, supplement labels, food logs, and more',
      'Chat: up to 5 images per message, resized for optimal quality vs token cost',
      'PDF import: scanned/image-heavy PDFs now detected automatically with image mode fallback \u2014 renders pages as screenshots for AI analysis',
      'PDF import: "Force image mode" link in drop zone for known scans',
      'Vision support detection: attach button auto-hidden for non-vision models',
      'HD mode toggle: switch between standard (1024px) and high-resolution (2048px) image quality',
      'Image quality warnings: detects blurry, dark, or overexposed photos before sending',
      'Chat: smooth typewriter streaming replaces chunky text updates',
      'Chat: conversation window expanded from 10 to 30 messages for better context',
    ]
  },
  {
    version: '1.3.7', date: '2026-03-06', title: 'Reference Ranges & PII Improvements',
    items: [
      'Editable reference ranges — click any range in the detail modal to customize, with revert badge',
      'Import-time range adoption — toggle to use your lab\'s reference ranges from the PDF',
      'BUN/Creatinine ratio added as a calculated marker in the Kidney category',
      'PII review: green word-level diff highlighting on the right panel, click-to-edit',
      'PII review: model unloads from VRAM on Stop, Cancel, or Use Regex',
      'US lab PII patterns: Specimen ID, Accession No, Account No, MRN, phone, Member ID',
      'IU/L enzyme unit normalization (ALT, AST, ALP) — no more double-conversion on import',
      'Empty marker charts hidden in category views',
      'Background scroll locked on PII review modals',
    ]
  },
  {
    version: '1.3.6', date: '2026-03-05', title: 'Settings Cleanup',
    items: [
      'Profile tab removed from Settings — sex, date of birth, and location are now in the Client List',
      'Location field in Client List now shows live latitude with AI refinement (same as the old Settings)',
    ]
  },
  {
    version: '1.3.5', date: '2026-03-05', title: 'Security & Accessibility Audit',
    items: [
      'Fixed XSS vectors in PDF import preview and settings error messages',
      'Chat threads now encrypted at rest when encryption is enabled',
      'Orphaned CSS cleaned up, ARIA labels added to chat inputs and modals',
      'Avatar src validated, LAN IPs excluded from service worker caching',
    ]
  },
  {
    version: '1.3.4', date: '2026-03-05', title: 'Backup & Key Encryption',
    items: [
      'API keys are now encrypted at rest when encryption is enabled',
      'Folder backup writes timestamped snapshots and prunes to 5 files (matching IndexedDB)',
    ]
  },
  {
    version: '1.3.3', date: '2026-03-05', title: 'Local AI CORS Hints',
    items: [
      'HTTPS + LAN IP detection — immediate warning instead of a confusing timeout',
      'CORS-specific error message when Ollama blocks cross-origin requests',
      'Docs updated with localhost-only HTTPS limitation and OLLAMA_ORIGINS guidance',
    ]
  },
  {
    version: '1.3.2', date: '2026-03-05', title: 'Streaming PII Review',
    items: [
      'PII review modal now streams Local AI obfuscation in real-time \u2014 no more waiting blindly',
      'Regex fallback is an explicit button ("Use regex instead"), not a silent timeout',
      'Stop button to cancel mid-stream and edit partial results',
      'Fixed nested scrollbars in the PII review modal',
    ]
  },
  {
    version: '1.3.1', date: '2026-03-05', title: 'Unified Local AI',
    items: [
      'Provider tab renamed from "Ollama" to "Local" \u2014 one option for all local servers',
      'Removed Ollama/OpenAI mode toggle \u2014 uses the standard OpenAI-compatible API for everything (Ollama, LM Studio, Jan, etc.)',
      'PII obfuscation now works with any local server, not just Ollama',
      'API key field always visible (optional \u2014 most local servers don\u2019t need one)',
    ]
  },
  {
    version: '1.3.0', date: '2026-03-04', title: 'OpenAI-Compatible Local Servers',
    items: [
      'LM Studio, Jan, llama.cpp, LocalAI, and other OpenAI-compatible servers now supported',
      'Mode toggle in Local AI settings \u2014 switch between Ollama and OpenAI Compatible',
      'Optional API key field for servers that require authentication',
      'Auto-discovers models from any /v1/models endpoint',
      'Editable PII review \u2014 fix remaining personal info before sending to AI',
    ]
  },
  {
    version: '1.2.3', date: '2026-03-04', title: 'Folder Backup & Security',
    items: [
      'Auto-backup to a local folder (Proton Drive, Dropbox, NAS, etc.)',
      'Writes getbased-backup-latest.json + daily dated snapshots',
      'Periodic nudge reminds you to download a backup (every 30 days)',
      'Stronger passphrase requirements for encryption (8+ chars, mixed case, special)',
      'Live strength meter with rule checklist in encryption setup',
    ]
  },
  {
    version: '1.2.1', date: '2026-03-03', title: 'Export Upgrade',
    items: [
      'Per-client export from the Client List \u22ee menu',
      'Export All Clients \u2014 full database backup from Client List or Settings',
      'Exports include chat history, threads, and custom personalities',
      'Database bundle import with auto-merge across browsers',
    ]
  },
  {
    version: '1.2.0', date: '2026-03-03', title: 'Client Management',
    items: [
      'Client List modal \u2014 search, sort, filter, and manage all profiles',
      'Profile tags, notes, status (active/flagged/archived), and pinning',
      'Full client form replaces prompt dialogs (name, sex, DOB, location, avatar)',
      'Compact header button with avatar dot opens Client List',
    ]
  },
  {
    version: '1.1.4', date: '2026-03-01', title: 'Diet & Digestion',
    items: [
      '10 new digestion fields on the Diet card (bowel, bloating, reflux, etc.)',
      'Digestive health included in AI context',
    ]
  },
  {
    version: '1.1.3', date: '2026-02-28', title: 'Encryption Nudge',
    items: [
      'One-time prompt to enable encryption after first PDF import',
    ]
  },
  {
    version: '1.1.2', date: '2026-02-28', title: 'Documentation Update',
    items: [
      'New Specialty Labs guide (OAT, DUTCH, HTMA)',
      'Updated 6 guide pages with latest features',
    ]
  },
  {
    version: '1.1.1', date: '2026-02-28', title: 'Model Guidance',
    items: [
      'Model dropdowns split into Recommended / Other tiers',
      'Active model shown in chat header with per-message cost',
      'Cross-provider model mismatch warning fixed',
    ]
  },
  {
    version: '1.1.0', date: '2026-02-28', title: 'Specialty Labs & Brand Refresh',
    items: [
      'Specialty lab support (beta) \u2014 OAT, amino acids, fatty acids, toxic elements',
      'Brand refresh \u2014 getbased gradient wordmark, SVG icons, cleaner layout',
      'Batch import auto-retry and single dashboard refresh',
      'Ollama PII obfuscation now opt-in (Settings \u2192 Privacy)',
      '\u20bf Donate button in header',
    ]
  },
  {
    version: '1.0.5', date: '2026-02-27', title: 'One-Click OpenRouter',
    items: [
      'One-click OAuth connect \u2014 no more copying API keys',
      'OpenRouter is now the default provider tab',
    ]
  },
  {
    version: '1.0.4', date: '2026-02-27', title: 'Simplified First Visit',
    items: [
      'Welcome hero with drop zone and demo data',
      'Context cards collapsed by default for new users',
    ]
  },
  {
    version: '1.0.3', date: '2026-02-27', title: 'Chat Improvements',
    items: [
      'Floating chat bubble \u2014 always one tap away',
      'Setup guide when no API key is configured',
    ]
  },
  {
    version: '1.0.2', date: '2026-02-27', title: 'Pre-Lab Onboarding',
    items: [
      'No lab data? Fill context cards and get personalized test recommendations',
      'Chat prompts adapt to your state (pre-lab, onboarding, analysis)',
      'Health dots work on context alone, even without lab results',
    ]
  },
  {
    version: '1.0.1', date: '2026-02-27', title: 'Minor Tweaks',
    items: [
      'Minor tweaks and bug fixes',
    ]
  },
  {
    version: '1.0', date: '2026-02-25', title: 'Launch',
    items: [
      'AI-powered PDF import \u2014 any lab report, any language',
      '287+ biomarkers across 26 categories with interactive charts',
      'AI chat with customizable personalities',
      'Menstrual cycle-aware interpretation with phase-specific ranges',
      '9 lifestyle context cards that shape AI analysis',
      'Fully private \u2014 all data stays in your browser',
    ]
  },
];

/** Extract major.minor from a semver string (e.g. '1.0.1' → '1.0') */
function getMajorMinor(ver) {
  const parts = String(ver).split('.');
  return parts.slice(0, 2).join('.');
}

function getSeenVersion() {
  return localStorage.getItem('labcharts-changelog-seen') || '';
}

function markChangelogSeen() {
  localStorage.setItem('labcharts-changelog-seen', String(window.APP_VERSION));
}

// Changelog items are authored in source code (CHANGELOG above) — trusted.
// We escape everything by default and then re-allow a small whitelist of
// inline emphasis tags so <b>/<i>/<em>/<strong>/<code> render as styling
// instead of literal text. Anything else (script, img, links, etc.) stays
// escaped — defense-in-depth in case an entry ever incorporates user content.
function renderChangelogItem(item) {
  return escapeHTML(item).replace(
    /&lt;(\/?)(b|i|em|strong|code)&gt;/g,
    '<$1$2>'
  );
}

export function openChangelog(showAll) {
  const overlay = document.getElementById('changelog-modal-overlay');
  const modal = document.getElementById('changelog-modal');
  if (!overlay || !modal) return;

  const entries = showAll ? CHANGELOG : CHANGELOG.slice(0, 3);

  let html = `<button class="modal-close" onclick="closeChangelog()">&times;</button>`;
  html += `<h3>What's New</h3>`;

  for (const entry of entries) {
    html += `<div class="changelog-entry">`;
    html += `<div class="changelog-header"><span class="changelog-version">v${escapeHTML(entry.version)} — ${escapeHTML(entry.title)}</span><span class="changelog-date">${escapeHTML(entry.date)}</span></div>`;
    html += '<ul class="changelog-items">';
    for (const item of entry.items) {
      html += `<li class="changelog-item">${renderChangelogItem(item)}</li>`;
    }
    html += '</ul></div>';
  }

  modal.innerHTML = html;
  overlay.classList.add('show');
}

export function closeChangelog() {
  const overlay = document.getElementById('changelog-modal-overlay');
  if (overlay) overlay.classList.remove('show');
  markChangelogSeen();
}

export function maybeShowChangelog() {
  const seen = getSeenVersion();
  // First visit — no changelog, just mark as seen
  if (!seen) { markChangelogSeen(); return; }
  // Only show What's New on minor/major bumps, not patch
  if (getMajorMinor(seen) !== getMajorMinor(window.APP_VERSION)) {
    openChangelog(false);
  }
}

Object.assign(window, { openChangelog, closeChangelog, maybeShowChangelog });
