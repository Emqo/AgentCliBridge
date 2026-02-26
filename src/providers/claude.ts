import type { Provider, ProviderExecOpts, ProviderStreamEvent } from "./base.js";

export class ClaudeProvider implements Provider {
  readonly binary = "claude";
  readonly supportsSessionResume = true;
  readonly supportsAppendSystemPrompt = true;

  buildArgs(opts: ProviderExecOpts): string[] {
    const args = ["-p", opts.prompt, "--verbose", "--output-format", "stream-json"];
    if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode);
    if (opts.model) args.push("--model", opts.model);
    if (opts.resumeSessionId) args.push("-r", opts.resumeSessionId);
    if (opts.systemPrompt) args.push("--system-prompt", opts.systemPrompt);
    if (opts.appendSystemPrompt) args.push("--append-system-prompt", opts.appendSystemPrompt);
    if (opts.allowedTools?.length) args.push("--allowed-tools", opts.allowedTools.join(","));
    if (opts.maxTurns) args.push("--max-turns", String(opts.maxTurns));
    if (opts.maxBudgetUsd) args.push("--max-budget-usd", String(opts.maxBudgetUsd));
    return args;
  }

  buildEnv(extra: Record<string, string>): Record<string, string> {
    return { ...process.env as Record<string, string>, ...extra };
  }

  parseLine(line: string): ProviderStreamEvent {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
        return { type: "session_init", sessionId: msg.session_id };
      }
      if (msg.type === "assistant" && msg.message?.content) {
        const parts: string[] = [];
        for (const b of msg.message.content) {
          if (b.type === "text" && b.text) parts.push(b.text);
          if (b.type === "tool_use" && b.name) {
            const inp = b.input || {};
            switch (b.name) {
              case "Bash":
                parts.push(`\`\`\`\n{{p_cmd}}${(inp.command || "").slice(0, 200)}\n\`\`\``);
                break;
              case "Read":
                parts.push(`> {{p_read}} \`${inp.file_path || ""}\``);
                break;
              case "Edit":
                parts.push(`> {{p_edit}} \`${inp.file_path || ""}\``);
                break;
              case "Write":
                parts.push(`> {{p_write}} \`${inp.file_path || ""}\``);
                break;
              case "Glob":
                parts.push(`> {{p_search}} \`${inp.pattern || ""}\``);
                break;
              case "Grep":
                parts.push(`> {{p_search}} grep \`${inp.pattern || ""}\``);
                break;
              default:
                parts.push(`> {{p_tool}} ${b.name}`);
            }
          }
        }
        if (parts.length) return { type: "text_chunk", text: parts.join("\n") };
      }
      if (msg.type === "user" && msg.message?.content) {
        for (const b of msg.message.content) {
          if (b.type === "tool_result" && typeof b.content === "string" && b.content.length > 0) {
            const safe = b.content.slice(0, 500).replace(/```/g, "\\`\\`\\`");
            return { type: "text_chunk", text: `\`\`\`\n${safe}\n\`\`\`` };
          }
        }
      }
      if (msg.type === "result") {
        return {
          type: "result",
          text: msg.result || undefined,
          cost: msg.total_cost_usd || undefined,
          isError: msg.is_error || false,
        };
      }
    } catch {}
    return { type: "unknown" };
  }
}
