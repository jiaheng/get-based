# OpenClaw

[OpenClaw](https://openclaw.ai) is a self-hosted AI assistant you can connect to any messenger (Telegram, Signal, Discord, etc.). It connects to getbased via [getbased-mcp](https://github.com/elkimek/getbased-agents/tree/main/packages/mcp), letting your OpenClaw bot answer questions about your blood work — "what's my vitamin D trend?" or "summarize my last labs" — directly in chat.

Only a read-only summary is shared. Your raw data and sync mnemonic never leave your browser.

## How It Works

```
getbased (browser) → Context Gateway ← getbased-mcp ← OpenClaw bot
```

1. You enable **Agent Access** in getbased and get a read-only token
2. getbased pushes a text summary of your labs, context cards, supplements, and goals to the context gateway
3. Your OpenClaw bot uses getbased-mcp with the token to read that summary and answer questions

## Setup

### 1. Enable in getbased

Go to **Settings → Data → Agent Access** and toggle it on. A read-only token is generated.

### 2. Install getbased-mcp

```bash
git clone https://github.com/elkimek/getbased-agents.git
cd getbased-agents/packages/mcp
pip install .
```

### 3. Configure OpenClaw

Add getbased-mcp as an MCP server in your OpenClaw config with your token and gateway URL.

### 4. Chat

Ask your bot anything about your labs. The MCP server provides three tools the AI can use:

- **getbased_lab_context** — full lab summary with values, ranges, trends, context cards, supplements, and goals
- **getbased_section** — query a specific section (hormones, biometrics, etc.) or list available sections
- **getbased_list_profiles** — list all profiles (if you track multiple people)

## Security

- The token grants **read-only** access to a pre-built text summary
- Your sync mnemonic is never shared
- Revoking the token (toggle off or regenerate) immediately cuts access
- The context gateway runs on the same server as the sync relay — self-host both for full control

## Self-Hosting

The context gateway is a lightweight Node.js server. If you [self-host your sync relay](./cross-device-sync.md#running-your-own-relay), the gateway runs alongside it on the same VPS.
