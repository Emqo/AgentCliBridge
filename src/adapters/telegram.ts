import { Bot } from "grammy";
import { Adapter, chunkText } from "./base.js";
import { AgentEngine } from "../core/agent.js";
import { SessionManager } from "../core/session.js";
import { TelegramConfig } from "../core/config.js";
import { toTelegramMarkdown } from "../core/markdown.js";

const EDIT_INTERVAL = 1500; // ms between message edits

export class TelegramAdapter implements Adapter {
  private bot: Bot;

  constructor(
    private engine: AgentEngine,
    private sessions: SessionManager,
    private config: TelegramConfig
  ) {
    this.bot = new Bot(config.token);
    this.setup();
  }

  private isAllowed(userId: number): boolean {
    if (!this.config.allowed_users?.length) return true;
    return this.config.allowed_users.includes(userId);
  }

  private setup(): void {
    this.bot.command("start", (ctx) =>
      ctx.reply("ClaudeBridge ready\\. Send any message to talk to Claude\\.", { parse_mode: "MarkdownV2" })
    );

    this.bot.command("new", async (ctx) => {
      const userId = ctx.from?.id;
      if (userId) this.sessions.clear(String(userId));
      await ctx.reply("Session cleared\\. Starting fresh\\.", { parse_mode: "MarkdownV2" });
    });

    this.bot.on("message:text", async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId || !this.isAllowed(userId)) return;

      const text = ctx.message.text;
      if (!text || text.startsWith("/")) return;

      if (this.engine.isLocked(String(userId))) {
        await ctx.reply("⏳ Still processing your previous request\\.\\.\\.", { parse_mode: "MarkdownV2" });
        return;
      }

      // Send placeholder
      const placeholder = await ctx.reply("⏳ Thinking\\.\\.\\.", { parse_mode: "MarkdownV2" });
      const chatId = placeholder.chat.id;
      const msgId = placeholder.message_id;
      let lastEdit = 0;
      let lastText = "";

      try {
        const res = await this.engine.runStream(
          String(userId),
          text,
          "telegram",
          async (_chunk, full) => {
            const now = Date.now();
            if (now - lastEdit < EDIT_INTERVAL) return;
            const preview = full.slice(-3500) + "\n\n⏳\\.\\.\\.";
            const md = toTelegramMarkdown(preview);
            if (md === lastText) return;
            lastText = md;
            lastEdit = now;
            try {
              await this.bot.api.editMessageText(chatId, msgId, md, { parse_mode: "MarkdownV2" });
            } catch { /* edit may fail if content unchanged */ }
          }
        );

        // Final message(s)
        const maxLen = this.config.chunk_size || 4000;
        const finalMd = toTelegramMarkdown(res.text);
        const chunks = chunkText(finalMd, maxLen);

        // Edit placeholder with first chunk
        try {
          await this.bot.api.editMessageText(chatId, msgId, chunks[0], { parse_mode: "MarkdownV2" });
        } catch {
          await ctx.reply(chunks[0], { parse_mode: "MarkdownV2" });
        }
        // Send remaining chunks as new messages
        for (let i = 1; i < chunks.length; i++) {
          await ctx.reply(chunks[i], { parse_mode: "MarkdownV2" });
        }
      } catch (err: any) {
        console.error("[telegram] error:", err);
        try {
          await this.bot.api.editMessageText(chatId, msgId, `Error: ${err.message || "unknown"}`);
        } catch {
          await ctx.reply(`Error: ${err.message || "unknown"}`);
        }
      }
    });
  }

  async start(): Promise<void> {
    console.log("[telegram] starting bot...");
    this.bot.start();
  }

  stop(): void {
    this.bot.stop();
  }
}
