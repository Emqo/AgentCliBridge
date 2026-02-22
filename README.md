# ClaudeBridge

Bridge the `claude` CLI to chat platforms (Telegram, Discord). Spawns `claude` as a subprocess with `--output-format stream-json` — no SDK dependency, just raw CLI power.

## Features

- **Multi-platform**: Telegram (raw Bot API long polling) + Discord (discord.js)
- **Streaming responses**: Real-time message editing as Claude thinks
- **Multi-endpoint rotation**: Round-robin with auto-cooldown on 429/401/529
- **Session persistence**: SQLite-backed session resume via `-r <session_id>`
- **Per-user workspace isolation**: Each user gets their own working directory
- **Memory system**: Manual + auto-summary memories per user
- **Task & reminder system**: Create tasks, set timed reminders
- **Natural language intent detection**: Say "remind me in 5 min to check server" — no commands needed
  - Regex-first (zero cost, zero latency) + Claude fallback (~$0.005/call)
- **Auto tasks**: Queue background tasks that execute when idle
- **File uploads**: Send files to Claude for analysis
- **Access control**: User/group whitelist
- **Hot reload**: Edit `config.yaml`, changes apply instantly
- **i18n**: English + Chinese

## Quick Start

```bash
# Install
npm install

# Configure
cp config.yaml.example config.yaml  # or edit config.yaml directly
# Set your endpoints, tokens, and access whitelist

# Build & run
npm run build
npm start

# Or dev mode (hot reload)
npm run dev
```

## Configuration

All config lives in `config.yaml`:

```yaml
endpoints:
  - name: "my-endpoint"
    base_url: ""          # optional, for proxies
    api_key: "sk-..."
    model: "claude-sonnet-4-20250514"

locale: en  # "zh" for Chinese

agent:
  allowed_tools: [Read, Edit, Bash, Grep, Glob, WebSearch, WebFetch]
  permission_mode: "acceptEdits"
  max_turns: 50
  max_budget_usd: 2.0
  system_prompt: ""
  timeout_seconds: 300
  memory:
    enabled: true
    auto_summary: true
    max_memories: 50
  intent:
    enabled: true              # natural language intent detection
    use_claude_fallback: true  # use Claude when regex doesn't match

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
```

Environment variables (`.env`) work as fallback for single-endpoint setup.

## Commands

| Telegram | Discord | Action |
|----------|---------|--------|
| /new | !new | Clear session |
| /usage | !usage | Your usage stats |
| /allusage | !allusage | All users stats |
| /history | !history | Recent conversations |
| /model | !model | Endpoint info |
| /reload | !reload | Hot reload config |
| /remember | !remember | Save a memory |
| /memories | !memories | List memories |
| /forget | !forget | Clear all memories |
| /task | !task | Add a task |
| /tasks | !tasks | List pending tasks |
| /done | !done | Complete a task |
| /remind | !remind | Set a timed reminder |
| /auto | !auto | Queue auto task |
| /autotasks | !autotasks | List auto tasks |
| /cancelauto | !cancelauto | Cancel auto task |

## Natural Language Intent

No need to type commands — just talk naturally:

| Say this | Detected as |
|----------|-------------|
| "remind me 5 min later check server" | Reminder: 5min, check server |
| "remind me 10 minutes later to deploy" | Reminder: 10min, deploy |
| "add task buy groceries" | Task: buy groceries |
| "create task: fix login bug" | Task: fix login bug |
| "remember I prefer dark mode" | Memory: I prefer dark mode |
| "forget all" | Clear all memories |
| "new session" | Clear session |

Regex matches first (instant, free). If no match and `use_claude_fallback` is enabled, a low-budget Claude call classifies the intent.

## Architecture

```
src/index.ts              Entry point, config loading, hot reload
src/core/
  agent.ts                Claude CLI subprocess spawner with retry & rotation
  config.ts               YAML config with env fallback
  intent.ts               Hybrid intent detection (regex + Claude)
  keys.ts                 Endpoint round-robin with cooldown
  lock.ts                 Per-user concurrency mutex
  store.ts                SQLite (WAL): sessions, usage, history, memories, tasks
  permissions.ts          Whitelist access control
  markdown.ts             Markdown → Telegram MarkdownV2
  i18n.ts                 Internationalization (en/zh)
src/adapters/
  base.ts                 Adapter interface
  telegram.ts             Telegram Bot API (raw fetch, long polling)
  discord.ts              Discord.js (@mentions + DMs)
```

## Prerequisites

- Node.js 18+
- `claude` CLI installed and authenticated
- Telegram bot token (from @BotFather) and/or Discord bot token

## License

MIT

---

# ClaudeBridge

将 `claude` CLI 桥接到聊天平台（Telegram、Discord）。通过子进程方式调用 `claude --output-format stream-json`，无需 SDK，直接使用 CLI。

## 功能特性

- **多平台**：Telegram（原生 Bot API 长轮询）+ Discord（discord.js）
- **流式响应**：Claude 思考时实时编辑消息
- **多端点轮转**：Round-robin，429/401/529 自动冷却切换
- **会话持久化**：SQLite 存储，通过 `-r <session_id>` 恢复会话
- **用户工作区隔离**：每个用户独立工作目录
- **记忆系统**：手动 + 自动摘要记忆
- **任务与提醒**：创建任务、设置定时提醒
- **自然语言意图识别**：直接说"提醒我5分钟后检查服务器"，无需打命令
  - 正则优先（零成本零延迟）+ Claude 兜底（~$0.005/次）
- **自动任务**：排队后台任务，空闲时自动执行
- **文件上传**：发送文件给 Claude 分析
- **访问控制**：用户/群组白名单
- **热重载**：编辑 `config.yaml` 即时生效
- **国际化**：英文 + 中文

## 快速开始

```bash
npm install
# 编辑 config.yaml，配置端点、Token、白名单
npm run build && npm start
# 或开发模式
npm run dev
```

## 自然语言意图

无需输入命令，直接自然对话：

| 你说 | 识别为 |
|------|--------|
| "提醒我5分钟后检查服务器" | 提醒：5分钟后，检查服务器 |
| "remind me 10 min later to deploy" | 提醒：10分钟后，部署 |
| "添加任务买牛奶" | 任务：买牛奶 |
| "记住我喜欢TypeScript" | 记忆：我喜欢TypeScript |
| "忘记所有" | 清除所有记忆 |
| "新会话" | 清除会话 |

正则优先匹配（即时、免费）。未匹配且 `use_claude_fallback` 开启时，用低预算 Claude 调用分类意图。

## 前置要求

- Node.js 18+
- `claude` CLI 已安装并认证
- Telegram bot token（从 @BotFather 获取）和/或 Discord bot token

## 许可证

MIT

---

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Emqo/ClaudeBridge&type=Date)](https://star-history.com/#Emqo/ClaudeBridge&Date)
