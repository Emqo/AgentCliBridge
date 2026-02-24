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
        const texts = msg.message.content
          .filter((b: any) => b.type === "text" && b.text)
          .map((b: any) => b.text);
        if (texts.length) return { type: "text_chunk", text: texts.join("") };
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
