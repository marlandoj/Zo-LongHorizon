# Setting up the Zo MCP server

Every bridge-hosted run reaches Zo through one HTTP MCP endpoint:

```
https://api.zo.computer/mcp          Streamable HTTP, ~100 tools
Authorization: Bearer <access token>
```

That endpoint is what lets a harness send email, text you, read files, edit automations,
or publish a page while it owns the loop. This page covers getting a token, storing it so
detached processes can read it, and wiring it into each harness.

## 1. Create an access token

In Zo, open **Settings → Advanced → Access Tokens** and create a token for MCP access.
Copy it once; Zo will not show it again.

Use an access token, not `ZO_CLIENT_IDENTITY_TOKEN`. The identity token that appears inside
a Zo turn is session-scoped: it works in a quick test and then stops working in a scheduled
run hours later.

## 2. Store it as a secret named `ZO_MCP_API_KEY`

In **Settings → Advanced → Secrets**, add `ZO_MCP_API_KEY` with the token as its value.

Zo writes secrets to `/root/.zo_secrets` on the host. A detached bridge inherits nothing
from the Zo turn that launched it, so `harness-detached.sh` loads that file itself before
starting any harness:

```bash
set -a; . /root/.zo_secrets; set +a
```

Run the same line in your own shell before using any script in this kit.

## 3. Check the endpoint directly

```bash
set -a; . /root/.zo_secrets; set +a
curl -s -X POST https://api.zo.computer/mcp \
  -H "Authorization: Bearer $ZO_MCP_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -c 300
```

A healthy reply lists tools. Two things to know:

- The `Bearer ` prefix is required. The bare token does not authenticate.
- A cold endpoint can take 20–30 s to answer the first request; warm, `tools/list` returns
  in 1–5 s. A timeout on the very first probe is not a configuration fault — retry once.

`python3 scripts/preflight.py` runs an equivalent probe through the kit's own client.

## 4. Wire it into every harness

```bash
python3 scripts/configure-zo-mcp.py                  # plan: add / unchanged / differs per harness
python3 scripts/configure-zo-mcp.py --apply --verify # write, read back, run each harness's status check
python3 scripts/smoke-harnesses.py                   # prove a real Zo tool call through each harness
```

`configure-zo-mcp.py` never inlines the token. Every entry references `ZO_MCP_API_KEY` by
name, so rotating the token is a secret update and nothing else. It keeps a backup of every
file it changes under `Backups/harness-mcp/<timestamp>/`, and leaves an existing `zo` entry
that differs alone unless you pass `--force` — it flags one that has the token pasted in.

The status checks (`--verify`) only prove the harness can list the server. The smoke test is
the real proof: each harness runs detached, calls `get_space_settings`, and must print the
site title it got back.

### What the script writes

If you prefer to edit by hand, these are the exact entries.

**Claude Code** — `/home/workspace/.mcp.json` (project scope; Kimi also reads this file)

```json
{
  "mcpServers": {
    "zo": {
      "type": "http",
      "url": "https://api.zo.computer/mcp",
      "headers": { "Authorization": "Bearer ${ZO_MCP_API_KEY}" },
      "bearerTokenEnvVar": "ZO_MCP_API_KEY"
    }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`

```toml
[mcp_servers.zo]
url = "https://api.zo.computer/mcp"
bearer_token_env_var = "ZO_MCP_API_KEY"
startup_timeout_sec = 90
tool_timeout_sec = 180
```

**Gemini CLI** — `~/.gemini/settings.json`

```json
{
  "mcpServers": {
    "zo": {
      "url": "https://api.zo.computer/mcp",
      "type": "http",
      "headers": { "Authorization": "Bearer ${ZO_MCP_API_KEY}" },
      "trust": true,
      "timeout": 180000
    }
  }
}
```

**Kimi Code CLI** — `~/.kimi-code/mcp.json`

```json
{
  "mcpServers": {
    "zo": {
      "url": "https://api.zo.computer/mcp",
      "bearerTokenEnvVar": "ZO_MCP_API_KEY",
      "startupTimeoutMs": 180000,
      "toolTimeoutMs": 180000
    }
  }
}
```

**OpenCode CLI** — `~/.config/opencode/opencode.jsonc`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "zo": {
      "type": "remote",
      "url": "https://api.zo.computer/mcp",
      "enabled": true,
      "timeout": 60000,
      "headers": { "Authorization": "Bearer {env:ZO_MCP_API_KEY}" }
    }
  }
}
```

**Hermes Agent** — `~/.hermes/config.yaml`

```yaml
mcp_servers:
  zo:
    url: https://api.zo.computer/mcp
    headers:
      Authorization: Bearer ${ZO_MCP_API_KEY}
    timeout: 180
    connect_timeout: 60
```

**Pi Coding Agent** — `~/.pi/agent/mcp.json`, plus `npm install -g pi-mcp-adapter@2.15.0`

```json
{
  "mcpServers": {
    "zo": {
      "url": "https://api.zo.computer/mcp",
      "headers": { "Authorization": "Bearer ${ZO_MCP_API_KEY}" }
    }
  }
}
```

Pi has no built-in MCP client. The bridge runner loads the adapter with
`--extension $(npm root -g)/pi-mcp-adapter/index.ts` on every run, so Pi's own settings are
never modified. An interactive `pi` session has Zo tools only if you load the adapter the
same way or install it with `pi install npm:pi-mcp-adapter`.

## Token forms differ, and it matters

| Harness | Reads the token via | Pitfall |
|---|---|---|
| Claude Code | `${VAR}` in `headers` | none |
| Codex | `bearer_token_env_var` | default 10 s startup timeout drops a cold server silently |
| Gemini | `${VAR}` in `headers` | none |
| Kimi | `bearerTokenEnvVar` | does **not** expand `${VAR}` in headers — it would send the literal text and get 401 |
| OpenCode | `{env:VAR}` in `headers` | its syntax, not `${VAR}`; default 5 s tool-fetch timeout is too short |
| Hermes | `${VAR}` in `headers` | none |
| Pi | `${VAR}` in `headers` | needs the adapter at all |

## Troubleshooting

**The server lists as connected, but the agent says the tool is not available.** The
harness connected after the model had already started, or gave up on a slow first
`tools/list`. Raise the harness's startup timeout (the values above already do) and re-run
the smoke test. Codex and OpenCode both showed this before their timeouts were raised.

**`MCP error -32603 … snapshot_failed`.** A Zo host lifecycle fault, not your config. It
passes on its own; retry the run. A harness that loses Zo mid-task may fall back to local
tools — Gemini once answered by grepping the whole workspace and overran its context —
which is one more reason to judge runs by outcome and delivered evidence.

**Claude Code uses a different entry than `.mcp.json`.** A `zo` entry at local scope in
`~/.claude.json` outranks the project file. Zo's own platform integration may write one with
a literal token. Check with `claude mcp get zo`; the `.mcp.json` entry remains the
rotation-safe fallback.

**401 from every harness at once.** The token was rotated or revoked. Update the
`ZO_MCP_API_KEY` secret; no config file needs to change.
