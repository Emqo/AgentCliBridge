import { Client, GatewayIntentBits, Message, Attachment } from "discord.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { Adapter, chunkText } from "./base.js";
import { AgentEngine } from "../core/agent.js";
import { Store } from "../core/store.js";
import { reloadConfig, DiscordConfig, IntentConfig } from "../core/config.js";
import { t, getCommandDescriptions } from "../core/i18n.js";
import { detectIntent } from "../core/intent.js";

const EDIT_INTERVAL = 1500;

export class DiscordAdapter implements Adapter {
  private client: Client;
  private reminderTimer?: ReturnType<typeof setInterval>;

  constructor(
    private engine: AgentEngine,
    private store: Store,
    private config: DiscordConfig,
    private locale: string = "en"
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
        await msg.reply(t(this.locale, "help").replaceAll("/", "!"));
        return;
      }
      if (text === "!new") {
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
      if (text.startsWith("!remember ")) {
        const content = text.slice(10).trim();
        if (!content) { await msg.reply(t(this.locale, "usage_remember").replace("/", "!")); return; }
        this.store.addMemory(msg.author.id, content);
        await msg.reply(t(this.locale, "memory_saved"));
        return;
      }
      if (text === "!memories") {
        const mems = this.store.getMemories(msg.author.id);
        if (!mems.length) { await msg.reply(t(this.locale, "no_memories")); return; }
        await msg.reply(mems.map(m => `[${m.source}] ${m.content}`).join("\n\n"));
        return;
      }
      if (text === "!forget") {
        this.store.clearMemories(msg.author.id);
        await msg.reply(t(this.locale, "memories_cleared"));
        return;
      }
      if (text.startsWith("!task ")) {
        const desc = text.slice(6).trim();
        if (!desc) { await msg.reply(t(this.locale, "usage_task").replace("/", "!")); return; }
        const id = this.store.addTask(msg.author.id, "discord", String(msg.channelId), desc);
        await msg.reply(t(this.locale, "task_added", { id }));
        return;
      }
      if (text === "!tasks") {
        const tasks = this.store.getTasks(msg.author.id);
        if (!tasks.length) { await msg.reply(t(this.locale, "no_tasks")); return; }
        await msg.reply(tasks.map(tk => `#${tk.id} ${tk.description}${tk.remind_at ? ` ⏰${new Date(tk.remind_at).toLocaleString()}` : ""}`).join("\n"));
        return;
      }
      if (text.startsWith("!done ")) {
        const id = parseInt(text.slice(6).trim());
        if (isNaN(id)) { await msg.reply(t(this.locale, "usage_done").replace("/", "!")); return; }
        const ok = this.store.completeTask(id, msg.author.id);
        await msg.reply(ok ? t(this.locale, "task_done", { id }) : t(this.locale, "task_not_found", { id }));
        return;
      }
      if (text.startsWith("!remind ")) {
        const match = text.match(/^!remind\s+(\d+)m\s+(.+)$/);
        if (!match) { await msg.reply(t(this.locale, "usage_remind").replace("/", "!")); return; }
        const mins = parseInt(match[1]);
        const desc = match[2].trim();
        const remindAt = Date.now() + mins * 60000;
        const id = this.store.addTask(msg.author.id, "discord", String(msg.channelId), desc, remindAt);
        await msg.reply(t(this.locale, "reminder_set", { id, mins }));
        return;
      }
      if (text.startsWith("!auto ")) {
        const desc = text.slice(6).trim();
        if (!desc) { await msg.reply(t(this.locale, "usage_auto").replace("/", "!")); return; }
        const id = this.store.addTask(msg.author.id, "discord", String(msg.channelId), desc, undefined, true);
        await msg.reply(t(this.locale, "auto_queued", { id }));
        return;
      }
      if (text === "!autotasks") {
        const all = this.store.getAutoTasks(msg.author.id);
        if (!all.length) { await msg.reply(t(this.locale, "no_auto_tasks")); return; }
        await msg.reply(all.map(tk => `#${tk.id} [${tk.status}] ${tk.description}`).join("\n"));
        return;
      }
      if (text.startsWith("!cancelauto ")) {
        const id = parseInt(text.slice(12).trim());
        if (isNaN(id)) { await msg.reply(t(this.locale, "usage_cancelauto").replace("/", "!")); return; }
        this.store.markTaskResult(id, "cancelled");
        await msg.reply(t(this.locale, "auto_cancelled", { id }));
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

      // Intent detection (before sending to Claude)
      if (text && !text.startsWith("!") && this.engine.getIntentConfig()?.enabled !== false) {
        const intent = await detectIntent(text, this.engine.getRotator(), this.engine.getIntentConfig());
        if (intent.type === "reminder" && intent.minutes && intent.description) {
          const remindAt = Date.now() + intent.minutes * 60000;
          const id = this.store.addTask(msg.author.id, "discord", String(msg.channelId), intent.description, remindAt);
          await msg.reply(t(this.locale, "intent_reminder_set", { mins: intent.minutes, desc: intent.description, id }));
          return;
        }
        if (intent.type === "task" && intent.description) {
          const id = this.store.addTask(msg.author.id, "discord", String(msg.channelId), intent.description);
          await msg.reply(t(this.locale, "intent_task_added", { id, desc: intent.description }));
          return;
        }
        if (intent.type === "memory" && intent.description) {
          if (/上面|之前|刚才|这个|那个|above|previous|earlier|this|that/.test(intent.description)) {
            // Fall through to Claude conversation for context resolution
          } else {
            this.store.addMemory(msg.author.id, intent.description, "nlp");
            await msg.reply(t(this.locale, "intent_memory_saved", { desc: intent.description }));
            return;
          }
        }
        if (intent.type === "forget") {
          this.store.clearMemories(msg.author.id);
          await msg.reply(t(this.locale, "memories_cleared"));
          return;
        }
        if (intent.type === "clear_session") {
          this.store.clearSession(msg.author.id);
          await msg.reply(t(this.locale, "session_cleared"));
          return;
        }
      }

      if (!text) return;
      await this.handlePrompt(msg, text);
    });
  }

  private async handlePrompt(msg: Message, text: string) {
    if (this.engine.isLocked(msg.author.id)) {
      await msg.reply(t(this.locale, "still_processing"));
      return;
    }

    const placeholder = await msg.reply(t(this.locale, "thinking"));
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
    this.reminderTimer = setInterval(() => this.checkReminders(), 30000);
  }

  stop(): void {
    if (this.reminderTimer) clearInterval(this.reminderTimer);
    this.client.destroy();
  }

  private async checkReminders(): Promise<void> {
    try {
      const due = this.store.getDueReminders().filter(r => r.platform === "discord");
      for (const r of due) {
        const ch = await this.client.channels.fetch(r.chat_id);
        if (ch?.isTextBased() && "send" in ch) await (ch as any).send(t(this.locale, "reminder_notify", { desc: r.description }));
        this.store.markReminderSent(r.id);
      }
    } catch (e) { console.error("[discord] reminder error:", e); }
  }
}