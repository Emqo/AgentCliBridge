import { Bot } from "grammy";
import { Adapter, chunkText } from "./base.js";
import { AgentEngine } from "../core/agent.js";
import { Store } from "../core/store.js";
import { TelegramConfig } from "../core/config.js";
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
      ctx.reply("ClaudeBridge ready. Send any message to talk to Claude.")
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

    this.bot.command("history", async (ctx) => {
      const uid = ctx.from?.id;
      if (!uid) return;
      const rows = this.store.getHistory(String(uid), 5);
      if (!rows.length) { await ctx.reply("No history."); return; }
      const text = rows.reverse().map((r) => {
        const t = new Date(r.created_at).toLocaleString();
        const preview = r.content.slice(0, 150);
        return `[${t}] ${r.role}: ${preview}`;
      }).join("\n\n");
      await ctx.reply(text);
    });

    this.bot.on("message:text", async (ctx) => {
      const uid = ctx.from?.id;
      if (!uid) return;
      const groupId = ctx.chat.type !== "private" ? String(ctx.chat.id) : undefined;
      if (!this.engine.access.isAllowed(String(uid), groupId)) return;

      const text = ctx.message.text;
      if (!text || text.startsWith("/")) return;

      if (this.engine.isLocked(String(uid))) {
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
          String(uid), text, "telegram",
          async (_chunk, full) => {
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