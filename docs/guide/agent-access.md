# Agent Access

Agent Access is an opt-in feature that lets AI agents query your lab data — coding agents (Claude Code, Cursor), messenger bots (Hermes Agent, OpenClaw), or any MCP-compatible tool. The agent pulls your latest lab context from getbased to answer questions like "how's my iron trending?" or "what changed since my last draw?"

Only a read-only text summary is shared. Your raw data and sync mnemonic never leave your browser.

## How It Works

```
getbased (browser)  ──saves context──▶  Context Gateway  ◀──queries with token──  AI agent (Claude Code, Hermes, etc.)
```

1. You enable **Agent Access** in getbased and receive a read-only token
2. getbased pushes a pre-built text summary of your labs, context cards, supplements, goals, and notes to the context gateway
3. Your AI agent uses the token to read that summary and answer questions

The gateway stores only the same assembled text context that the in-app AI chat uses — no raw data, no database access, no mnemonic. The summary is refreshed automatically whenever you save changes in getbased.

## Setup

### 1. Enable Agent Access

1. Open **Settings → Data → Agent Access**
2. Toggle it **on**
3. A read-only token is generated and displayed

Copy the token — you will paste it into your agent's configuration.

### 2. Connect your agent

Paste the token into whichever tool you use to run your AI agent. See [Compatible Tools](#compatible-tools) below for specific instructions.

### 3. Query

Ask your agent anything about your labs. It reads your latest context from the gateway and responds.

::: tip Token visibility
The token is masked by default in Settings. Click **Show** to reveal it, or **Copy** to put it on your clipboard. The clipboard is cleared after 60 seconds.
:::

## Multi-Profile Support

If you track labs for multiple people (yourself, a partner, a parent), each profile's context is stored separately on the gateway. Bots can query by profile ID to pull the right person's data.

- When you save context, getbased pushes each profile's summary under its own ID
- The bot's `getbased_list_profiles` tool returns all available profiles with their names
- The bot's `getbased_lab_context` tool accepts an optional profile ID parameter — if omitted, it returns the active profile

Switch to the profile you want to update in getbased, make your changes, and the gateway receives that profile's latest context automatically.

## Compatible Tools

Agent Access works with any agent that can call the context gateway's API using your token. The universal adapter is the [**getbased-agent-stack**](https://github.com/elkimek/getbased-agents) — one install covers the MCP adapter, a local RAG knowledge server, and a browser dashboard for setup.

### Install

Linux, one command:

```bash
curl -sSL https://getbased.health/install.sh | bash
```

Runs `pipx install --include-deps "getbased-agent-stack[full]"` (or the uv equivalent) and starts the RAG server + browser dashboard as systemd user services. See the [Interpretive Lens guide](./interpretive-lens.md#external-server) for the full one-shot flow including the hash-verification path.

macOS / Windows / manual:

```bash
pipx install --include-deps "getbased-agent-stack[full]"
# --include-deps is required — without it, the MCP / rag / dashboard
# binaries from the bundled dependencies aren't exposed on your PATH
getbased-stack init --yes   # scaffolds config + starts services where supported
```

Add it to your agent's MCP config with your token. Works with any MCP-compatible agent — Claude Code, Claude Desktop, Cursor, Cline, Windsurf, [Hermes Agent](https://github.com/hermes-agent/hermes-agent), [OpenClaw](https://openclaw.ai), and more. The dashboard (at `http://127.0.0.1:8323` after `install.sh` or `getbased-dashboard serve`) generates paste-ready config blocks for every client, no manual YAML/JSON authoring needed.

(If you only want the MCP adapter without the RAG server, `pipx install getbased-mcp` is a smaller ~10 MB alternative.)

### Hermes Agent example

[Hermes Agent](https://github.com/hermes-agent/hermes-agent) is a self-hosted AI assistant with built-in support for Matrix, Telegram, Signal, Discord, and other messengers. Configure getbased-mcp in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  getbased:
    command: getbased-mcp
    args: []
    env:
      GETBASED_GATEWAY: https://sync.getbased.health
      GETBASED_TOKEN: your-token
```

Then restart the gateway: `hermes gateway restart`

getbased-mcp provides these tools:

| Tool | Description |
|---|---|
| `getbased_lab_context` | Full lab summary — values, ranges, trends, context cards, supplements, goals |
| `getbased_section` | Query a specific section (hormones, biometrics, etc.) or list available sections |
| `getbased_list_profiles` | List all profiles by name and ID |
| `knowledge_search` | Semantic search over your knowledge base. Requires a lens RAG server (default: `http://127.0.0.1:8322`, configurable via `LENS_URL`). Degrades gracefully — the lab-context tools keep working even if no RAG server is reachable. |
| `knowledge_list_libraries` | List all libraries on the RAG server with their ids + which is active |
| `knowledge_activate_library` | Switch the active library. Subsequent searches target the new one. |
| `knowledge_stats` | Per-source chunk counts for the active library — useful for diagnosing missing results |
| `getbased_lens_config` | Show the Custom Knowledge Source endpoint + key from getbased, so the agent can stay in sync with what the PWA is configured to query. |

### Wearable data (HRV, RHR, sleep, recovery)

If you have wearables connected (Oura, Polar, WHOOP, Fitbit, Withings, Ultrahuman, Apple Health, or manual entries) and the **Settings → AI → AI Context → Include wearable data** toggle is on, the agent automatically receives a `[section:wearables]` block in `getbased_lab_context`. Format: ~200 tokens — current value, baseline, weekly trend, and recent anomaly events for each metric.

To pull just the wearables section:

```
getbased_section('wearables', profile='Main')
```

#### 30-day daily series (opt-in, ~400 tokens)

For time-series reasoning ("did HRV drop the week before I got sick?"), the always-on summary isn't enough. Open **Settings → Agent Access** and turn on **"Push 30-day wearable series"**. The browser then writes a pivoted matrix into a separate section:

```
getbased_section('wearables-series-30d', profile='Main')
```

Output shape:

```
[section:wearables-series-30d]
## Wearables — 30-day daily series (oldest→newest, "—" = no reading)
HRV (🌙) ms (oura): —→—→…→37→36→27→33→26→32→30→26→32→33→29→33→37→39→38→43→30
Resting HR bpm (oura): 64→62→61→…→59
Heart rate (☀️) bpm (oura): 88→91→92→…→78
Sleep (score) (oura): 68→72→75→…→72
Readiness (score) (oura): 58→61→63→…→69
Steps (oura): 7800→8200→…→4250
[/section:wearables-series-30d]
```

One line per metric. Primary source in parens. `→` separates daily values, oldest first. `—` means no reading on that day. Values are rounded to 1 decimal place to keep token cost down.

**Privacy.** Raw daily samples never sync via Evolu — they live in the browser's local IndexedDB only. The browser renders the section string and posts it to the gateway, which is content-blind. OAuth tokens are still stripped by the same path the regular sync uses (`stripWearableCredentials`).

**Cost.** Live-measured at 30 days × 13 metrics: ~400 tokens. Prompt caching keeps the marginal per-turn cost ~10× cheaper than naïve since wearable data only changes ~once/day on overnight sync.

**Toggle re-pushes immediately**, so the agent sees the new (or removed) section the next time it queries — no 5-second debounce wait.

## Security

Agent Access is designed to share the minimum needed for a bot to be useful:

- **Read-only token** — the token grants access to a pre-built text summary only. No writes, no database queries, no mutations
- **No raw data exposed** — the gateway stores the same assembled context the in-app AI chat uses, not your underlying lab entries or personal records
- **Mnemonic never leaves your browser** — the sync mnemonic is a separate system. Agent Access does not use or transmit it
- **Revocable at any time** — toggle Agent Access off in Settings to immediately invalidate the token. You can also click **Regenerate** to create a new token, which invalidates the old one
- **Self-hostable** — the context gateway runs on the same server as the [sync relay](./cross-device-sync.md#running-your-own-relay). Self-host both for full control over where your summary is stored

::: warning
Your token grants access to your lab summary. Treat it like a password — do not share it publicly or commit it to a public repository.
:::

## Troubleshooting

### Bot sees the wrong profile

The gateway serves whichever profiles have been pushed. If the bot returns data for the wrong person:

1. Open getbased and switch to the correct profile
2. Make any edit and save (or toggle Agent Access off and back on) to force a fresh push
3. Ask the bot again — use the profile ID parameter if you have multiple profiles

### Bot returns stale data

The gateway is updated whenever you save changes in getbased. If the bot's answers seem outdated:

1. Confirm **Agent Access** is still toggled on in **Settings → Data**
2. Open getbased in your browser — the push happens from the browser, so it needs to be open at least once after your latest changes
3. Check your network connection — the push requires internet access to reach the gateway

### Token not working

- Make sure you copied the full token (no trailing spaces)
- Check that Agent Access is still enabled — disabling it invalidates the token
- If you clicked **Regenerate**, update your bot config with the new token — the old one no longer works

### Bot cannot reach the gateway

If you self-host the gateway, verify that:

- The gateway server is running and accessible from the bot's network
- Your bot config points to the correct gateway URL (e.g., `https://sync.yourdomain.com`)
- TLS is configured correctly — the bot needs HTTPS access
