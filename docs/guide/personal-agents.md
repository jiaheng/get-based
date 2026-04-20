# Personal Agents

A personal agent is an AI assistant that lives outside the getbased browser tab — on your laptop, in your messenger, or on a self-hosted server — and answers questions about your labs using the same context the in-app chat sees. "What's my vitamin D trend?" in Telegram, "summarize my last labs" in Claude Code, or a scheduled "alert me if my hs-CRP goes above 1.0" on Hermes.

Everything runs over [**Agent Access**](./agent-access.md) — a read-only token gates what agents can see. No raw data leaves the browser, no sync mnemonic is shared.

## Supported agents

Any client that speaks the [Model Context Protocol](https://modelcontextprotocol.io) works. Tested & documented with:

- **[Hermes Agent](https://github.com/hermes-agent/hermes-agent)** — self-hosted messenger bot (Matrix, Telegram, Signal, Discord, WhatsApp). Persistent, schedule-aware.
- **[OpenClaw](https://openclaw.ai)** — self-hosted AI assistant you wire into any messenger.
- **[Claude Code](https://claude.ai/code)** — CLI agent for terminal workflows
- **[Claude Desktop](https://claude.ai/download)** — native MacOS/Windows app
- **[Cursor](https://cursor.sh)**, **[Cline](https://cline.bot)**, **[Windsurf](https://codeium.com/windsurf)** — IDE-integrated agents

Any other MCP client works too — the adapter is client-agnostic.

## How It Works

```
getbased (browser) ──► Context Gateway ──► your agent (via MCP)
                       (text summary)       (read-only)
```

1. You toggle **Agent Access** in getbased Settings → Data. A read-only token is minted.
2. getbased pushes a text summary of your labs, context cards, supplements, and goals to the context gateway on every save.
3. Your agent (Hermes, OpenClaw, Claude Code, …) uses the `getbased-agent-stack` adapter with your token to read that summary and answer questions.

## Setup

### 1. Enable in getbased

Go to **Settings → Data → Agent Access** and toggle it on. A read-only token is generated — copy it.

### 2. Install the agent stack

Linux, one command:

```bash
curl -sSL https://getbased.health/install.sh | bash
```

Installs the MCP adapter, the local RAG knowledge server, and the browser setup dashboard; starts the latter two as systemd user services. [Read the script first](https://github.com/elkimek/get-based-site/blob/main/install.sh) if you prefer to audit before running — the [Interpretive Lens guide](./interpretive-lens.md#external-server) lists the `sha256sum -c` verification command.

macOS / Windows / WSL1, or prefer a manual path:

```bash
pipx install --include-deps "getbased-agent-stack[full]"
# or with uv:
# uv tool install --with-executables-from getbased-rag \
#                 --with-executables-from getbased-dashboard \
#                 --with-executables-from getbased-mcp \
#                 "getbased-agent-stack[full]"
getbased-stack init --yes      # writes config, generates API key
```

If you only want the MCP adapter and nothing else (no RAG), `pipx install getbased-mcp` is a smaller ~10 MB alternative.

### 3. Generate client config

Launch the dashboard (or open it via the one-click login URL the installer prints at the end) and copy a paste-ready config block for your client:

```bash
# Already running via systemd after install.sh — visit http://127.0.0.1:8323
# Manual install? run:
getbased-dashboard serve       # http://127.0.0.1:8323
```

Open it in a browser, paste your bearer key at the auth gate, switch to the **MCP** tab, pick your client from the dropdown (Claude Desktop / Claude Code / Cursor / Cline / Hermes / OpenClaw), click **copy**. Paste into the client's config file (path shown in the dashboard).

Click **Run test** to verify the adapter spawns correctly before switching to your agent.

### 4. Chat

In your agent, ask anything about your labs. The adapter exposes these tools:

| Tool | Purpose |
|---|---|
| `getbased_lab_context` | Full lab summary — values, ranges, trends, context cards, supplements, goals |
| `getbased_section` | One specific section (hormones, biometrics, etc.) or the section index |
| `getbased_list_profiles` | List all profiles you track |
| `knowledge_search` | Semantic search over your Knowledge Base — requires the local RAG server running (systemd user service on Linux after `install.sh`, or `lens serve` manually on other platforms). Degrades gracefully when unavailable. |
| `knowledge_list_libraries` | List RAG libraries + which is active |
| `knowledge_activate_library` | Switch the active library for subsequent searches |
| `knowledge_stats` | Per-source chunk counts for diagnosing missing results |
| `getbased_lens_config` | Show the Custom Knowledge Source endpoint + key so the agent stays in sync with what the PWA is configured to query |

## Running a local knowledge base

`getbased-agent-stack[full]` includes `lens serve` — a local RAG server. `install.sh` already starts it as a systemd user service on Linux; on other platforms, run it manually:

```bash
lens serve                   # starts on 127.0.0.1:8322
# ingest via the dashboard's Knowledge tab, or CLI:
lens ingest ~/Documents/research
```

With `lens serve` running, `knowledge_search` is grounded in your own document corpus (research papers, clinical guides, personal notes).

See [Interpretive Lens](./interpretive-lens.md#external-server) for the full RAG setup — including per-library embedding models (MiniLM for speed, BGE-M3 for quality) and connecting the same server to the in-app AI chat via the External server backend.

## Hermes Agent quick-config

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  getbased:
    command: getbased-mcp
    args: []
    env:
      GETBASED_GATEWAY: https://sync.getbased.health
      GETBASED_TOKEN: your-token-here
```

Restart: `hermes gateway restart`. The dashboard's MCP tab generates this exact YAML (with the fields pre-filled) — copy from there to avoid typos.

## Security

- The token grants **read-only** access to a pre-built text summary — no writes, no mutations, no raw data
- Your sync mnemonic is never shared — Agent Access is a separate system
- Revoking (toggle off or regenerate) immediately invalidates the token
- Treat the token like a password — don't commit it to a public repo

## Self-hosting the gateway

The context gateway is a lightweight Node.js server. If you [self-host your sync relay](./cross-device-sync.md#running-your-own-relay), the gateway runs alongside it on the same VPS. All data stays on your own infrastructure.
