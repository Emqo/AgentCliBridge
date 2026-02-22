import { Client, GatewayIntentBits, Message } from "discord.js";
import { Adapter, chunkText } from "./base.js";
import { AgentEngine } from "../core/agent.js";
import { SessionManager } from "../core/session.js";
import { DiscordConfig } from "../core/config.js";

const EDIT_INTERVAL = 1500;

export class DiscordAdapter implements Adapter {
  private client: Client;

  constructor(
    private engine: AgentEngine,
    private sessions: SessionManager,
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

  private isAllowed(userId: string): boolean {
    if (!this.config.allowed_users?.length) return true;
    return this.config.allowed_users.includes(userId);
  }

  private setup(): void {
    this.client.on("messageCreate", async (msg: Message) => {
      if (msg.author.bot) return;
      if (!this.isAllowed(msg.author.id)) return;

      // Only respond if mentioned or in DM
      const isDM = !msg.guild;
      const isMentioned = msg.mentions.has(this.client.user!);
      if (!isDM && !isMentioned) return;

      const text = msg.content.replace(/<@!?\d+>/g, "").trim();
      if (!text) return;

      if (text === "!new") {
        this.sessions.clear(msg.author.id);
        await msg.reply("Session cleared. Starting fresh.");
        return;
      }

      if (this.engine.isLocked(msg.author.id)) {
        await msg.reply("⏳ Still processing your previous request...");
        return;
      }

      const placeholder = await msg.reply("⏳ Thinking...");
      let lastEdit = 0;
      let lastText = "";

      try {
        const res = await this.engine.runStream(
          msg.author.id,
          text,
          "discord",
          async (_chunk, full) => {
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
    });
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
