# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run

```bash
npm run build          # tsc -> dist/
npm run dev            # tsx src/index.ts (hot reload watches config.yaml)
npm start              # node dist/index.js
npm test               # vitest run
npm run test:watch     # vitest (watch mode)
```

Tests live in `tests/` and use vitest (config: `vitest.config.ts`, pattern: `tests/**/*.test.ts`). No linter is configured.

## Architecture

AgentCliBridge bridges CLI-based AI tools (`claude`, `codex`, `gemini`) to chat platforms (Telegram, Discord). It spawns the CLI as a subprocess with JSON streaming and parses the output. No SDK dependency.

### Provider Abstraction

The system uses a provider pattern (`src/providers/`) to support multiple CLI backends:

- `claude.ts` — Claude CLI with `--output-format stream-json`
- `codex.ts` — OpenAI Codex CLI with `--full-auto` JSON output
- `gemini.ts` — Google Gemini CLI with `--output-format stream-json`
- `registry.ts` — Maps provider names to implementations
- `base.ts` — Provider interface contract

Endpoints in `config.yaml` specify `provider: "claude"`, `provider: "codex"`, or `provider: "gemini"`. Agent (`src/core/agent.ts`) delegates to the provider for arg building, env setup, and stream parsing.

### Dispatcher Architecture (Multi-Session)

Each user has a single **Dispatcher** (master session) that routes messages to sub-sessions:

- `src/core/router.ts` — Dispatcher: fast path ($0) for 0-1 sessions, Claude-powered classification with memories + session summaries for 2+ sessions
- `src/core/session.ts` — SessionManager: sub-session lifecycle (create, close, expire, track messages, summaries)
- `src/core/lock.ts` — `SessionLock`: per-session concurrency mutex (Redis primary, in-memory fallback, 5min TTL)

### Skill System

Instead of hardcoded commands, `src/skills/bridge.ts` generates a bilingual skill document injected into the system prompt via `--append-system-prompt`. Claude calls `agent-cli-bridge-ctl` (`src/ctl.ts`) through Bash to manage memories, tasks, reminders, and auto-tasks. `allowed_tools` must include `Bash` for this to work.

### Key Data Flow

1. Adapter receives message → `AccessControl.isAllowed(userId)`
2. Platform `/commands` or `!commands` handled directly by adapter
3. All other text → Dispatcher routes to correct sub-session (or creates one)
4. Acquires `SessionLock` (per-session, allows concurrent sub-sessions per user)
5. Agent builds `--append-system-prompt` with memories + skill doc
6. Agent spawns CLI subprocess via provider, streams response back
7. Adapter edits message every ~1.5s with partial text
8. On completion: save session_id, record cost, save history, sync summary

### File Structure

```
src/
  index.ts                Entry: config loading, adapter startup, hot reload, signal handlers
  cli.ts                  CLI binary (agent-cli-bridge / acb): start/stop/status/reload/init with PID/daemon
  ctl.ts                  CLI tool (agent-cli-bridge-ctl / acb-ctl): standalone SQLite ops (memory/task/reminder/auto)
  webhook.ts              HTTP server + GitHub webhooks (HMAC-SHA256) + cron scheduler
  core/
    agent.ts              Spawns provider CLI subprocess, session dispatch, auto-summarize
    config.ts             YAML config loader with env var fallback (re-exports from schema.ts)
    schema.ts             Zod schema definitions for all config types
    keys.ts               Simple round-robin endpoint rotation (no cooldown)
    lock.ts               SessionLock: per-session mutex (Redis or in-memory)
    store.ts              SQLite (WAL): sessions, usage, history, memories, tasks, sub_sessions
    router.ts             Dispatcher: message routing via fast-path or Claude classifier
    session.ts            SessionManager: sub-session lifecycle
    permissions.ts        Whitelist access control (users + groups)
    markdown.ts           Markdown → Telegram MarkdownV2
    i18n.ts               Internationalization (en/zh)
    logger.ts             Structured JSON logger: file rotation, request tracing (rid), duration metrics, sensitive field redaction
  providers/
    base.ts               Provider interface (ProviderStreamEvent, ProviderExecOpts)
    claude.ts             Claude CLI provider
    codex.ts              OpenAI Codex CLI provider
    gemini.ts             Google Gemini CLI provider
    registry.ts           Provider name → implementation mapping
  skills/
    bridge.ts             Bilingual skill document generator
  adapters/
    base.ts               Adapter interface + chunkText() (code-block-aware splitting)
    telegram.ts           Raw Telegram Bot API (fetch, long polling, inline buttons, file sends)
    discord.ts            discord.js (@mentions, DMs, approval commands, file sends)
```

### Config

Primary config: `config.yaml` (gitignored; template: `config.yaml.example`). Supports multiple endpoints with provider selection, agent settings, workspace isolation, platform toggles, webhook/cron, and access whitelist. `.env` is fallback for single-endpoint setup.

### Conventions

- ES Modules (`"type": "module"`, ESNext module target, bundler resolution)
- Structured JSON logging via `logger.ts` (not console.log)
- File uploads → `workspaces/<userId>/` for per-user isolation
- Telegram adapter uses raw fetch (not grammy, despite it being a dependency)
- SQLite WAL mode + `busy_timeout=5000` for concurrent access between bridge and ctl
- `ctl.ts` reads `AGENT_CLI_BRIDGE_DB` env var, outputs JSON to stdout, errors to stderr with exit 1
