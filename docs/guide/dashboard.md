# Dashboard

The dashboard is your home base in getbased. It displays everything in a single scrollable page — no tabs to juggle, no hidden sections. The layout flows from top to bottom in a fixed order.

## Dashboard Layout

Sections appear in this order:

1. **Import Button** — A floating action button (bottom-right, above the chat FAB) for importing PDFs or JSON files. Appears once you have data; on first visit, the welcome hero handles imports
2. **Interpretive Lens** — The scientific or clinical framework the AI uses when analyzing your results
3. **Focus Card** — A single AI-generated sentence summarizing the most important finding right now
4. **Context Cards** — Nine lifestyle cards covering what your GP typically doesn't ask
5. **Menstrual Cycle** — Cycle tracking and phase-aware interpretation (female profiles only)
6. **Supplements** — Your supplement and medication timeline
7. **Key Trends** — Line charts for each biomarker category
8. **Trends & Alerts** — Automatically detected changes and critical flags
9. **Data & Notes** — Your raw entries, standalone notes, and export options

::: tip
The dashboard only shows markers that have actual data from your lab results. Markers in the schema that you have never imported are hidden from the sidebar count and charts.
:::

## Sidebar Navigation

The sidebar on the left lists all biomarker categories (Biochemistry, Hormones, Lipids, Hematology, etc.). Each category shows a count of how many markers have actual data. Click any category to jump to its charts.

On tablets and smaller screens (below 1024px), the sidebar becomes a slide-out menu accessed via the hamburger button in the header. Tap a category to navigate and the sidebar closes automatically.

## Date Range Filter

Use the date range control in the header to zoom into a specific period. All charts, trend alerts, and the correlation view respond to whatever range you set. Narrowing the range is useful when you want to examine a specific health event or treatment period.

::: tip
Trend alerts and flagged markers also respect the date range filter — tightening the range can help you isolate patterns from a particular time window.
:::

## Context Cards

The nine context cards sit in a grid under the heading "What your GP won't ask you." They cover:

- Health Goals
- Medical Conditions
- Diet & Digestion
- Exercise
- Sleep & Rest
- Light & Circadian
- Stress
- Love Life & Relationships
- Environment

Each card shows a summary of what you've entered, a colored health-status dot (AI-rated green / yellow / red), and a brief AI-generated tip. Click any card to open its editor. The header shows how many cards you have filled, for example "5/9 filled."

An **Additional Notes** text area below the cards lets you add free-form context that the AI will consider in every response. It saves automatically as you type.

## Focus Card

When an AI provider is configured, the Focus Card appears just above the context cards. It shows a single sentence — the most actionable observation the AI can make based on your current lab data and lifestyle context. The card is cached and only regenerates when your data or context changes.

## Trends & Alerts

This section appears below the charts. Trend alerts come first (rising or falling patterns), followed by critical flags for markers that have gone significantly out of range. See [Trend Alerts](./trend-alerts.md) for a full explanation of how these are detected.
