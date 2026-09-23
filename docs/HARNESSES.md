# Harnesses

The bridge treats every agent CLI the same way: launch it once, headless, with approvals
off, in a new session that outlives the Zo turn, and let it reach Zo over MCP. The facts
that differ per harness live in `harnesses/harnesses.json`; every script in this kit reads
that file, so adding a harness means one registry entry and one `case` line in
`assets/harness-detached.sh`.

## The seven

| Harness | Install | Headless invocation the runner uses | Model variable |
|---|---|---|---|
| `claude` — Claude Code | `npm i -g @anthropic-ai/claude-code` | `claude -p <prompt> --output-format text --dangerously-skip-permissions --model <m>` | `CLAUDE_CODE_MODEL` (default `claude-opus-5`) |
| `codex` — Codex CLI | `npm i -g @openai/codex` | `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --color never [-m <m>] <prompt>` | `CODEX_MODEL` |
| `gemini` — Gemini CLI | `npm i -g @google/gemini-cli` | `gemini -p <prompt> [-m <m>] --yolo --sandbox=false --output-format text` | `GEMINI_MODEL` |
| `kimi` — Kimi Code CLI | `npm i -g @moonshot-ai/kimi-code` | `kimi --prompt <prompt> [-m <m>]` | `KIMI_MODEL` |
| `opencode` — OpenCode CLI | `npm i -g opencode-ai` | `opencode run --auto [-m <provider/model>] <prompt>` with `OPENCODE_CONFIG_CONTENT={"snapshot":false}` | `OPENCODE_MODEL` |
| `hermes` — Hermes Agent | `pip install git+https://github.com/NousResearch/hermes-agent.git` | `hermes chat -Q --yolo [--provider <p>] [-m <m>] -q <prompt>` | `HERMES_MODEL`, `HERMES_PROVIDER` |
| `pi` — Pi Coding Agent | `npm i -g @earendil-works/pi-coding-agent pi-mcp-adapter@2.15.0` | `pi --print --no-session --approve --model <m> --extension <npm-root>/pi-mcp-adapter/index.ts <prompt>` | `PI_MODEL` (default `openrouter/moonshotai/kimi-k3`) |

`BRIDGE_MODEL` overrides the per-harness variable for any harness. With no model set, a
harness uses the default in its own config. `scripts/install-harnesses.py --apply` installs
whichever are missing; it does not log them in.

## Authentication is per harness

Installing a binary does not give it a model. Each harness authenticates to its own
provider, and a detached run needs that credential to be available without a person at the
keyboard:

| Harness | Unattended credential |
|---|---|
| Claude Code | `claude login` (subscription, stored in `~/.claude`) or `ANTHROPIC_API_KEY` |
| Codex | `codex login` (ChatGPT plan, stored in `~/.codex/auth.json`) or `OPENAI_API_KEY` |
| Gemini | `GEMINI_API_KEY`, or a cached Google login in `~/.gemini` |
| Kimi | `kimi login` or `KIMI_API_KEY` |
| OpenCode | `opencode auth login` (stored in `~/.local/share/opencode/auth.json`) |
| Hermes | `hermes setup`; provider keys such as `OPENROUTER_API_KEY` |
| Pi | a provider key Pi supports, e.g. `OPENROUTER_API_KEY`, or `~/.pi/agent/auth.json` |

Put API keys in Zo's Secrets page. The runner sources `/root/.zo_secrets` before it starts
the harness, so a key stored there reaches every detached run.

## What each harness needed to run unattended

Every one of these was found by running the harness detached against a real Zo MCP call,
not by reading its docs.

- **Claude Code** refuses `--dangerously-skip-permissions` as root unless `IS_SANDBOX=1`.
  A Zo host runs everything as root. The runner exports it for every harness.
- **Codex** connected to the zo server but reported the tool "not available" until its MCP
  startup timeout was raised from the 10 s default to 90 s. The first `tools/list` against
  a cold endpoint takes longer than that.
- **Gemini** works with its own default model; pinning a retired model name returns 404, so
  the runner passes `-m` only when you set one.
- **Kimi** rejects `--auto` alongside `--prompt`. Prompt mode is already non-interactive.
  Kimi Code has no `mcp` subcommand; `kimi doctor` validates its config instead.
- **OpenCode** answered correctly and then did not exit for seven minutes: after each turn
  it git-snapshots the working directory, which on a large workspace is effectively
  unbounded. `{"snapshot": false}` fixes it (34 s end to end). Its 5 s default tool-fetch
  timeout is also too short for a cold Zo endpoint; the config sets 60 s.
- **Hermes** `-z` one-shot mode prints only "no final response was produced" whatever the
  cause. `chat -Q -q` surfaces the provider's actual error, so the runner uses it.
- **Pi** ships without MCP by design. The runner loads `pi-mcp-adapter` with `--extension`
  from the global npm root, and the adapter reads the `zo` entry from `~/.pi/agent/mcp.json`
  (or a project `.mcp.json`).

## Proving a host

```bash
set -a; . /root/.zo_secrets; set +a
python3 scripts/install-harnesses.py                 # what is installed, and at what version
python3 scripts/configure-zo-mcp.py --apply --verify # zo MCP in every config
python3 scripts/smoke-harnesses.py                   # a real Zo tool call through each one
```

A harness passes the smoke test only when it exits 0 and its transcript contains `ZO_OK`
followed by the site title — a value it can get only by completing the MCP call.

Reference run on the host this kit was built on (2026-09-23): Claude Code, Codex, Gemini,
Kimi, OpenCode, and Pi passed in 15–25 s each. Hermes reached its providers but every one
configured on that host refused the request for billing reasons (Anthropic extra usage
exhausted, OpenRouter 401, DeepSeek 402), so its Zo MCP call was not exercised end to end
there; `hermes mcp test zo` does connect and list the tools.

## Registering harnesses as Zo personas

```bash
python3 scripts/register-personas.py                                   # plan
python3 scripts/register-personas.py --apply --model codex=byok:<full-uuid>
```

Creates one persona per installed harness from `harnesses/persona-template.md`, with tool
scope `all`. Existing personas are matched by name (and by aliases such as `Hermes`) and
left alone.

The model pointer is the one step the script cannot do. Zo has no tool for adding a model
provider: connect Claude Code or Codex under **Settings → AI → Providers**, add other
harnesses as a Bring-Your-Own-Key provider, then pass the resulting `byok:<uuid>` with
`--model`. A persona created without one runs on Zo's default model until you set it in
**Settings → AI → Personas**.

A persona governs chat. Scheduled work does not need one — the harness is chosen by
`--harness` on the automation's launcher line, and it runs under its own credentials.
