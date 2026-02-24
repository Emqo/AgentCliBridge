const messages: Record<string, Record<string, string>> = {
  en: {
    help: "ClaudeBridge ready.\n\nManagement commands:\n/new - clear session\n/usage - your stats\n/allusage - all stats\n/history - recent chats\n/model - endpoints info\n/status - auto task status\n/sessions - active sessions\n/reload - reload config\n/help - show this help\n\nJust chat naturally to manage memories, tasks, reminders, and more — Claude handles it all.",
    session_cleared: "Session cleared.",
    no_usage: "No usage data.",
    no_history: "No history.",
    config_reloaded: "Config reloaded.",
    reload_failed: "Reload failed: ",
    thinking: "Thinking...",
    still_processing: "Still processing...",
    upload_failed: "Upload failed: ",
    reminder_notify: "Reminder: {desc}",
    auto_starting: "Auto task #{id} starting:\n{desc}",
    auto_scheduled: "Auto task #{id} scheduled (executes in {minutes} min):\n{desc}",
    auto_done: "Auto task #{id} done (cost: ${cost}):",
    auto_failed: "Auto task #{id} failed: {err}",
    auto_retry: "Self-healing: auto task #{parent} failed, retry #{attempt}/3 queued as task #{id} (in 2min)",
    page_expired: "Page expired. Please resend your question.",
    approval_request: "Approval needed for auto task #{id}:\n{desc}",
    approval_approved: "Auto task #{id} approved -- queued for execution.",
    approval_rejected: "Auto task #{id} rejected.",
    approval_decided: "Task #{id} has already been decided.",
    no_auto_tasks: "No auto tasks found.",
    status_report: "Auto Task Status:",
    chain_progress: "Chain #{id} progress: {done}/{total} done{cost}",
    sessions_list: "Active sessions:",
    no_sessions: "No active sessions.",
    session_created: "New session created: {label}",
    session_limit: "Session limit reached. Oldest idle session closed.",
  },
  zh: {
    help: "ClaudeBridge 就绪。\n\n管理命令：\n/new - 清除会话\n/usage - 你的用量\n/allusage - 所有用量\n/history - 最近对话\n/model - 端点信息\n/status - 自动任务状态\n/sessions - 活跃会话\n/reload - 重载配置\n/help - 显示帮助\n\n直接对话即可管理记忆、任务、提醒等 — Claude 会自动处理。",
    session_cleared: "会话已清除。",
    no_usage: "暂无用量数据。",
    no_history: "暂无历史记录。",
    config_reloaded: "配置已重载。",
    reload_failed: "重载失败：",
    thinking: "思考中...",
    still_processing: "仍在处理...",
    upload_failed: "上传失败：",
    reminder_notify: "提醒：{desc}",
    auto_starting: "自动任务 #{id} 开始执行：\n{desc}",
    auto_scheduled: "自动任务 #{id} 已排程（{minutes} 分钟后执行）：\n{desc}",
    auto_done: "自动任务 #{id} 完成（花费：${cost}）：",
    auto_failed: "自动任务 #{id} 失败：{err}",
    auto_retry: "自愈机制：自动任务 #{parent} 失败，重试 #{attempt}/3 已排队为任务 #{id}（2分钟后执行）",
    page_expired: "页面已过期，请重新发送问题。",
    approval_request: "自动任务 #{id} 需要审批：\n{desc}",
    approval_approved: "自动任务 #{id} 已批准 -- 已加入执行队列。",
    approval_rejected: "自动任务 #{id} 已拒绝。",
    approval_decided: "任务 #{id} 已被处理。",
    no_auto_tasks: "暂无自动任务。",
    status_report: "自动任务状态：",
    chain_progress: "任务链 #{id} 进度：{done}/{total} 完成{cost}",
    sessions_list: "活跃会话：",
    no_sessions: "暂无活跃会话。",
    session_created: "新会话已创建：{label}",
    session_limit: "会话数已达上限，已关闭最旧的空闲会话。",
  },
};

const commandDescriptions: Record<string, Record<string, string>> = {
  en: {
    new: "Clear session", usage: "Your usage stats", allusage: "All users usage",
    history: "Recent conversations", model: "Current model/endpoints", status: "Auto task status",
    sessions: "Active sessions", reload: "Reload config", help: "Show all commands",
  },
  zh: {
    new: "清除会话", usage: "你的用量", allusage: "所有用量",
    history: "最近对话", model: "端点信息", status: "自动任务状态",
    sessions: "活跃会话", reload: "重载配置", help: "显示帮助",
  },
};

export function t(locale: string, key: string, vars?: Record<string, string | number>): string {
  const lang = messages[locale] ? locale : "en";
  let msg = messages[lang][key] ?? messages.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) msg = msg.replaceAll(`{${k}}`, String(v));
  return msg;
}

export function getCommandDescriptions(locale: string): { command: string; description: string }[] {
  const lang = commandDescriptions[locale] ? locale : "en";
  return Object.entries(commandDescriptions[lang]).map(([command, description]) => ({ command, description }));
}
