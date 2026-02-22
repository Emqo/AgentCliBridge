import { Client, GatewayIntentBits, Message, Attachment } from "discord.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Adapter, chunkText } from "./base.js";
import { AgentEngine } from "../core/agent.js";
import { Store } from "../core/store.js";
import { reloadConfig, DiscordConfig } from "../core/config.js";

const EDIT_INTERVAL = 1500;

export class DiscordAdapter implements Adapter {
  private client: Client;

  constructor(
    private engine: AgentEngine,
    private store: Store,
    private config: DiscordConfig
  ) {
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

  private setup(): void {
    this.client.on("messageCreate", async (msg: Message) => {
      if (msg.author.bot) return;
      const isDM = !msg.guild;
      const isMentioned = msg.mentions.has(this.client.user!);
      if (!isDM && !isMentioned) return;

      const groupId = msg.guild ? String(msg.guild.id) : undefined;
      if (!this.engine.access.isAllowed(msg.author.id, groupId)) return;

      const text = msg.content.replace(/<@!?\d+>/g, "").trim();

      // Commands
      if (text === "!help") {
        await msg.reply(
          "Commands:\n" +
          "!new - clear session\n" +
          "!usage - your usage stats\n" +
          "!allusage - all users usage\n" +
          "!history - recent conversations\n" +
          "!model - current model info\n" +
          "!reload - reload config\n" +
          "!help - this message\n\n" +
          "Send text or attach files to chat with Claude."
        );
        return;
      }
      if (text === "!new") {
        this.store.clearSession(msg.author.id);
        await msg.reply("Session cleared.");
        return;
      }
      if (text === "!usage") {
        const u = this.store.getUsage(msg.author.id);
        await msg.reply(`Requests: ${u.count}\nTotal cost: $${u.total_cost.toFixed(4)}`);
        return;
      }
      if (text === "!allusage") {
        const rows = this.store.getUsageAll();
        if (!rows.length) { await msg.reply("No usage data."); return; }
        const out = rows.map((r) => `${r.user_id}: ${r.count} reqs, $${r.total_cost.toFixed(4)}`).join("\n");
        await msg.reply(out);
        return;
      }
      if (text === "!history") {
        const rows = this.store.getHistory(msg.author.id, 5);
        if (!rows.length) { await msg.reply("No history."); return; }
        const out = rows.reverse().map((r) => {
          const t = new Date(r.created_at).toLocaleString();
          return `[${t}] ${r.role}: ${r.content.slice(0, 150)}`;
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
          await msg.reply("Config reloaded.");
        } catch (err: any) {
          await msg.reply(`Reload failed: ${err.message}`);
        }
        return;
      }

      // File upload handling
      if (msg.attachments.size > 0) {
        const ws = join("workspaces", msg.author.id);
        mkdirSync(ws, { recursive: true });
        for (const [, att] of msg.attachments) {
          try {
            const resp = await fetch(att.url);
            const buf = Buffer.from(await resp.arrayBuffer());
            writeFileSync(join(ws, att.name || "upload"), buf);
          } catch {}
        }
        const names = [...msg.attachments.values()].map(a => a.name).join(", ");
        const prompt = text || `Analyze the uploaded file(s): ${names}`;
        await this.handlePrompt(msg, prompt);
        return;
      }

      if (!text) return;
      await this.handlePrompt(msg, text);
    });
  }

  private async handlePrompt(msg: Message, text: string) {
    if (this.engine.isLocked(msg.author.id)) {
      await msg.reply("⏳ Still processing...");
      return;
    }

    const placeholder = await msg.reply("⏳ Thinking...");
    let lastEdit = 0;
    let lastText = "";

    try {
      const res = await this.engine.runStream(
        msg.author.id, text, "discord",
        async (_chunk: string, full: string) => {
          const now = Date.now();
          if (now - lastEdit < EDIT_INTERVAL) return;
          const preview = full.slice(-1900) + "\n\n⏳...";
          if (preview === lastText) return;
          lastText = preview;
          lastEdit = now;
          try { await placeholder.edit(preview); } catch {}
        }
      );

      const maxLen = this.config.chunk_size || 1900;
      const chunks = chunkText(res.text, maxLen);
      try { await placeholder.edit(chunks[0]); } catch {}
      for (let i = 1; i < chunks.length; i++) {
        await msg.reply(chunks[i]);
      }
    } catch (err: any) {
      console.error("[discord] error:", err);
      try { await placeholder.edit(`Error: ${err.message || "unknown"}`); } catch {}
    }
  }

  async start(): Promise<void> {
    console.log("[discord] starting bot...");
    await this.client.login(this.config.token);
    console.log(`[discord] logged in as ${this.client.user?.tag}`);
  }

  stop(): void {
    this.client.destroy();
  }
}