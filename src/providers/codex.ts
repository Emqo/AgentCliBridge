import type { Provider, ProviderExecOpts, ProviderStreamEvent } from "./base.js";

export class CodexProvider implements Provider {
  readonly binary = "codex";
  readonly supportsSessionResume = true;
  readonly supportsAppendSystemPrompt = false;
  readonly promptViaStdin = true;

  buildArgs(opts: ProviderExecOpts): string[] {
    if (opts.resumeSessionId) {
      const args = ["exec", "resume", opts.resumeSessionId, "-", "--json", "--dangerously-bypass-approvals-and-sandbox"];
      if (opts.model) args.push("-m", opts.model);
      return args;
    }
    const args = ["exec", "-", "--json", "--dangerously-bypass-approvals-and-sandbox"];
    if (opts.model) args.push("-m", opts.model);
    return args;
  }

  getStdinPrompt(opts: ProviderExecOpts): string {
    return opts.appendSystemPrompt
      ? `[System Context]\n${opts.appendSystemPrompt}\n\n[User Message]\n${opts.prompt}`
      : opts.prompt;
  }

  buildEnv(extra: Record<string, string>): Record<string, string> {
    return { ...process.env as Record<string, string>, ...extra };
  }

  parseLine(line: string): ProviderStreamEvent {
    try {
      const msg = JSON.parse(line);
      if (msg.type === "thread.started" && msg.thread_id) {
        return { type: "session_init", sessionId: msg.thread_id };
      }
      if (msg.type === "item.completed" && msg.item) {
        const item = msg.item;
        switch (item.type) {
          case "agent_message":
            if (item.text) return { type: "text_chunk", text: item.text };
            break;
          case "reasoning":
            if (item.text) return { type: "text_chunk", text: `> {{p_thinking}}: ${item.text.slice(0, 100)}` };
            break;
          case "command_execution":
            if (item.command) {
              const cmd = item.command.replace(/^\/bin\/bash -lc ['"]?/, "").replace(/['"]?$/, "").slice(0, 200);
              const exit = item.exit_code != null ? ` (exit ${item.exit_code})` : "";
              const output = item.aggregated_output
                ? "\n" + item.aggregated_output.slice(0, 500).replace(/```/g, "\\`\\`\\`")
                : "";
              return { type: "text_chunk", text: `\`\`\`\n{{p_cmd}}${cmd}${exit}${output}\n\`\`\`` };
            }
            break;
          case "file_change":
            if (item.changes?.length) {
              const files = item.changes.map((c: any) =>
                `> \`${c.kind === "add" ? "{{p_file_add}}" : "{{p_file_mod}}"}${c.path}\``
              ).join("\n");
              return { type: "text_chunk", text: files };
            }
            break;
          case "todo_list":
            if (item.items?.length) {
              const list = item.items.map((t: any) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("\n");
              return { type: "text_chunk", text: `\`\`\`\n${list}\n\`\`\`` };
            }
            break;
        }
      }
      if (msg.type === "item.updated" && msg.item?.type === "todo_list" && msg.item.items?.length) {
        const list = msg.item.items.map((t: any) => `${t.completed ? "[x]" : "[ ]"} ${t.text}`).join("\n");
        return { type: "text_chunk", text: `\`\`\`\n${list}\n\`\`\`` };
      }
      if (msg.type === "turn.completed") {
        const usage = msg.usage || {};
        const cost = ((usage.input_tokens || 0) * 0.000003 + (usage.output_tokens || 0) * 0.000012);
        return { type: "result", cost: cost || undefined };
      }
      if (msg.type === "turn.failed") {
        return { type: "result", text: msg.error?.message || "turn failed", isError: true };
      }
      if (msg.type === "error" && msg.message) {
        return { type: "text_chunk", text: `{{p_warn}} ${msg.message}` };
      }
    } catch {}
    return { type: "unknown" };
  }
}
