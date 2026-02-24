import { Adapter, chunkText } from "./base.js";
import { existsSync, createReadStream } from "fs";
import { basename, extname } from "path";
import { AgentEngine } from "../core/agent.js";
import { Store } from "../core/store.js";
import { reloadConfig, TelegramConfig } from "../core/config.js";
import { toTelegramMarkdown } from "../core/markdown.js";
import { t, getCommandDescriptions } from "../core/i18n.js";
import { log as rootLog } from "../core/logger.js";

const log = rootLog.child("telegram");

const EDIT_INTERVAL = 1500;

interface TgUpdate {
  update_id: number;
  message?: any;
  callback_query?: any;
}

export class TelegramAdapter implements Adapter {
  private running = false;
  private offset = 0;
  private reminderTimer?: ReturnType<typeof setInterval>;
  private autoTimer?: ReturnType<typeof setInterval>;
  private approvalTimer?: ReturnType<typeof setInterval>;
  private fileSendTimer?: ReturnType<typeof setInterval>;
  private activeAutoTasks = 0;
  private maxParallel = 1;
  private pages = new Map<string, { chunks: string[]; raw: string[]; ts: number }>();
  private static PAGE_TTL = 30 * 60 * 1000; // 30 minutes

  constructor(
    private engine: AgentEngine,
    private store: Store,
    private config: TelegramConfig,
    private locale: string = "en"
  ) {}

  reloadConfig(config: TelegramConfig, locale: string): void {
    this.config = config;
    this.locale = locale;
    this.maxParallel = this.engine.getMaxParallel();
  }

  private get api() {
    return `https://api.telegram.org/bot${this.config.token}`;
  }

  private async call(method: string, body?: any): Promise<any> {
    for (let i = 0; i < 3; i++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(`${this.api}/${method}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const json = await res.json();
        if (!json.ok) {
          log.error("API error", { method, description: json.description });
          const err = new Error(json.description || `Telegram API error: ${method}`);
          (err as any).apiError = true;
          throw err;
        }
        return json.result;
      } catch (err: any) {
        if (err.apiError || i === 2) throw err;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }

  private async reply(chatId: number, text: string, parseMode?: string, replyToMsgId?: number): Promise<any> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(replyToMsgId ? { reply_to_message_id: replyToMsgId } : {}),
    });
  }

  private async editMsg(chatId: number, msgId: number, text: string, parseMode?: string) {
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
    } catch {}
  }

  private async handleUpdate(update: TgUpdate) {
    if (update.callback_query) {
      const data = update.callback_query.data || "";
      if (data.startsWith("approve:") || data.startsWith("reject:")) {
        await this.handleApprovalCallback(update.callback_query);
      } else {
        await this.handlePageCallback(update.callback_query);
      }
      return;
    }
    const msg = update.message;
    if (!msg) return;
    const uid = msg.from?.id;
    const chatId = msg.chat.id;
    if (!uid) return;

    const groupId = msg.chat.type !== "private" ? String(chatId) : undefined;
    if (!this.engine.access.isAllowed(String(uid), groupId)) {
      log.info("user not allowed", { uid });
      return;
    }

    const text = (msg.text || "").trim();
    log.debug("message", { uid, text: text.slice(0, 50) });

    // Extract reply-to message ID for session routing
    const replyToMsgId = msg.reply_to_message?.message_id
      ? String(msg.reply_to_message.message_id)
      : undefined;

    // Management commands
    if (text === "/start" || text === "/help") {
      await this.reply(chatId, t(this.locale, "help"));
      return;
    }
    if (text === "/new") {
      if (this.engine.isMultiSessionEnabled()) {
        this.engine.getSessionManager().closeAll(String(uid));
      }
      this.store.clearSession(String(uid));
      await this.reply(chatId, t(this.locale, "session_cleared"));
      return;
    }
    if (text === "/usage") {
      const u = this.store.getUsage(String(uid));
      await this.reply(chatId, `Requests: ${u.count}\nCost: $${u.total_cost.toFixed(4)}`);
      return;
    }
    if (text === "/allusage") {
      const rows = this.store.getUsageAll();
      if (!rows.length) { await this.reply(chatId, t(this.locale, "no_usage")); return; }
      await this.reply(chatId, rows.map(r => `${r.user_id}: ${r.count} reqs, $${r.total_cost.toFixed(4)}`).join("\n"));
      return;
    }
    if (text === "/history") {
      const rows = this.store.getHistory(String(uid), 5);
      if (!rows.length) { await this.reply(chatId, t(this.locale, "no_history")); return; }
      const out = rows.reverse().map(r => `[${new Date(r.created_at).toLocaleString()}] ${r.role}: ${r.content.slice(0, 150)}`).join("\n\n");
      await this.reply(chatId, out);
      return;
    }
    if (text === "/model") {
      const eps = this.engine.getEndpoints();
      await this.reply(chatId, `Endpoints (${eps.length}):\n` + eps.map(e => `• ${e.name}: ${e.model || "default"}`).join("\n"));
      return;
    }
    if (text === "/reload") {
      try { const c = reloadConfig(); this.engine.reloadConfig(c); this.locale = c.locale; await this.reply(chatId, t(this.locale, "config_reloaded")); }
      catch (e: any) { await this.reply(chatId, t(this.locale, "reload_failed") + e.message); }
      return;
    }
    if (text === "/status") {
      await this.handleStatusCommand(chatId, String(uid));
      return;
    }
    if (text === "/sessions") {
      await this.handleSessionsCommand(chatId, String(uid));
      return;
    }

    // File upload
    if (msg.document || msg.photo) {
      let fileId: string;
      let fileName: string;
      if (msg.document) { fileId = msg.document.file_id; fileName = msg.document.file_name || "upload"; }
      else { const p = msg.photo[msg.photo.length - 1]; fileId = p.file_id; fileName = "photo.jpg"; }
      try {
        const file = await this.call("getFile", { file_id: fileId });
        const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
        const resp = await fetch(url);
        const buf = Buffer.from(await resp.arrayBuffer());
        const { writeFileSync } = await import("fs");
        const { join } = await import("path");
        const ws = this.engine.getWorkDir(String(uid));
        writeFileSync(join(ws, fileName), buf);
        const prompt = msg.caption || `Analyze the uploaded file: ${fileName}`;
        await this.handlePrompt(chatId, String(uid), prompt, replyToMsgId);
      } catch (e: any) { await this.reply(chatId, t(this.locale, "upload_failed") + e.message); }
      return;
    }

    // Text message — send to Claude (skill system handles intents)
    if (text) await this.handlePrompt(chatId, String(uid), text, replyToMsgId);
  }

  private pageKeyboard(chatId: number, msgId: number, cur: number, total: number) {
    const btns: any[] = [];
    if (cur > 0) btns.push({ text: "◀", callback_data: `p:${chatId}:${msgId}:${cur - 1}` });
    btns.push({ text: `${cur + 1} / ${total}`, callback_data: "noop" });
    if (cur < total - 1) btns.push({ text: "▶", callback_data: `p:${chatId}:${msgId}:${cur + 1}` });
    return { inline_keyboard: [btns] };
  }

  private async handlePageCallback(cb: any) {
    const data: string = cb.data || "";
    const cbId: string = cb.id;

    // Always answer callback to remove loading spinner
    const answer = (text?: string) =>
      this.call("answerCallbackQuery", { callback_query_id: cbId, ...(text ? { text, show_alert: false } : {}) });

    if (data === "noop") {
      await answer();
      return;
    }

    if (!data.startsWith("p:")) {
      await answer();
      return;
    }

    const parts = data.split(":");
    if (parts.length !== 4) {
      await answer();
      return;
    }

    const chatId = Number(parts[1]);
    const msgId = Number(parts[2]);
    const page = Number(parts[3]);
    const key = `${chatId}:${msgId}`;
    const entry = this.pages.get(key);

    if (!entry || Date.now() - entry.ts > TelegramAdapter.PAGE_TTL) {
      this.pages.delete(key);
      await answer(t(this.locale, "page_expired"));
      return;
    }

    if (page < 0 || page >= entry.chunks.length) {
      await answer();
      return;
    }

    const keyboard = this.pageKeyboard(chatId, msgId, page, entry.chunks.length);
    try {
      await this.call("editMessageText", {
        chat_id: chatId,
        message_id: msgId,
        text: entry.chunks[page],
        parse_mode: "MarkdownV2",
        reply_markup: keyboard,
      });
    } catch {
      // MarkdownV2 failed, fallback to raw text
      try {
        await this.call("editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: entry.raw[page],
          reply_markup: keyboard,
        });
      } catch {}
    }
    await answer();
  }

  private async handlePrompt(chatId: number, uid: string, text: string, replyToMsgId?: string) {
    // Multi-session mode: route and execute concurrently (no global lock check)
    if (this.engine.isMultiSessionEnabled()) {
      const placeholder = await this.reply(chatId, t(this.locale, "thinking"));
      const msgId = placeholder.message_id;
      let lastEdit = 0;

      try {
        log.info("running claude (multi-session)", { uid });
        const res = await this.engine.handleUserMessage(uid, text, "telegram", String(chatId), replyToMsgId,
          async (_chunk: string, full: string) => {
            const now = Date.now();
            if (now - lastEdit < EDIT_INTERVAL) return;
            lastEdit = now;
            const preview = full.slice(-3500) + "\n\n...";
            await this.editMsg(chatId, msgId, preview);
          }
        );
        log.info("claude done", { uid, session: res.subSessionId?.slice(0, 8), cost: res.cost?.toFixed(4) });

        // Track response message → sub-session mapping for future reply-to routing
        if (res.subSessionId) {
          this.engine.getSessionManager().trackMessage(String(msgId), String(chatId), res.subSessionId);
        }

        // Check if user has multiple active sessions — add label prefix
        const activeSessions = this.engine.getSessionManager().getActive(uid, "telegram");
        const labelPrefix = activeSessions.length > 1 && res.label ? `[${res.label.slice(0, 30)}]\n` : "";

        await this.sendFormattedResponse(chatId, msgId, res.text, labelPrefix);
      } catch (err: any) {
        log.error("claude error", { error: err?.message });
        await this.editMsg(chatId, msgId, `Error: ${err.message || "unknown"}`);
      }
      return;
    }

    // Legacy single-session mode (session.enabled: false)
    if (this.engine.isLocked(uid)) {
      await this.reply(chatId, t(this.locale, "still_processing"));
      return;
    }
    const placeholder = await this.reply(chatId, t(this.locale, "thinking"));
    const msgId = placeholder.message_id;
    let lastEdit = 0;

    try {
      log.info("running claude", { uid });
      const res = await this.engine.runStream(uid, text, "telegram", String(chatId),
        async (_chunk: string, full: string) => {
          const now = Date.now();
          if (now - lastEdit < EDIT_INTERVAL) return;
          lastEdit = now;
          const preview = full.slice(-3500) + "\n\n...";
          await this.editMsg(chatId, msgId, preview);
        }
      );
      log.info("claude done", { uid, cost: res.cost?.toFixed(4) });

      await this.sendFormattedResponse(chatId, msgId, res.text);
    } catch (err: any) {
      log.error("claude error", { error: err?.message });
      await this.editMsg(chatId, msgId, `Error: ${err.message || "unknown"}`);
    }
  }

  /** Format and send a response with MarkdownV2 + pagination support */
  private async sendFormattedResponse(chatId: number, msgId: number, text: string, labelPrefix: string = ""): Promise<void> {
    const maxLen = this.config.chunk_size || 4000;
    const fullText = labelPrefix + text;
    const md = toTelegramMarkdown(fullText);
    const mdChunks = chunkText(md, maxLen);
    const rawChunks = chunkText(fullText, maxLen);

    if (mdChunks.length <= 1) {
      try {
        await this.editMsg(chatId, msgId, mdChunks[0], "MarkdownV2");
      } catch {
        await this.editMsg(chatId, msgId, fullText);
      }
    } else {
      const key = `${chatId}:${msgId}`;
      if (this.pages.size >= 50) {
        const oldest = this.pages.keys().next().value!;
        this.pages.delete(oldest);
      }
      this.pages.set(key, { chunks: mdChunks, raw: rawChunks, ts: Date.now() });
      setTimeout(() => this.pages.delete(key), TelegramAdapter.PAGE_TTL);

      const keyboard = this.pageKeyboard(chatId, msgId, 0, mdChunks.length);
      try {
        await this.call("editMessageText", {
          chat_id: chatId,
          message_id: msgId,
          text: mdChunks[0],
          parse_mode: "MarkdownV2",
          reply_markup: keyboard,
        });
      } catch {
        try {
          await this.call("editMessageText", {
            chat_id: chatId,
            message_id: msgId,
            text: rawChunks[0],
            reply_markup: keyboard,
          });
        } catch {}
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;
    this.maxParallel = this.engine.getMaxParallel();
    log.info("starting long polling...", { maxParallel: this.maxParallel, multiSession: this.engine.isMultiSessionEnabled() });
    this.reminderTimer = setInterval(() => this.checkReminders(), 30000);
    this.autoTimer = setInterval(() => this.processAutoTasks(), 60000);
    this.approvalTimer = setInterval(() => this.checkApprovals(), 15000);
    this.fileSendTimer = setInterval(() => this.checkFileSends(), 5000);
    await this.registerCommands();
    let pollBackoff = 0;
    while (this.running) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(`${this.api}/getUpdates?offset=${this.offset}&timeout=10`, { signal: ctrl.signal });
        clearTimeout(timer);
        const json = await res.json() as any;
        if (!json.ok) { log.error("poll error", { response: json }); continue; }
        pollBackoff = 0; // reset on success
        for (const update of json.result) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update).catch(e => log.error("handler error", { error: (e as any)?.message }));
        }
      } catch (err: any) {
        pollBackoff = Math.min(pollBackoff + 1, 6);
        const delay = Math.min(3000 * Math.pow(2, pollBackoff), 120000);
        log.warn("poll error", { retryIn: delay / 1000, error: err.cause?.code || err.message || "unknown" });
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  stop(): void {
    this.running = false;
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    if (this.autoTimer) clearInterval(this.autoTimer);
    if (this.approvalTimer) clearInterval(this.approvalTimer);
    if (this.fileSendTimer) clearInterval(this.fileSendTimer);
  }

  private async registerCommands(): Promise<void> {
    try {
      await this.call("setMyCommands", { commands: getCommandDescriptions(this.locale) });
      log.info("commands registered");
    } catch (e: any) { log.error("failed to register commands", { error: e?.message }); }
  }

  private async checkReminders(): Promise<void> {
    try {
      const due = this.store.getDueReminders().filter(r => r.platform === "telegram");
      for (const r of due) {
        await this.reply(Number(r.chat_id), t(this.locale, "reminder_notify", { desc: r.description }));
        this.store.markReminderSent(r.id);
      }
    } catch (e: any) { log.error("reminder error", { error: e?.message }); }
  }

  private async processAutoTasks(): Promise<void> {
    const available = this.maxParallel - this.activeAutoTasks;
    if (available <= 0) return;
    const tasks = this.store.getNextAutoTasks("telegram", available);
    for (const task of tasks) {
      this.activeAutoTasks++;
      this.store.markTaskRunning(task.id);
      this.runAutoTask(task).finally(() => { this.activeAutoTasks--; });
    }
  }

  private async runAutoTask(task: { id: number; user_id: string; platform: string; chat_id: string; description: string; parent_id: number | null }): Promise<void> {
    const chatId = Number(task.chat_id);
    await this.reply(chatId, t(this.locale, "auto_starting", { id: task.id, desc: task.description }));
    try {
      log.info("auto-task starting", { taskId: task.id, userId: task.user_id });
      // Always use runParallel for auto-tasks: fresh session, no user session pollution
      const res = await this.engine.runParallel(task.user_id, task.description, "telegram", task.chat_id, undefined, 0);
      if (res.timedOut) {
        this.store.markTaskResult(task.id, "failed");
        if (res.text) this.store.setTaskResult(task.id, res.text.slice(0, 10000));
        await this.reply(chatId, t(this.locale, "auto_failed", { id: task.id, err: "timed out" }));
        // Self-healing: auto-retry timed out tasks
        const retryMatch = task.description.match(/\[retry (\d+)\/3\]/);
        const retryCount = retryMatch ? parseInt(retryMatch[1]) : 0;
        if (retryCount < 3) {
          const retryDesc = retryCount === 0
            ? `[retry 1/3] Previous attempt of task #${task.id} timed out. Continue from where it left off: ${task.description}`
            : task.description.replace(`[retry ${retryCount}/3]`, `[retry ${retryCount + 1}/3]`);
          const retryId = this.store.addTask(task.user_id, "telegram", task.chat_id, retryDesc, undefined, true, task.parent_id || task.id, Date.now() + 120000);
          await this.reply(chatId, t(this.locale, "auto_retry", { id: retryId, attempt: retryCount + 1, parent: task.id }));
        }
        return;
      }
      this.store.markTaskResult(task.id, "done");
      if (res.text) this.store.setTaskResult(task.id, res.text.slice(0, 10000));
      const maxLen = this.config.chunk_size || 4000;
      const rawChunks = chunkText(res.text || "(no output)", maxLen);
      const mdChunks = chunkText(toTelegramMarkdown(res.text || "(no output)"), maxLen);
      await this.reply(chatId, t(this.locale, "auto_done", { id: task.id, cost: (res.cost || 0).toFixed(4) }));
      for (let i = 0; i < mdChunks.length; i++) {
        try {
          await this.call("sendMessage", { chat_id: chatId, text: mdChunks[i], parse_mode: "MarkdownV2" });
        } catch {
          await this.reply(chatId, rawChunks[i] || mdChunks[i]);
        }
      }
      // Chain progress reporting
      if (task.parent_id) {
        const progress = this.store.getChainProgress(task.parent_id);
        const costSuffix = res.cost ? ` | Cost: $${res.cost.toFixed(4)}` : "";
        await this.reply(chatId, t(this.locale, "chain_progress", { id: task.parent_id, done: progress.done, total: progress.total, cost: costSuffix }));
      }
    } catch (err: any) {
      this.store.markTaskResult(task.id, "failed");
      await this.reply(chatId, t(this.locale, "auto_failed", { id: task.id, err: err.message || "unknown" }));
      // Self-healing: auto-retry failed tasks (max 3 retries)
      const retryMatch = task.description.match(/\[retry (\d+)\/3\]/);
      const retryCount = retryMatch ? parseInt(retryMatch[1]) : 0;
      if (retryCount < 3) {
        const retryDesc = retryCount === 0
          ? `[retry 1/3] Previous attempt of task #${task.id} failed (${(err.message || "unknown").slice(0, 100)}). Analyze the failure, fix the issue, then: ${task.description}`
          : task.description.replace(`[retry ${retryCount}/3]`, `[retry ${retryCount + 1}/3]`);
        const retryId = this.store.addTask(task.user_id, "telegram", task.chat_id, retryDesc, undefined, true, task.parent_id || task.id, Date.now() + 120000);
        await this.reply(chatId, t(this.locale, "auto_retry", { id: retryId, attempt: retryCount + 1, parent: task.id }));
      }
    }
  }

  private async checkApprovals(): Promise<void> {
    try {
      const pending = this.store.getPendingApprovals("telegram");
      for (const task of pending) {
        const chatId = Number(task.chat_id);
        const keyboard = {
          inline_keyboard: [[
            { text: "Approve", callback_data: `approve:${task.id}` },
            { text: "Reject", callback_data: `reject:${task.id}` },
          ]],
        };
        await this.call("sendMessage", {
          chat_id: chatId,
          text: t(this.locale, "approval_request", { id: task.id, desc: task.description }),
          reply_markup: keyboard,
        });
        this.store.markReminderSent(task.id); // reuse reminder_sent to avoid re-sending
      }
    } catch (e: any) { log.error("approval check error", { error: e?.message }); }
  }

  private async handleApprovalCallback(cb: any): Promise<void> {
    const data: string = cb.data || "";
    const cbId: string = cb.id;
    const answer = (text: string) =>
      this.call("answerCallbackQuery", { callback_query_id: cbId, text, show_alert: true });

    const [action, idStr] = data.split(":");
    const taskId = parseInt(idStr);
    if (isNaN(taskId)) { await answer("Invalid task ID"); return; }

    if (action === "approve") {
      const ok = this.store.approveTask(taskId);
      if (ok) {
        await answer(t(this.locale, "approval_approved", { id: taskId }));
        // Edit the original message to show approved
        if (cb.message) {
          try {
            await this.call("editMessageText", {
              chat_id: cb.message.chat.id,
              message_id: cb.message.message_id,
              text: t(this.locale, "approval_approved", { id: taskId }),
            });
          } catch {}
        }
      } else {
        await answer(t(this.locale, "approval_decided", { id: taskId }));
      }
    } else if (action === "reject") {
      const ok = this.store.rejectTask(taskId);
      if (ok) {
        await answer(t(this.locale, "approval_rejected", { id: taskId }));
        if (cb.message) {
          try {
            await this.call("editMessageText", {
              chat_id: cb.message.chat.id,
              message_id: cb.message.message_id,
              text: t(this.locale, "approval_rejected", { id: taskId }),
            });
          } catch {}
        }
      } else {
        await answer(t(this.locale, "approval_decided", { id: taskId }));
      }
    }
  }

  private async handleStatusCommand(chatId: number, userId: string): Promise<void> {
    const recent = this.store.getRecentAutoTasks("telegram", 10);
    if (!recent.length) {
      await this.reply(chatId, t(this.locale, "no_auto_tasks"));
      return;
    }
    const statusEmoji: Record<string, string> = {
      auto: "[queue]", running: "[run]", done: "[done]", failed: "[fail]",
      approval_pending: "[pending]", cancelled: "[cancel]",
    };
    const lines = recent.map(task => {
      const chain = task.parent_id ? ` (chain #${task.parent_id})` : "";
      let schedInfo = "";
      if (task.status === "auto" && task.scheduled_at && task.scheduled_at > Date.now()) {
        const mins = Math.ceil((task.scheduled_at - Date.now()) / 60000);
        schedInfo = ` [in ${mins}min]`;
      }
      return `${statusEmoji[task.status] || "[?]"} #${task.id} [${task.status}]${schedInfo} ${task.description.slice(0, 60)}${chain}`;
    });
    const stats = this.store.getAutoTaskStats();
    const summary = stats.map(s => `${s.status}: ${s.count}`).join(" | ");
    const report = `${t(this.locale, "status_report")}\n${lines.join("\n")}\n\nSummary: ${summary}`;
    await this.reply(chatId, report);
  }

  private async handleSessionsCommand(chatId: number, userId: string): Promise<void> {
    if (!this.engine.isMultiSessionEnabled()) {
      await this.reply(chatId, "Multi-session mode is disabled.");
      return;
    }
    const sessions = this.engine.getSessionManager().getActive(userId, "telegram");
    if (!sessions.length) {
      await this.reply(chatId, t(this.locale, "no_sessions"));
      return;
    }
    const statusIcon: Record<string, string> = { active: "🟢", idle: "🟡", expired: "🔴", closed: "⚫" };
    const lines = sessions.map(s => {
      const ago = Math.round((Date.now() - s.lastActiveAt) / 60000);
      const locked = this.engine.isSessionLocked(s.id) ? " [processing]" : "";
      return `${statusIcon[s.status] || "⚪"} ${s.id.slice(0, 8)} "${s.label || "(no topic)"}" (${ago}min ago, ${s.messageCount} msgs, $${s.totalCost.toFixed(4)})${locked}`;
    });
    await this.reply(chatId, `${t(this.locale, "sessions_list")}\n${lines.join("\n")}`);
  }

  private async checkFileSends(): Promise<void> {
    try {
      const pending = this.store.getPendingFileSends("telegram");
      for (const f of pending) {
        if (!existsSync(f.file_path)) { this.store.markFileFailed(f.id); continue; }
        const chatId = Number(f.chat_id);
        const ext = extname(f.file_path).toLowerCase();
        const isPhoto = [".jpg", ".jpeg", ".png", ".gif"].includes(ext);
        const method = isPhoto ? "sendPhoto" : "sendDocument";
        const fieldName = isPhoto ? "photo" : "document";
        try {
          const form = new FormData();
          form.append("chat_id", String(chatId));
          const blob = new Blob([await import("fs").then(fs => fs.readFileSync(f.file_path))]);
          form.append(fieldName, blob, basename(f.file_path));
          if (f.caption) form.append("caption", f.caption);
          const res = await fetch(`${this.api}/${method}`, { method: "POST", body: form });
          const json = await res.json() as any;
          if (json.ok) this.store.markFileSent(f.id);
          else { log.error("file send API error", { id: f.id, desc: json.description }); this.store.markFileFailed(f.id); }
        } catch (err: any) {
          log.error("file send error", { id: f.id, error: err?.message });
          this.store.markFileFailed(f.id);
        }
      }
    } catch (e: any) { log.error("checkFileSends error", { error: e?.message }); }
  }
}
