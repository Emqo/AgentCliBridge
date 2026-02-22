import { Adapter, chunkText } from "./base.js";
import { AgentEngine } from "../core/agent.js";
import { Store } from "../core/store.js";
import { reloadConfig, TelegramConfig, IntentConfig } from "../core/config.js";
import { toTelegramMarkdown } from "../core/markdown.js";
import { t, getCommandDescriptions } from "../core/i18n.js";
import { detectIntent } from "../core/intent.js";

const EDIT_INTERVAL = 1500;

interface TgUpdate {
  update_id: number;
  message?: any;
}

export class TelegramAdapter implements Adapter {
  private running = false;
  private offset = 0;
  private reminderTimer?: ReturnType<typeof setInterval>;
  private autoTimer?: ReturnType<typeof setInterval>;
  private autoRunning = false;

  constructor(
    private engine: AgentEngine,
    private store: Store,
    private config: TelegramConfig,
    private locale: string = "en"
  ) {}

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
        return json.result;
      } catch (err) {
        if (i === 2) throw err;
        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
      }
    }
  }

  private async reply(chatId: number, text: string, parseMode?: string): Promise<any> {
    return this.call("sendMessage", {
      chat_id: chatId,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
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
    const msg = update.message;
    if (!msg) return;
    const uid = msg.from?.id;
    const chatId = msg.chat.id;
    if (!uid) return;

    const groupId = msg.chat.type !== "private" ? String(chatId) : undefined;
    if (!this.engine.access.isAllowed(String(uid), groupId)) {
      console.log(`[telegram] user ${uid} not allowed`);
      return;
    }

    const text = (msg.text || "").trim();
    console.log(`[telegram] ${uid}: ${text.slice(0, 50)}`);

    // Commands
    if (text === "/start" || text === "/help") {
      await this.reply(chatId, t(this.locale, "help"));
      return;
    }
    if (text === "/new") {
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
    if (text.startsWith("/remember ")) {
      const content = text.slice(10).trim();
      if (!content) { await this.reply(chatId, t(this.locale, "usage_remember")); return; }
      this.store.addMemory(String(uid), content);
      await this.reply(chatId, t(this.locale, "memory_saved"));
      return;
    }
    if (text === "/memories") {
      const mems = this.store.getMemories(String(uid));
      if (!mems.length) { await this.reply(chatId, t(this.locale, "no_memories")); return; }
      await this.reply(chatId, mems.map(m => `[${m.source}] ${m.content}`).join("\n\n"));
      return;
    }
    if (text === "/forget") {
      this.store.clearMemories(String(uid));
      await this.reply(chatId, t(this.locale, "memories_cleared"));
      return;
    }
    if (text.startsWith("/task ")) {
      const desc = text.slice(6).trim();
      if (!desc) { await this.reply(chatId, t(this.locale, "usage_task")); return; }
      const id = this.store.addTask(String(uid), "telegram", String(chatId), desc);
      await this.reply(chatId, t(this.locale, "task_added", { id }));
      return;
    }
    if (text === "/tasks") {
      const tasks = this.store.getTasks(String(uid));
      if (!tasks.length) { await this.reply(chatId, t(this.locale, "no_tasks")); return; }
      await this.reply(chatId, tasks.map(t => `#${t.id} ${t.description}${t.remind_at ? ` ⏰${new Date(t.remind_at).toLocaleString()}` : ""}`).join("\n"));
      return;
    }
    if (text.startsWith("/done ")) {
      const id = parseInt(text.slice(6).trim());
      if (isNaN(id)) { await this.reply(chatId, t(this.locale, "usage_done")); return; }
      const ok = this.store.completeTask(id, String(uid));
      await this.reply(chatId, ok ? t(this.locale, "task_done", { id }) : t(this.locale, "task_not_found", { id }));
      return;
    }
    if (text.startsWith("/remind ")) {
      const match = text.match(/^\/remind\s+(\d+)m\s+(.+)$/);
      if (!match) { await this.reply(chatId, t(this.locale, "usage_remind")); return; }
      const mins = parseInt(match[1]);
      const desc = match[2].trim();
      const remindAt = Date.now() + mins * 60000;
      const id = this.store.addTask(String(uid), "telegram", String(chatId), desc, remindAt);
      await this.reply(chatId, t(this.locale, "reminder_set", { id, mins }));
      return;
    }
    if (text.startsWith("/auto ")) {
      const desc = text.slice(6).trim();
      if (!desc) { await this.reply(chatId, t(this.locale, "usage_auto")); return; }
      const id = this.store.addTask(String(uid), "telegram", String(chatId), desc, undefined, true);
      await this.reply(chatId, t(this.locale, "auto_queued", { id }));
      return;
    }
    if (text === "/autotasks") {
      const all = this.store.getAutoTasks(String(uid));
      if (!all.length) { await this.reply(chatId, t(this.locale, "no_auto_tasks")); return; }
      await this.reply(chatId, all.map(t => `#${t.id} [${t.status}] ${t.description}`).join("\n"));
      return;
    }
    if (text.startsWith("/cancelauto ")) {
      const id = parseInt(text.slice(12).trim());
      if (isNaN(id)) { await this.reply(chatId, t(this.locale, "usage_cancelauto")); return; }
      this.store.markTaskResult(id, "cancelled");
      await this.reply(chatId, t(this.locale, "auto_cancelled", { id }));
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
        const { mkdirSync, writeFileSync } = await import("fs");
        const { join } = await import("path");
        const ws = join("workspaces", String(uid));
        mkdirSync(ws, { recursive: true });
        writeFileSync(join(ws, fileName), buf);
        const prompt = msg.caption || `Analyze the uploaded file: ${fileName}`;
        await this.handlePrompt(chatId, String(uid), prompt);
      } catch (e: any) { await this.reply(chatId, t(this.locale, "upload_failed") + e.message); }
      return;
    }

    // Intent detection (before sending to Claude)
    if (text && !text.startsWith("/") && this.engine.getIntentConfig()?.enabled !== false) {
      const intent = await detectIntent(text, this.engine.getRotator(), this.engine.getIntentConfig());
      if (intent.type === "reminder" && intent.minutes && intent.description) {
        const remindAt = Date.now() + intent.minutes * 60000;
        const id = this.store.addTask(String(uid), "telegram", String(chatId), intent.description, remindAt);
        await this.reply(chatId, t(this.locale, "intent_reminder_set", { mins: intent.minutes, desc: intent.description, id }));
        return;
      }
      if (intent.type === "task" && intent.description) {
        const id = this.store.addTask(String(uid), "telegram", String(chatId), intent.description);
        await this.reply(chatId, t(this.locale, "intent_task_added", { id, desc: intent.description }));
        return;
      }
      if (intent.type === "memory" && intent.description) {
        // If description contains references to context ("上面", "this", "that", etc.),
        // fall through to Claude conversation so it can resolve from session history
        if (/上面|之前|刚才|这个|那个|above|previous|earlier|this|that/.test(intent.description)) {
          // Don't intercept — let Claude handle it with full context
        } else {
          this.store.addMemory(String(uid), intent.description, "nlp");
          await this.reply(chatId, t(this.locale, "intent_memory_saved", { desc: intent.description }));
          return;
        }
      }
      if (intent.type === "forget") {
        this.store.clearMemories(String(uid));
        await this.reply(chatId, t(this.locale, "memories_cleared"));
        return;
      }
      if (intent.type === "clear_session") {
        this.store.clearSession(String(uid));
        await this.reply(chatId, t(this.locale, "session_cleared"));
        return;
      }
    }

    // Text message
    if (text) await this.handlePrompt(chatId, String(uid), text);
  }

  private async handlePrompt(chatId: number, uid: string, text: string) {
    if (this.engine.isLocked(uid)) {
      await this.reply(chatId, t(this.locale, "still_processing"));
      return;
    }
    const placeholder = await this.reply(chatId, t(this.locale, "thinking"));
    const msgId = placeholder.message_id;
    let lastEdit = 0;

    try {
      console.log(`[telegram] running claude for ${uid}...`);
      const res = await this.engine.runStream(uid, text, "telegram",
        async (_chunk: string, full: string) => {
          const now = Date.now();
          if (now - lastEdit < EDIT_INTERVAL) return;
          lastEdit = now;
          const preview = full.slice(-3500) + "\n\n⏳...";
          await this.editMsg(chatId, msgId, preview);
        }
      );
      console.log(`[telegram] claude done for ${uid}, cost=$${res.cost?.toFixed(4)}`);

      const maxLen = this.config.chunk_size || 4000;
      const md = toTelegramMarkdown(res.text);
      const chunks = chunkText(md, maxLen);
      try {
        await this.editMsg(chatId, msgId, chunks[0], "MarkdownV2");
      } catch {
        await this.editMsg(chatId, msgId, res.text);
      }
      for (let i = 1; i < chunks.length; i++) {
        try {
          await this.reply(chatId, chunks[i], "MarkdownV2");
        } catch {
          await this.reply(chatId, chunks[i]);
        }
      }
    } catch (err: any) {
      console.error("[telegram] claude error:", err);
      await this.editMsg(chatId, msgId, `Error: ${err.message || "unknown"}`);
    }
  }

  async start(): Promise<void> {
    this.running = true;
    console.log("[telegram] starting long polling...");
    this.reminderTimer = setInterval(() => this.checkReminders(), 30000);
    this.autoTimer = setInterval(() => this.processAutoTasks(), 60000);
    await this.registerCommands();
    while (this.running) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(`${this.api}/getUpdates?offset=${this.offset}&timeout=5`, { signal: ctrl.signal });
        clearTimeout(timer);
        const json = await res.json() as any;
        if (!json.ok) { console.error("[telegram] poll error:", json); continue; }
        for (const update of json.result) {
          this.offset = update.update_id + 1;
          this.handleUpdate(update).catch(e => console.error("[telegram] handler error:", e));
        }
      } catch (err) {
        console.error("[telegram] poll fetch error:", err);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  stop(): void {
    this.running = false;
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    if (this.autoTimer) clearInterval(this.autoTimer);
  }

  private async registerCommands(): Promise<void> {
    try {
      await this.call("setMyCommands", { commands: getCommandDescriptions(this.locale) });
      console.log("[telegram] commands registered");
    } catch (e) { console.error("[telegram] failed to register commands:", e); }
  }

  private async checkReminders(): Promise<void> {
    try {
      const due = this.store.getDueReminders().filter(r => r.platform === "telegram");
      for (const r of due) {
        await this.reply(Number(r.chat_id), t(this.locale, "reminder_notify", { desc: r.description }));
        this.store.markReminderSent(r.id);
      }
    } catch (e) { console.error("[telegram] reminder error:", e); }
  }

  private async processAutoTasks(): Promise<void> {
    if (this.autoRunning) return;
    const task = this.store.getNextAutoTask();
    if (!task) return;
    this.autoRunning = true;
    this.store.markTaskRunning(task.id);
    const chatId = Number(task.chat_id);
    await this.reply(chatId, t(this.locale, "auto_starting", { id: task.id, desc: task.description }));
    try {
      console.log(`[telegram] auto-task #${task.id} for ${task.user_id}`);
      const res = await this.engine.runStream(task.user_id, task.description, "telegram");
      this.store.markTaskResult(task.id, "done");
      const maxLen = this.config.chunk_size || 4000;
      const chunks = chunkText(res.text || "(no output)", maxLen);
      await this.reply(chatId, t(this.locale, "auto_done", { id: task.id, cost: (res.cost || 0).toFixed(4) }));
      for (const c of chunks) await this.reply(chatId, c);
    } catch (err: any) {
      this.store.markTaskResult(task.id, "failed");
      await this.reply(chatId, t(this.locale, "auto_failed", { id: task.id, err: err.message || "unknown" }));
    } finally {
      this.autoRunning = false;
    }
  }
}