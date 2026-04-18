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

Agent Access works with any agent that can call the context gateway's API using your token. The universal adapter is [getbased-mcp](https://github.com/elkimek/getbased-mcp) — an MCP server that exposes your lab context as tools.

### getbased-mcp

```bash
git clone https://github.com/elkimek/getbased-mcp.git
cd getbased-mcp
pip install .
```

Add it to your agent's MCP config with your token and gateway URL. Works with any MCP-compatible agent — Claude Code, Cursor, Windsurf, [Hermes Agent](https://github.com/hermes-agent/hermes-agent), [OpenClaw](https://openclaw.ai), and more.

### Hermes Agent example

[Hermes Agent](https://github.com/hermes-agent/hermes-agent) is a self-hosted AI assistant with built-in support for Matrix, Telegram, Signal, Discord, and other messengers. Configure getbased-mcp in `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  getbased:
    command: python3
    args:
      - /path/to/getbased_mcp.py
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
| `knowledge_search` | Semantic search over your knowledge base. Requires [getbased-rag](https://github.com/elkimek/getbased-rag) running locally (the same backend the PWA's External server lens points at). Degrades gracefully — if no RAG server is reachable, the lab-context tools still work. |
| `getbased_lens_config` | Show the Custom Knowledge Source endpoint + key from getbased, so the agent can stay in sync with what the PWA is configured to query. |

::: tip
The `knowledge_search` tool and the PWA's **Settings → AI → Knowledge Base → External server** backend both query the same `getbased-rag` server over HTTP. Running one RAG backend lets you ground answers from both your browser chats AND your MCP agents (Claude Desktop, Hermes, Cursor) in the same document corpus.
:::

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
