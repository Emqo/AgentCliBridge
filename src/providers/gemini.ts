import type { Provider, ProviderExecOpts, ProviderStreamEvent } from "./base.js";

export class GeminiProvider implements Provider {
  readonly binary = "gemini";
  readonly supportsSessionResume = true;
  readonly supportsAppendSystemPrompt = false;

  buildArgs(opts: ProviderExecOpts): string[] {
    // Gemini CLI has no --append-system-prompt; inject context into prompt (same as Codex)
    const prompt = opts.appendSystemPrompt
      ? `[System Context]\n${opts.appendSystemPrompt}\n\n[User Message]\n${opts.prompt}`
      : opts.prompt;

    const args = ["-p", prompt, "--output-format", "stream-json"];

    if (opts.model) args.push("--model", opts.model);
    if (opts.resumeSessionId) args.push("-r", opts.resumeSessionId);

    // Map permissionMode to Gemini's approval mode
    if (opts.permissionMode === "acceptEdits" || opts.permissionMode === "bypassPermissions") {
      args.push("--approval-mode", "auto_edit");
    }

    return args;
  }

  buildEnv(extra: Record<string, string>): Record<string, string> {
    return { ...process.env as Record<string, string>, ...extra };
  }

  parseLine(line: string): ProviderStreamEvent {
    try {
      const msg = JSON.parse(line);

      // Session init: {"type":"init","session_id":"..."}
      if (msg.type === "init" && msg.session_id) {
        return { type: "session_init", sessionId: msg.session_id };
      }

      // Assistant message: {"type":"message","role":"assistant","content":"..."}
      if (msg.type === "message" && msg.role === "assistant" && msg.content) {
        return { type: "text_chunk", text: msg.content };
      }

      // Tool use: {"type":"tool_use","tool_name":"...","parameters":{...}}
      if (msg.type === "tool_use" && msg.tool_name) {
        const p = msg.parameters || {};
        switch (msg.tool_name) {
          case "shell": case "run_shell_command":
            return { type: "text_chunk", text: `\`\`\`\n{{p_cmd}}${(p.command || "").slice(0, 200)}\n\`\`\`` };
          case "read_file":
            return { type: "text_chunk", text: `> {{p_read}} \`${p.file_path || ""}\`` };
          case "edit_file": case "write_file":
            return { type: "text_chunk", text: `> {{p_edit}} \`${p.file_path || ""}\`` };
          case "find_files": case "glob":
            return { type: "text_chunk", text: `> {{p_search}} \`${p.pattern || p.file_path || ""}\`` };
          case "grep": case "search_files":
            return { type: "text_chunk", text: `> {{p_search}} grep \`${p.pattern || p.query || ""}\`` };
          default:
            return { type: "text_chunk", text: `> {{p_tool}} ${msg.tool_name}` };
        }
      }

      // Tool result: {"type":"tool_result","status":"...","output":"..."}
      if (msg.type === "tool_result" && msg.output) {
        const safe = String(msg.output).slice(0, 500).replace(/```/g, "\\`\\`\\`");
        return { type: "text_chunk", text: `\`\`\`\n${safe}\n\`\`\`` };
      }

      // Error event
      if (msg.type === "error" && msg.message) {
        return { type: "text_chunk", text: `{{p_warn}} ${msg.message}` };
      }

      // Result: {"type":"result","status":"...","stats":{...}}
      if (msg.type === "result") {
        const cost = this._estimateCost(msg.stats);
        return {
          type: "result",
          text: msg.response || undefined,
          cost: cost || undefined,
          isError: msg.status === "error",
        };
      }
    } catch {}
    return { type: "unknown" };
  }

  /** Estimate cost from Gemini stats.models token usage */
  private _estimateCost(stats?: any): number {
    if (!stats?.models) return 0;
    let totalCost = 0;
    for (const model of Object.values(stats.models) as any[]) {
      const input = model.input_tokens || 0;
      const output = model.output_tokens || 0;
      // Gemini 2.5 Pro pricing estimate: $1.25/1M input, $10/1M output
      totalCost += input * 0.00000125 + output * 0.00001;
    }
    return totalCost;
  }
}
