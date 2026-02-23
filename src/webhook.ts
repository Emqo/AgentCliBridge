import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Store } from "./core/store.js";
import { WebhookConfig, CronEntry } from "./core/config.js";

export class WebhookServer {
  private server: ReturnType<typeof createServer> | null = null;
  private cronTimers: ReturnType<typeof setInterval>[] = [];

  constructor(
    private store: Store,
    private config: WebhookConfig,
    private cronEntries: CronEntry[] = []
  ) {}

  start(): void {
    this.server = createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.config.port, () => {
      console.log(`[webhook] HTTP server listening on port ${this.config.port}`);
    });

    // Start cron schedulers
    for (const entry of this.cronEntries) {
      const ms = entry.schedule_minutes * 60000;
      const timer = setInterval(() => {
        try {
          const id = this.store.addTask(entry.user_id, entry.platform, entry.chat_id, entry.description, undefined, true);
          console.log(`[cron] created auto-task #${id}: ${entry.description}`);
        } catch (e) {
          console.error(`[cron] failed to create task:`, e);
        }
      }, ms);
      this.cronTimers.push(timer);
      console.log(`[cron] scheduled every ${entry.schedule_minutes}min: ${entry.description}`);
    }
  }

  stop(): void {
    if (this.server) this.server.close();
    for (const timer of this.cronTimers) clearInterval(timer);
    this.cronTimers = [];
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://localhost:${this.config.port}`);

    // GET /health
    if (req.method === "GET" && url.pathname === "/health") {
      this.json(res, 200, { ok: true, timestamp: new Date().toISOString() });
      return;
    }

    // POST /api/task — Bearer token auth
    if (req.method === "POST" && url.pathname === "/api/task") {
      if (!this.authenticateBearer(req)) {
        this.json(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        const body = await this.readBody(req);
        const data = JSON.parse(body);
        if (!data.user_id || !data.platform || !data.chat_id || !data.description) {
          this.json(res, 400, { error: "Missing required fields: user_id, platform, chat_id, description" });
          return;
        }
        let id: number;
        if (data.approval) {
          id = this.store.addApprovalTask(data.user_id, data.platform, data.chat_id, data.description, data.parent_id);
        } else {
          id = this.store.addTask(data.user_id, data.platform, data.chat_id, data.description, undefined, true, data.parent_id);
        }
        this.json(res, 201, { ok: true, id, status: data.approval ? "approval_pending" : "auto" });
      } catch (e: any) {
        this.json(res, 400, { error: e.message || "Invalid JSON" });
      }
      return;
    }

    // POST /webhook/github — GitHub webhook with HMAC verification
    if (req.method === "POST" && url.pathname === "/webhook/github") {
      const userId = url.searchParams.get("user_id");
      const platform = url.searchParams.get("platform") || "telegram";
      const chatId = url.searchParams.get("chat_id");
      if (!userId || !chatId) {
        this.json(res, 400, { error: "Missing user_id or chat_id query params" });
        return;
      }

      const body = await this.readBody(req);

      // Verify GitHub signature if secret is configured
      if (this.config.github_secret) {
        const signature = req.headers["x-hub-signature-256"] as string;
        if (!signature || !this.verifyGitHubSignature(body, signature)) {
          this.json(res, 403, { error: "Invalid signature" });
          return;
        }
      }

      try {
        const payload = JSON.parse(body);
        const event = req.headers["x-github-event"] as string || "unknown";
        const description = this.buildGitHubDescription(event, payload);
        const id = this.store.addTask(userId, platform, chatId, description, undefined, true);
        console.log(`[webhook] github ${event} → auto-task #${id}`);
        this.json(res, 201, { ok: true, id, event });
      } catch (e: any) {
        this.json(res, 400, { error: e.message || "Invalid payload" });
      }
      return;
    }

    this.json(res, 404, { error: "Not found" });
  }

  private authenticateBearer(req: IncomingMessage): boolean {
    if (!this.config.token) return false;
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    return token === this.config.token;
  }

  private verifyGitHubSignature(body: string, signature: string): boolean {
    const expected = "sha256=" + createHmac("sha256", this.config.github_secret).update(body).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  private buildGitHubDescription(event: string, payload: any): string {
    const repo = payload.repository?.full_name || "unknown";
    switch (event) {
      case "push": {
        const branch = (payload.ref || "").replace("refs/heads/", "");
        const count = payload.commits?.length || 0;
        const msg = payload.head_commit?.message?.split("\n")[0] || "";
        return `[GitHub Push] ${repo}:${branch} — ${count} commit(s). Latest: "${msg}". Review changes and summarize impact.`;
      }
      case "pull_request": {
        const pr = payload.pull_request || {};
        const action = payload.action || "opened";
        return `[GitHub PR #${pr.number}] ${repo} — ${action}: "${pr.title}". Review PR description and provide analysis.`;
      }
      case "issues": {
        const issue = payload.issue || {};
        const action = payload.action || "opened";
        return `[GitHub Issue #${issue.number}] ${repo} — ${action}: "${issue.title}". Analyze and suggest next steps.`;
      }
      default:
        return `[GitHub ${event}] ${repo} — Event received. Analyze and summarize.`;
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => { data += chunk.toString(); });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  private json(res: ServerResponse, status: number, data: any): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }
}
