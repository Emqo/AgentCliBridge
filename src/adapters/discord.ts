import { Client, GatewayIntentBits, Message } from "discord.js";
import { writeFileSync, existsSync } from "fs";
import { join } from "path";
import { AdapterBase, chunkText, closeCodeFences } from "./base.js";
import { AgentEngine } from "../core/agent.js";
import { Store } from "../core/store.js";
import { reloadConfig, DiscordConfig } from "../core/config.js";
import { t } from "../core/i18n.js";
import { log as rootLog, shortId } from "../core/logger.js";

const log = rootLog.child("discord");

const EDIT_INTERVAL = 1500;

export class DiscordAdapter extends AdapterBase {
  private client: Client;
  private config: DiscordConfig;

  constructor(
    engine: AgentEngine,
    store: Store,
    config: DiscordConfig,
    locale: string = "en"
  ) {
    super(engine, store, locale);
    this.config = config;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
    this.setup();
  }

  get platformName(): string { return "discord"; }
  get chunkSize(): number { return this.config.chunk_size || 1900; }

  reloadConfig(config: DiscordConfig, locale: string): void {
    this.config = config;
    this.locale = locale;
    this.maxParallel = this.engine.getMaxParallel();
  }

  // ─── AdapterBase abstract implementations ───────────────────

  async sendText(chatId: string, text: string): Promise<string | void> {
    const ch = await this.client.channels.fetch(chatId);
    if (ch?.isTextBased() && "send" in ch) {
      const msg = await (ch as any).send(text);
      return msg?.id;
    }
  }

  async sendFile(chatId: string, filePath: string, caption: string): Promise<boolean> {
    const ch = await this.client.channels.fetch(chatId);
    if (!ch?.isTextBased() || !("send" in ch)) return false;
    await (ch as any).send({ content: caption || undefined, files: [filePath] });
    return true;
  }

  async sendFormattedResult(chatId: string, text: string): Promise<void> {
    const maxLen = this.chunkSize;
    const chunks = chunkText(text, maxLen);
    for (const c of chunks) {
      await this.sendText(chatId, c);
    }
  }

  async sendApprovalRequest(chatId: string, taskId: number, description: string): Promise<void> {
    await this.sendText(
      chatId,
      t(this.locale, "approval_request", { id: taskId, desc: description }) +
      `\n\nReply \`!approve ${taskId}\` or \`!reject ${taskId}\``
    );
  }

  // ─── Discord-specific logic ─────────────────────────────────

  private setup(): void {
    this.client.on("messageCreate", async (msg: Message) => {
      if (msg.author.bot) return;
      const isDM = !msg.guild;
      const isMentioned = msg.mentions.has(this.client.user!);
      if (!isDM && !isMentioned) return;

      const groupId = msg.guild ? String(msg.guild.id) : undefined;
      if (!this.engine.access.isAllowed(msg.author.id, groupId)) return;

      const text = msg.content.replace(/<@!?\d+>/g, "").trim();

      // Extract reply-to message ID for session routing
      const replyToMsgId = msg.reference?.messageId || undefined;

      // Management commands
      if (text === "!help") {
        await msg.reply(t(this.locale, "help").replaceAll("/", "!"));
        return;
      }
      if (text === "!new") {
        if (this.engine.isMultiSessionEnabled()) {
          this.engine.getSessionManager().closeAll(msg.author.id);
        }
        this.store.clearSession(msg.author.id);
        await msg.reply(t(this.locale, "session_cleared"));
        return;
      }
      if (text === "!usage") {
        const u = this.store.getUsage(msg.author.id);
        await msg.reply(`Requests: ${u.count}\nTotal cost: $${u.total_cost.toFixed(4)}`);
        return;
      }
      if (text === "!allusage") {
        const rows = this.store.getUsageAll();
        if (!rows.length) { await msg.reply(t(this.locale, "no_usage")); return; }
        const out = rows.map((r) => `${r.user_id}: ${r.count} reqs, $${r.total_cost.toFixed(4)}`).join("\n");
        await msg.reply(out);
        return;
      }
      if (text === "!history") {
        const rows = this.store.getHistory(msg.author.id, 5);
        if (!rows.length) { await msg.reply(t(this.locale, "no_history")); return; }
        const out = rows.reverse().map((r) => {
          const ts = new Date(r.created_at).toLocaleString();
          return `[${ts}] ${r.role}: ${r.content.slice(0, 150)}`;
        }).join("\n\n");
        await msg.reply(out);
        return;
      }
      if (text === "!model") {
        const eps = this.engine.getEndpoints();
        const out = `Endpoints (${eps.length}):\n` +
          eps.map((e) => `• ${e.name}: ${e.model || "default"}`).join("\n");
        await msg.reply(out);
        return;
      }
      if (text === "!reload") {
        try {
          const c = reloadConfig();
          this.engine.reloadConfig(c);
          this.locale = c.locale;
          await msg.reply(t(this.locale, "config_reloaded"));
        } catch (err: any) {
          await msg.reply(t(this.locale, "reload_failed") + err.message);
        }
        return;
      }
      if (text.startsWith("!approve ")) {
        const taskId = parseInt(text.split(" ")[1]);
        if (isNaN(taskId)) { await msg.reply("Usage: !approve <task_id>"); return; }
        const ok = this.store.approveTask(taskId);
        await msg.reply(ok ? t(this.locale, "approval_approved", { id: taskId }) : t(this.locale, "approval_decided", { id: taskId }));
        return;
      }
      if (text.startsWith("!reject ")) {
        const taskId = parseInt(text.split(" ")[1]);
        if (isNaN(taskId)) { await msg.reply("Usage: !reject <task_id>"); return; }
        const ok = this.store.rejectTask(taskId);
        await msg.reply(ok ? t(this.locale, "approval_rejected", { id: taskId }) : t(this.locale, "approval_decided", { id: taskId }));
        return;
      }
      if (text === "!status") {
        await this.handleStatusCommand(String(msg.channelId), msg.author.id);
        return;
      }
      if (text === "!sessions") {
        await this.handleSessionsCommand(String(msg.channelId), msg.author.id);
        return;
      }

      // Unsupported media types (Discord embeds with video/voice attachments)
      if (msg.attachments.size > 0) {
        const unsupportedTypes = ["video/", "audio/"];
        const hasUnsupported = [...msg.attachments.values()].some(a =>
          a.contentType && unsupportedTypes.some(t => a.contentType!.startsWith(t))
        );
        // Only block pure audio/video with no text
        if (hasUnsupported && !text) {
          await msg.reply(t(this.locale, "unsupported_media"));
          return;
        }
      }

      // File upload handling
      if (msg.attachments.size > 0) {
        const ws = this.engine.getWorkDir(msg.author.id);
        for (const [, att] of msg.attachments) {
          try {
            const resp = await fetch(att.url);
            const buf = Buffer.from(await resp.arrayBuffer());
            if (buf.length > 25 * 1024 * 1024) {
              await msg.reply(t(this.locale, "upload_failed") + "File too large (max 25MB)");
              return;
            }
            writeFileSync(join(ws, att.name || "upload"), buf);
          } catch {}
        }
        const names = [...msg.attachments.values()].map(a => a.name).join(", ");
        const prompt = text || `Analyze the uploaded file(s): ${names}`;
        await this.handlePrompt(msg, prompt, replyToMsgId);
        return;
      }

      // Text message — send to Claude (skill system handles intents)
      if (!text) return;
      await this.handlePrompt(msg, text, replyToMsgId);
    });
  }

  private async handlePrompt(msg: Message, text: string, replyToMsgId?: string) {
    const rid = shortId();
    const reqLog = log.withContext({ rid });
    const endTimer = log.time("discord.handlePrompt");
    // Send typing indicator
    try { if ("sendTyping" in msg.channel) await (msg.channel as any).sendTyping(); } catch {}
    const typingInterval = setInterval(() => {
      try { if ("sendTyping" in msg.channel) (msg.channel as any).sendTyping(); } catch {}
    }, 8000);

    try {
      // Multi-session mode: route and execute concurrently
      if (this.engine.isMultiSessionEnabled()) {
        const placeholder = await msg.reply(t(this.locale, "thinking"));
        let lastEdit = 0;
        let lastText = "";


        try {
          const res = await this.engine.handleUserMessage(
            msg.author.id, text, "discord", String(msg.channelId), replyToMsgId,
            async (_chunk: string, full: string) => {
              const now = Date.now();
              if (now - lastEdit < EDIT_INTERVAL) return;
  
              const raw = full.length > 1900 ? full.slice(-1900) : full;
              const preview = closeCodeFences(raw);
              if (preview === lastText) return;
              lastText = preview;
              lastEdit = now;
              try { await placeholder.edit(preview); } catch {}
            }
          );

          // Track response message for reply-to routing
          if (res.subSessionId) {
            this.engine.getSessionManager().trackMessage(placeholder.id, String(msg.channelId), res.subSessionId);
          }

          // Add label prefix if multiple active sessions
          const activeSessions = this.engine.getSessionManager().getActive(msg.author.id, "discord");
          const labelPrefix = activeSessions.length > 1 && res.label ? `[${res.label.slice(0, 30)}]\n` : "";

          await this.sendChunkedResponse(msg, placeholder, res.text, labelPrefix);
        } catch (err: any) {
          reqLog.error("error", { error: err?.message });
          try { await placeholder.edit(`Error: ${err.message || "unknown"}`); } catch {}
        }
        return;
      }

      // Legacy single-session mode
      if (this.engine.isLocked(msg.author.id)) {
        await msg.reply(t(this.locale, "still_processing"));
        return;
      }

      const placeholder = await msg.reply(t(this.locale, "thinking"));
      let lastEdit = 0;
      let lastText = "";
      let editCount = 0;

      try {
        const res = await this.engine.runStream(
          msg.author.id, text, "discord", String(msg.channelId),
          async (_chunk: string, full: string) => {
            const now = Date.now();
            if (now - lastEdit < EDIT_INTERVAL) return;

            const raw = full.length > 1900 ? full.slice(-1900) : full;
            const preview = closeCodeFences(raw);
            if (preview === lastText) return;
            lastText = preview;
            lastEdit = now;
            try { await placeholder.edit(preview); } catch {}
          }
        );

        await this.sendChunkedResponse(msg, placeholder, res.text);
      } catch (err: any) {
        reqLog.error("error", { error: err?.message });
        try { await placeholder.edit(`Error: ${err.message || "unknown"}`); } catch {}
      }
    } finally {
      clearInterval(typingInterval);
      endTimer();
    }
  }

  /** Chunk text and send via edit + follow-up replies */
  private async sendChunkedResponse(msg: Message, placeholder: Message, text: string, labelPrefix: string = ""): Promise<void> {
    const maxLen = this.chunkSize;
    const chunks = chunkText(labelPrefix + text, maxLen);
    try { await placeholder.edit(chunks[0]); } catch {}
    for (let i = 1; i < chunks.length; i++) {
      await msg.reply(chunks[i]);
    }
  }

  async start(): Promise<void> {
    log.info("starting bot...");
    await this.client.login(this.config.token);
    log.info("logged in", { tag: this.client.user?.tag });
    this.startTimers();
    log.info("ready", { maxParallel: this.maxParallel, multiSession: this.engine.isMultiSessionEnabled() });
  }

  stop(): void {
    this.stopTimers();
    this.client.destroy();
  }
}
