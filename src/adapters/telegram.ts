import { AdapterBase, chunkText, closeCodeFences } from "./base.js";
import { existsSync, readFileSync } from "fs";
import { basename, extname } from "path";
import { AgentEngine } from "../core/agent.js";
import { Store } from "../core/store.js";
import { reloadConfig, TelegramConfig } from "../core/config.js";
import { toTelegramMarkdown } from "../core/markdown.js";
import { t, getCommandDescriptions } from "../core/i18n.js";
import { log as rootLog, shortId } from "../core/logger.js";

const log = rootLog.child("telegram");

const EDIT_INTERVAL = 1500;

interface TgUpdate {
  update_id: number;
  message?: any;
  edited_message?: any;
  callback_query?: any;
}

export class TelegramAdapter extends AdapterBase {
  private running = false;
  private offset = 0;
  private config: TelegramConfig;
  private pages = new Map<string, { chunks: string[]; raw: string[]; ts: number }>();
  private static PAGE_TTL = 30 * 60 * 1000; // 30 minutes

  constructor(
    engine: AgentEngine,
    store: Store,
    config: TelegramConfig,
    locale: string = "en"
  ) {
    super(engine, store, locale);
    this.config = config;
  }

  get platformName(): string { return "telegram"; }
  get chunkSize(): number { return this.config.chunk_size || 4000; }

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
    // Try with parseMode first, fallback to plain text
    if (parseMode) {
      try {
        await this.call("editMessageText", {
          chat_id: chatId, message_id: msgId, text, parse_mode: parseMode,
        });
        return;
      } catch {}
    }
    try {
      await this.call("editMessageText", {
        chat_id: chatId, message_id: msgId, text,
      });
    } catch {}
  }

  // ─── AdapterBase abstract implementations ───────────────────

  async sendText(chatId: string, text: string): Promise<string | void> {
    const msg = await this.reply(Number(chatId), text);
    return msg?.message_id ? String(msg.message_id) : undefined;
  }

  async sendFile(chatId: string, filePath: string, caption: string): Promise<boolean> {
    const ext = extname(filePath).toLowerCase();
    const isPhoto = [".jpg", ".jpeg", ".png", ".gif"].includes(ext);
    const method = isPhoto ? "sendPhoto" : "sendDocument";
    const fieldName = isPhoto ? "photo" : "document";
    const form = new FormData();
    form.append("chat_id", chatId);
    const blob = new Blob([readFileSync(filePath)]);
    form.append(fieldName, blob, basename(filePath));
    if (caption) form.append("caption", caption);
    const res = await fetch(`${this.api}/${method}`, { method: "POST", body: form });
    const json = await res.json() as any;
    if (!json.ok) {
      log.error("file send API error", { desc: json.description });
      return false;
    }
    return true;
  }

  async sendFormattedResult(chatId: string, text: string): Promise<void> {
    const maxLen = this.chunkSize;
    const mdChunks = chunkText(toTelegramMarkdown(text), maxLen);
    const rawChunks = chunkText(text, maxLen);
    for (let i = 0; i < mdChunks.length; i++) {
      try {
        await this.call("sendMessage", { chat_id: Number(chatId), text: mdChunks[i], parse_mode: "MarkdownV2" });
      } catch {
        await this.reply(Number(chatId), rawChunks[i] || mdChunks[i]);
      }
    }
  }

  async sendApprovalRequest(chatId: string, taskId: number, description: string): Promise<void> {
    const keyboard = {
      inline_keyboard: [[
        { text: "Approve", callback_data: `approve:${taskId}` },
        { text: "Reject", callback_data: `reject:${taskId}` },
      ]],
    };
    await this.call("sendMessage", {
      chat_id: Number(chatId),
      text: t(this.locale, "approval_request", { id: taskId, desc: description }),
      reply_markup: keyboard,
    });
  }

  // ─── Telegram-specific logic ────────────────────────────────

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
    const msg = update.message || update.edited_message;
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
      await this.handleStatusCommand(String(chatId), String(uid));
      return;
    }
    if (text === "/sessions") {
      await this.handleSessionsCommand(String(chatId), String(uid));
      return;
    }

    // Unsupported media types
    if (msg.voice || msg.video_note || msg.sticker || msg.animation || msg.video) {
      await this.reply(chatId, t(this.locale, "unsupported_media"));
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
        if (buf.length > 25 * 1024 * 1024) {
          await this.reply(chatId, t(this.locale, "upload_failed") + "File too large (max 25MB)");
          return;
        }
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
    const rid = shortId();
    const reqLog = log.withContext({ rid });
    const endTimer = log.time("telegram.handlePrompt");
    // Send typing indicator
    this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const typingInterval = setInterval(() => {
      this.call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    }, 5000);

    try {
      // Multi-session mode: route and execute concurrently (no global lock check)
      if (this.engine.isMultiSessionEnabled()) {
        const placeholder = await this.reply(chatId, t(this.locale, "thinking"));
        const msgId = placeholder.message_id;
        let lastEdit = 0;


        try {
          reqLog.info("running claude (multi-session)", { uid });
          const res = await this.engine.handleUserMessage(uid, text, "telegram", String(chatId), replyToMsgId,
            async (_chunk: string, full: string) => {
              const now = Date.now();
              if (now - lastEdit < EDIT_INTERVAL) return;
              lastEdit = now;
  
              const raw = full.length > 3500 ? full.slice(-3500) : full;
              const closed = closeCodeFences(raw);
              const md = toTelegramMarkdown(closed);
              await this.editMsg(chatId, msgId, md, "MarkdownV2");
            }
          );
          reqLog.info("claude done", { uid, session: res.subSessionId?.slice(0, 8), cost: res.cost?.toFixed(4) });

          // Track response message → sub-session mapping for future reply-to routing
          if (res.subSessionId) {
            this.engine.getSessionManager().trackMessage(String(msgId), String(chatId), res.subSessionId);
          }

          // Check if user has multiple active sessions — add label prefix
          const activeSessions = this.engine.getSessionManager().getActive(uid, "telegram");
          const labelPrefix = activeSessions.length > 1 && res.label ? `[${res.label.slice(0, 30)}]\n` : "";

          await this.sendFormattedResponse(chatId, msgId, res.text, labelPrefix);
        } catch (err: any) {
          reqLog.error("claude error", { error: err?.message });
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
      let editCount = 0;

      try {
        reqLog.info("running claude", { uid });
        const res = await this.engine.runStream(uid, text, "telegram", String(chatId),
          async (_chunk: string, full: string) => {
            const now = Date.now();
            if (now - lastEdit < EDIT_INTERVAL) return;
            lastEdit = now;

            const raw = full.length > 3500 ? full.slice(-3500) : full;
            const closed = closeCodeFences(raw);
            const md = toTelegramMarkdown(closed);
            await this.editMsg(chatId, msgId, md, "MarkdownV2");
          }
        );
        reqLog.info("claude done", { uid, cost: res.cost?.toFixed(4) });

        await this.sendFormattedResponse(chatId, msgId, res.text);
      } catch (err: any) {
        reqLog.error("claude error", { error: err?.message });
        await this.editMsg(chatId, msgId, `Error: ${err.message || "unknown"}`);
      }
    } finally {
      clearInterval(typingInterval);
      endTimer();
    }
  }

  /** Format and send a response with MarkdownV2 + pagination support */
  private async sendFormattedResponse(chatId: number, msgId: number, text: string, labelPrefix: string = ""): Promise<void> {
    const maxLen = this.chunkSize;
    const fullText = labelPrefix + text;
    const md = toTelegramMarkdown(fullText);
    const mdChunks = chunkText(md, maxLen);
    const rawChunks = chunkText(fullText, maxLen);

    if (mdChunks.length <= 1) {
      try {
        await this.call("editMessageText", {
          chat_id: chatId, message_id: msgId, text: mdChunks[0], parse_mode: "MarkdownV2",
        });
      } catch (e: any) {
        log.warn("MarkdownV2 fallback", { error: e?.message?.slice(0, 200) });
        await this.editMsg(chatId, msgId, fullText);
      }
    } else {
      const key = `${chatId}:${msgId}`;
      // Prune expired entries before adding
      for (const [k, v] of this.pages) {
        if (Date.now() - v.ts > TelegramAdapter.PAGE_TTL) this.pages.delete(k);
      }
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
    this.startTimers();
    log.info("starting long polling...", { maxParallel: this.maxParallel, multiSession: this.engine.isMultiSessionEnabled() });
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
    this.stopTimers();
  }

  private async registerCommands(): Promise<void> {
    try {
      await this.call("setMyCommands", { commands: getCommandDescriptions(this.locale) });
      log.info("commands registered");
    } catch (e: any) { log.error("failed to register commands", { error: e?.message }); }
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
}
