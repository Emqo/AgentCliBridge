# AgentCliBridge

<p align="center">
  <a href="#english">English</a> | <a href="#中文">中文</a>
</p>

---

<a name="english"></a>

Bridge CLI-based AI agents (`claude`, `codex`, `gemini`) to chat platforms (Telegram, Discord). Spawns the CLI as a subprocess with JSON streaming — no SDK dependency, just raw CLI power.

## Features

### Core
- **Multi-platform**: Telegram (raw Bot API long polling) + Discord (discord.js)
- **Streaming responses**: Real-time message editing as Claude thinks
- **Multi-endpoint rotation**: Round-robin with auto-cooldown on 429/401/529
- **Session persistence**: SQLite-backed session resume via `-r <session_id>`
- **Per-user workspace isolation**: Each user gets their own working directory
- **File uploads**: Send files to Claude for analysis
- **Access control**: User/group whitelist
- **Hot reload**: Edit `config.yaml`, changes apply instantly
- **i18n**: English + Chinese

### Skill System (v0.2.0+)
Instead of hardcoded commands, AgentCliBridge injects a **skill document** into Claude's system prompt. Claude naturally understands it can manage memories, tasks, reminders, and auto-tasks by calling `agent-cli-bridge-ctl` through the Bash tool. Just talk naturally:

- "remember I like TypeScript" → Claude calls `ctl memory add`
- "remind me in 5 minutes" → Claude calls `ctl reminder add`
- "optimize the whole project" → Claude decomposes into multiple auto-tasks

### v0.5.0: Agent Gateway Features

- **Human-in-the-Loop (HITL)**: Critical tasks require user approval via inline buttons (Telegram) or commands (Discord) before execution
- **Conditional Branching**: Scout pattern — task 1 analyzes, saves results, dynamically creates follow-up tasks with `--parent` linking
- **Webhook Triggers**: HTTP API + GitHub webhooks + cron scheduler — trigger auto-tasks from external systems
- **Parallel Execution**: Multiple `claude` instances running simultaneously (`max_parallel` config)
- **Observability**: `/status` command shows task queue, chain progress, and execution stats

### v0.10.0: Dispatcher Architecture (Master-Worker Sessions)

- **Dispatcher (Master Session)**: Every user has a single dispatcher that receives all messages and routes them to the correct sub-session. Users never interact with sub-sessions directly
- **Intelligent Routing**: Fast path ($0) for 0-1 active sessions; Claude-powered classification with user memories + session summaries for 2+ sessions
- **Session Summaries**: Each sub-session maintains an auto-generated summary, giving the dispatcher context about what each conversation is doing
- **Memory-Aware Dispatch**: Dispatcher sees user memories + all active session summaries when classifying, enabling accurate routing even for ambiguous messages
- **Concurrent Sub-Sessions**: Multiple sub-sessions execute in parallel with per-session locks

## Quick Start

### Global Install (npm)

```bash
npm i -g @emqo/agent-cli-bridge
agent-cli-bridge init              # generate config.yaml from template
# edit config.yaml — set endpoints, tokens, whitelist
agent-cli-bridge start -f          # foreground
agent-cli-bridge start             # background (daemon)
agent-cli-bridge status            # check if running
agent-cli-bridge reload            # hot reload config
agent-cli-bridge stop              # stop daemon
```

Short aliases are also available: `acb` for `agent-cli-bridge`, `acb-ctl` for `agent-cli-bridge-ctl`.

### From Source

```bash
git clone https://github.com/Emqo/AgentCliBridge.git
cd AgentCliBridge
npm install
cp config.yaml.example config.yaml
# edit config.yaml
npm run build
npm start
```

## Configuration

All config lives in `config.yaml` ([full template](config.yaml.example)):

```yaml
endpoints:
  - name: "my-endpoint"
    base_url: ""
    api_key: "sk-..."
    model: "claude-sonnet-4-20250514"

locale: en  # "zh" for Chinese

agent:
  allowed_tools: [Read, Edit, Bash, Grep, Glob, WebSearch, WebFetch]
  permission_mode: "acceptEdits"
  max_turns: 50
  max_budget_usd: 2.0
  max_parallel: 1       # concurrent auto-task execution (1 = sequential)
  timeout_seconds: 300
  memory:
    enabled: true
    auto_summary: true
    max_memories: 50
  skill:
    enabled: true
  session:
    enabled: true
    max_per_user: 3
    idle_timeout_minutes: 30
    dispatcher_budget: 0.05

workspace:
  base_dir: "./workspaces"
  isolation: true

access:
  allowed_users: ["your_user_id"]
  allowed_groups: []

platforms:
  telegram:
    enabled: true
    token: "your-bot-token"
    chunk_size: 4000
  discord:
    enabled: false
    token: ""
    chunk_size: 1900

# Webhook server for external triggers
webhook:
  enabled: false
  port: 3100
  token: "your-bearer-token"
  github_secret: ""

# Scheduled auto-tasks
cron:
  - schedule_minutes: 60
    user_id: "123456"
    platform: "telegram"
    chat_id: "123456"
    description: "Generate daily status report"
```

Leave `endpoints` empty to use `claude` CLI's own authentication.

## Platform Commands

| Telegram | Discord | Action |
|----------|---------|--------|
| /new | !new | Clear session |
| /usage | !usage | Your usage stats |
| /allusage | !allusage | All users stats |
| /history | !history | Recent conversations |
| /model | !model | Endpoint info |
| /status | !status | Auto task status & progress |
| /reload | !reload | Hot reload config |
| /help | !help | Show help |

Discord also supports: `!approve <id>`, `!reject <id>` for HITL approval.

All other interactions are handled naturally by Claude through the skill system — no command prefix needed.

## HITL (Human-in-the-Loop)

When Claude determines a task is critical (deployment, deletion, production changes), it uses `ctl auto add-approval` instead of `ctl auto add`. The task enters `approval_pending` status:

- **Telegram**: Inline keyboard with Approve / Reject buttons
- **Discord**: Bot sends approval request, user replies `!approve <id>` or `!reject <id>`

Only after approval does the task enter the execution queue.

## Conditional Branching (Scout Pattern)

Tasks can be linked via `--parent <id>` to form chains:

```
Task #1 (scout): "Analyze performance bottlenecks"
  → Finds 3 issues, creates child tasks:
  Task #2: "Fix N+1 queries"        (--parent 1)
  Task #3: "Add caching layer"      (--parent 1)
  Task #4: "Run benchmarks"         (--parent 1)
```

Chain progress is reported automatically: `Chain #1 progress: 2/4 done`

Results are persisted via `ctl auto result <id> "summary"` and cross-task context flows through the memory system.

## Webhook & Cron

### HTTP API

```bash
# Health check
curl http://localhost:3100/health

# Create auto-task
curl -X POST http://localhost:3100/api/task \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"123","platform":"telegram","chat_id":"123","description":"analyze logs"}'

# Create approval-required task
curl -X POST http://localhost:3100/api/task \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"123","platform":"telegram","chat_id":"123","description":"deploy to prod","approval":true}'
```

### GitHub Webhooks

```
POST http://your-server:3100/webhook/github?user_id=123&platform=telegram&chat_id=123
```

Configure in GitHub repo Settings → Webhooks. Supports `push`, `pull_request`, `issues` events with HMAC-SHA256 signature verification.

### Cron

```yaml
cron:
  - schedule_minutes: 60
    user_id: "123"
    platform: "telegram"
    chat_id: "123"
    description: "Check server health and report anomalies"
```

## Parallel Execution

Set `max_parallel: N` to run N auto-tasks simultaneously. Each spawns an independent `claude` process with:
- No session sharing (prevents conflicts)
- Shared memories (cross-task context via SQLite)
- Endpoint rotation (distributes load)

```yaml
agent:
  max_parallel: 3  # 3 concurrent claude instances
```

## Architecture

```
src/
  cli.ts                  CLI: start/stop/status/reload/init with PID management
  index.ts                Entry point, config loading, hot reload, webhook startup
  ctl.ts                  agent-cli-bridge-ctl: memory/task/reminder/auto ops via SQLite
  webhook.ts              HTTP server + GitHub webhooks + cron scheduler
  core/
    agent.ts              CLI subprocess spawner via provider system + session summary sync
    config.ts             YAML config with env fallback
    keys.ts               Endpoint round-robin with cooldown
    lock.ts               Per-user/per-session concurrency mutex (Redis or in-memory)
    store.ts              SQLite (WAL): sessions, usage, history, memories, tasks
    router.ts             Dispatcher: message routing with memories + session summaries
    session.ts            Sub-session lifecycle management
    permissions.ts        Whitelist access control
    markdown.ts           Markdown → Telegram MarkdownV2
    i18n.ts               Internationalization (en/zh)
  adapters/
    base.ts               Adapter interface + chunkText utility
    telegram.ts           Telegram Bot API (raw fetch, long polling, inline buttons)
    discord.ts            Discord.js (@mentions + DMs + approval commands)
  skills/
    bridge.ts             Skill document generator (bilingual, injected via --append-system-prompt)
```

### Data Flow

```
User message → Adapter → Access check
                              ↓
                    Dispatcher (master session)
                    ├─ Fast path: 0-1 sessions → direct route ($0)
                    └─ Classify: 2+ sessions → Claude call (memories + summaries)
                              ↓
                    Sub-session execution (per-session lock)
                    ├─ Inject memories + skill doc → spawn claude CLI
                    ├─ Stream response back to adapter
                    └─ Post: save history, sync summary, auto-summarize to shared memory
```

## Prerequisites

- Node.js 18+
- At least one supported CLI installed and authenticated:
  - `claude` CLI ([Claude Code](https://docs.anthropic.com/en/docs/claude-code))
  - `codex` CLI ([OpenAI Codex](https://github.com/openai/codex))
  - `gemini` CLI ([Google Gemini](https://github.com/google-gemini/gemini-cli))
- Telegram bot token (from [@BotFather](https://t.me/BotFather)) and/or Discord bot token

## License

MIT

---

<a name="中文"></a>

# AgentCliBridge

将 CLI AI 代理（`claude`、`codex`、`gemini`）桥接到聊天平台（Telegram、Discord）。通过子进程方式调用 CLI 的 JSON 流式输出，无需 SDK，直接使用 CLI。

## 功能特性

### 核心
- **多平台**：Telegram（原生 Bot API 长轮询）+ Discord（discord.js）
- **流式响应**：Claude 思考时实时编辑消息
- **多端点轮转**：Round-robin，429/401/529 自动冷却切换
- **会话持久化**：SQLite 存储，通过 `-r <session_id>` 恢复会话
- **用户工作区隔离**：每个用户独立工作目录
- **文件上传**：发送文件给 Claude 分析
- **访问控制**：用户/群组白名单
- **热重载**：编辑 `config.yaml` 即时生效
- **国际化**：英文 + 中文

### 技能系统 (v0.2.0+)
无需硬编码命令，AgentCliBridge 将**技能文档**注入 Claude 的系统提示。Claude 自然理解它可以通过 Bash 工具调用 `agent-cli-bridge-ctl` 来管理记忆、任务、提醒和自动任务。直接对话即可：

- "记住我喜欢 TypeScript" → Claude 调用 `ctl memory add`
- "5分钟后提醒我" → Claude 调用 `ctl reminder add`
- "优化整个项目" → Claude 分解为多个自动任务

### v0.5.0：Agent Gateway 特性

- **人机协同 (HITL)**：关键任务需要用户通过内联按钮（Telegram）或命令（Discord）审批后才执行
- **条件分支**：侦查模式 — 任务1分析，保存结果，动态创建后续任务并通过 `--parent` 关联
- **Webhook 触发**：HTTP API + GitHub webhooks + 定时任务 — 从外部系统触发自动任务
- **并行执行**：多个 `claude` 实例同时运行（`max_parallel` 配置）
- **可观测性**：`/status` 命令显示任务队列、链路进度和执行统计

### v0.10.0：Dispatcher 架构（主从会话）

- **Dispatcher（主会话）**：每个用户有一个 Dispatcher 接收所有消息并路由到正确的子会话，用户无需感知子会话的存在
- **智能路由**：0-1 个活跃会话走快速路径（$0）；2+ 个会话时 Claude 分类器携带用户记忆 + 会话摘要进行判断
- **会话摘要**：每个子会话自动生成摘要，让 Dispatcher 了解每个对话在做什么
- **记忆感知分发**：Dispatcher 分类时可见用户记忆 + 所有活跃会话摘要，即使模糊消息也能准确路由
- **并发子会话**：多个子会话并行执行，per-session 锁保证安全

## 快速开始

### 全局安装（npm）

```bash
npm i -g @emqo/agent-cli-bridge
agent-cli-bridge init              # 从模板生成 config.yaml
# 编辑 config.yaml，配置端点、Token、白名单
agent-cli-bridge start -f          # 前台启动
agent-cli-bridge start             # 后台启动（守护进程）
agent-cli-bridge status            # 查看运行状态
agent-cli-bridge reload            # 热重载配置
agent-cli-bridge stop              # 停止进程
```

也可使用短命令：`acb` 代替 `agent-cli-bridge`，`acb-ctl` 代替 `agent-cli-bridge-ctl`。

### 从源码

```bash
git clone https://github.com/Emqo/AgentCliBridge.git
cd AgentCliBridge
npm install
cp config.yaml.example config.yaml
# 编辑 config.yaml
npm run build && npm start
```

## 平台命令

| Telegram | Discord | 功能 |
|----------|---------|------|
| /new | !new | 清除会话 |
| /usage | !usage | 你的用量 |
| /allusage | !allusage | 所有用量 |
| /history | !history | 最近对话 |
| /model | !model | 端点信息 |
| /status | !status | 自动任务状态与进度 |
| /reload | !reload | 热重载配置 |
| /help | !help | 显示帮助 |

Discord 还支持：`!approve <id>`、`!reject <id>` 用于 HITL 审批。

所有其他交互由 Claude 通过技能系统自然处理，无需命令前缀。

## 人机协同 (HITL)

当 Claude 判定任务为关键操作（部署、删除、生产变更）时，使用 `ctl auto add-approval` 代替 `ctl auto add`。任务进入 `approval_pending` 状态：

- **Telegram**：内联键盘显示 Approve / Reject 按钮
- **Discord**：Bot 发送审批请求，用户回复 `!approve <id>` 或 `!reject <id>`

只有审批通过后，任务才进入执行队列。

## 条件分支（侦查模式）

任务可通过 `--parent <id>` 形成链路：

```
任务 #1（侦查）："分析性能瓶颈"
  → 发现3个问题，创建子任务：
  任务 #2："修复 N+1 查询"        (--parent 1)
  任务 #3："添加缓存层"           (--parent 1)
  任务 #4："运行基准测试"          (--parent 1)
```

链路进度自动报告：`Chain #1 progress: 2/4 done`

## Webhook 与定时任务

```bash
# 健康检查
curl http://localhost:3100/health

# 创建自动任务
curl -X POST http://localhost:3100/api/task \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '{"user_id":"123","platform":"telegram","chat_id":"123","description":"分析日志"}'

# 创建需审批的任务
curl -X POST http://localhost:3100/api/task \
  -d '{"user_id":"123","platform":"telegram","chat_id":"123","description":"部署到生产","approval":true}'
```

GitHub Webhooks 支持 `push`、`pull_request`、`issues` 事件，使用 HMAC-SHA256 签名验证。

## 并行执行

设置 `max_parallel: N` 同时运行 N 个自动任务。每个任务 spawn 独立的 `claude` 进程，无 session 共享，通过 SQLite 记忆系统传递上下文。

## 前置要求

- Node.js 18+
- 至少安装并认证一个支持的 CLI：
  - `claude` CLI（[Claude Code](https://docs.anthropic.com/en/docs/claude-code)）
  - `codex` CLI（[OpenAI Codex](https://github.com/openai/codex)）
  - `gemini` CLI（[Google Gemini](https://github.com/google-gemini/gemini-cli)）
- Telegram bot token（从 [@BotFather](https://t.me/BotFather) 获取）和/或 Discord bot token

## 许可证

MIT

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Emqo/AgentCliBridge&type=Date)](https://star-history.com/#Emqo/AgentCliBridge&Date)
