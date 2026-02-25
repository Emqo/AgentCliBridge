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
      if (msg.type === "item.completed" && msg.item?.type === "agent_message" && msg.item.text) {
        return { type: "text_chunk", text: msg.item.text };
      }
      if (msg.type === "turn.completed") {
        const usage = msg.usage || {};
        const cost = ((usage.input_tokens || 0) * 0.000003 + (usage.output_tokens || 0) * 0.000012);
        return { type: "result", cost: cost || undefined };
      }
    } catch {}
    return { type: "unknown" };
  }
}
