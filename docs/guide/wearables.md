# Wearable Integrations

getbased connects to seven wearable / device platforms and surfaces their daily metrics on the dashboard alongside your blood-work data.

## What you get

A wearable strip on the dashboard with a card per metric: HRV, resting heart rate, sleep score, readiness, activity, steps, weight, blood pressure, SpO₂, body-temperature delta, and more. Click any card for the full 90-day chart. If you have more than one wearable connected, tap the small *via {vendor}* badge on a card to choose which vendor drives that specific metric.

## Vendors

| Vendor | Auth | Setup |
|---|---|---|
| **Oura** | OAuth 2.0 | One-click. Need an Oura account + ring. |
| **Ultrahuman** | OAuth 2.0 | *Waiting on partner credentials* — gated in the UI. |
| **WHOOP** | OAuth 2.0 (PKCE) | *Waiting on partner credentials* — gated in the UI. |
| **Fitbit** | OAuth 2.0 (PKCE) | One-click. Need a Fitbit account + device. Sleep score is approximated from `efficiency` (Fitbit's API doesn't expose the in-app Sleep Score). |
| **Withings** | OAuth 2.0 | One-click. Need a Withings account + scale / BPM / Scanwatch. |
| **Polar** | OAuth 2.0 | One-click. Need a Polar account and **at least one device sync to Polar Flow first** — Polar AccessLink uses a transactions model that returns nothing until the device has uploaded data. HRV is workout-only (recorded with a chest strap), not overnight. |
| **Apple Health** | File import (no OAuth) | Export from your iPhone Health app and drop the `.zip` here. |

## How to connect

Settings → Integrations → click **Connect** on a vendor row.

The OAuth-based vendors open the vendor's authorise page. After you approve, you're redirected back and the integration syncs the last 90 days. Your raw daily rows live in your browser's IndexedDB (per-profile, source-tagged); a compact summary feeds the dashboard cards.

## Apple Health setup

1. iPhone → **Health** app → tap your profile photo (top right) → **Export All Health Data**
2. AirDrop or email the `export.zip` to your computer
3. Drop the zip onto the Apple Health row in Settings → Integrations

Parsing runs entirely in your browser — no server contact.

## Privacy

- **Raw daily rows never leave your device.** Stored only in IndexedDB.
- **Compact summary** (the L2 dashboard data) syncs to your other devices via Evolu CRDT (E2E encrypted, mnemonic-based identity).
- **OAuth refresh tokens stay local.** They are *not* synced — you re-connect on each device.
- **AI chat context** includes a ~200-token wearable summary by default. Toggle it off in Settings → AI → AI Context.
- **Personal Agent (MCP)** does NOT currently expose wearable data.

## Multi-vendor metric ownership

When two vendors expose the same metric (Oura HRV vs Fitbit HRV vs WHOOP HRV), the dashboard picks the most-recent non-null value by default. You can override per-metric:

- Click the *via {vendor}* badge on the card → pick a different source
- Pinned per-metric (HRV from Oura, sleep from Fitbit, etc.)
- Stored per-profile, syncs across devices

Vendors that uniquely provide a metric (only Withings does weight) don't show a badge.

## Troubleshooting

- **"Polar connected — waiting on first device sync"** — your Polar account exists and the OAuth handshake worked, but no device has uploaded data to Polar Flow yet (or all available data has been synced + committed already). Open the Polar app on your phone and sync your watch, then try Re-sync.
- **"needs reconnection" pill** — refresh token expired or revoked. Click Reconnect.
- **Wearable not in the dropdown when picking a metric source** — the vendor doesn't expose that canonical metric (e.g. WHOOP doesn't do `weight`, Withings doesn't do `hrv_rmssd`).
- **Apple Health import is slow** — the XML can be 100 MB+ for multi-year history. Parsing happens in-browser; expect 30–60 seconds for large exports.
- **"waiting on partner credentials"** for WHOOP / Ultrahuman — we don't yet have production OAuth client IDs from these vendors. Watch the changelog.

## Beta status

All seven integrations are in beta. Please report issues on [GitHub](https://github.com/elkimek/get-based/issues) or in the [Discord](https://discord.gg/zJdVB9zgQB).
