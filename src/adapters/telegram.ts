import { Bot } from "grammy";
import { writeFileSync } from "fs";
import { join } from "path";
import { Adapter, chunkText } from "./base.js";
import { AgentEngine } from "../core/agent.js";
import { Store } from "../core/store.js";
import { reloadConfig, TelegramConfig } from "../core/config.js";
import { toTelegramMarkdown } from "../core/markdown.js";

const EDIT_INTERVAL = 1500;

export class TelegramAdapter implements Adapter {
  private bot: Bot;

  constructor(
    private engine: AgentEngine,
    private store: Store,
    private config: TelegramConfig
  ) {
    this.bot = new Bot(config.token);
    this.setup();
  }

  private setup(): void {
    this.bot.command("start", (ctx) =>
      ctx.reply("ClaudeBridge ready.\n\n/help - show commands")
    );

    this.bot.command("help", (ctx) =>
      ctx.reply(
        "Commands:\n" +
        "/new - clear session\n" +
        "/usage - your usage stats\n" +
        "/allusage - all users usage\n" +
        "/history - recent conversations\n" +
        "/model - current model info\n" +
        "/reload - reload config\n" +
        "/help - this message\n\n" +
        "Send text or files to chat with Claude."
      )
    );

    this.bot.command("new", async (ctx) => {
      const uid = ctx.from?.id;
      if (uid) this.store.clearSession(String(uid));
      await ctx.reply("Session cleared.");
    });

    this.bot.command("usage", async (ctx) => {
      const uid = ctx.from?.id;
      if (!uid) return;
      const u = this.store.getUsage(String(uid));
      await ctx.reply(`Requests: ${u.count}\nTotal cost: $${u.total_cost.toFixed(4)}`);
    });

    this.bot.command("allusage", async (ctx) => {
      const rows = this.store.getUsageAll();
      if (!rows.length) { await ctx.reply("No usage data."); return; }
      const text = rows.map((r) =>
        `${r.user_id}: ${r.count} reqs, $${r.total_cost.toFixed(4)}`
      ).join("\n");
      await ctx.reply(text);
    });

    this.bot.command("history", async (ctx) => {
      const uid = ctx.from?.id;
      if (!uid) return;
      const rows = this.store.getHistory(String(uid), 5);
      if (!rows.length) { await ctx.reply("No history."); return; }
      const text = rows.reverse().map((r) => {
        const t = new Date(r.created_at).toLocaleString();
        return `[${t}] ${r.role}: ${r.content.slice(0, 150)}`;
      }).join("\n\n");
      await ctx.reply(text);
    });

    this.bot.command("model", async (ctx) => {
      const eps = this.engine.getEndpoints();
      const text = `Endpoints (${eps.length}):\n` +
        eps.map((e) => `• ${e.name}: ${e.model || "default"}`).join("\n");
      await ctx.reply(text);
    });

    this.bot.command("reload", async (ctx) => {
      try {
        const c = reloadConfig();
        this.engine.reloadConfig(c);
        await ctx.reply("Config reloaded.");
      } catch (err: any) {
        await ctx.reply(`Reload failed: ${err.message}`);
      }
    });

    // File upload handler
    this.bot.on(["message:document", "message:photo"], async (ctx) => {
      const uid = ctx.from?.id;
      if (!uid) return;
      const groupId = ctx.chat.type !== "private" ? String(ctx.chat.id) : undefined;
      if (!this.engine.access.isAllowed(String(uid), groupId)) return;

      let fileId: string | undefined;
      let fileName: string;

      if (ctx.message.document) {
        fileId = ctx.message.document.file_id;
        fileName = ctx.message.document.file_name || "upload";
      } else if (ctx.message.photo) {
        const photo = ctx.message.photo[ctx.message.photo.length - 1];
        fileId = photo.file_id;
        fileName = "photo.jpg";
      } else return;

      try {
        const file = await this.bot.api.getFile(fileId);
        const url = `https://api.telegram.org/file/bot${this.config.token}/${file.file_path}`;
        const resp = await fetch(url);
        const buf = Buffer.from(await resp.arrayBuffer());
        const ws = join("workspaces", String(uid));
        const { mkdirSync } = await import("fs");
        mkdirSync(ws, { recursive: true });
        const savePath = join(ws, fileName);
        writeFileSync(savePath, buf);

        const caption = ctx.message.caption || `Analyze the uploaded file: ${fileName}`;
        await this.handlePrompt(ctx, String(uid), caption, groupId);
      } catch (err: any) {
        console.error("[telegram] file upload error:", err);
        await ctx.reply(`Upload failed: ${err.message}`);
      }
    });

    // Text message handler
    this.bot.on("message:text", async (ctx) => {
      const uid = ctx.from?.id;
      if (!uid) return;
      const groupId = ctx.chat.type !== "private" ? String(ctx.chat.id) : undefined;
      if (!this.engine.access.isAllowed(String(uid), groupId)) return;
      const text = ctx.message.text;
      if (!text || text.startsWith("/")) return;
      await this.handlePrompt(ctx, String(uid), text, groupId);
    });
  }

  private async handlePrompt(ctx: any, uid: string, text: string, _groupId?: string) {
    if (this.engine.isLocked(uid)) {
      await ctx.reply("⏳ Still processing...");
      return;
    }

    const placeholder = await ctx.reply("⏳ Thinking...");
    const chatId = placeholder.chat.id;
    const msgId = placeholder.message_id;
    let lastEdit = 0;
    let lastText = "";

    try {
      const res = await this.engine.runStream(
        uid, text, "telegram",
        async (_chunk: string, full: string) => {
          const now = Date.now();
          if (now - lastEdit < EDIT_INTERVAL) return;
          const preview = full.slice(-3500) + "\n\n⏳...";
          const md = toTelegramMarkdown(preview);
          if (md === lastText) return;
          lastText = md;
          lastEdit = now;
          try { await this.bot.api.editMessageText(chatId, msgId, md, { parse_mode: "MarkdownV2" }); } catch {}
        }
      );

      const maxLen = this.config.chunk_size || 4000;
      const finalMd = toTelegramMarkdown(res.text);
      const chunks = chunkText(finalMd, maxLen);
      try { await this.bot.api.editMessageText(chatId, msgId, chunks[0], { parse_mode: "MarkdownV2" }); } catch {
        await ctx.reply(chunks[0], { parse_mode: "MarkdownV2" });
      }
      for (let i = 1; i < chunks.length; i++) {
        await ctx.reply(chunks[i], { parse_mode: "MarkdownV2" });
      }
    } catch (err: any) {
      console.error("[telegram] error:", err);
      try { await this.bot.api.editMessageText(chatId, msgId, `Error: ${err.message || "unknown"}`); } catch {}
    }
  }

  async start(): Promise<void> {
    console.log("[telegram] starting bot...");
    this.bot.start();
  }

  stop(): void {
    this.bot.stop();
  }
}