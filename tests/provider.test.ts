import { describe, it, expect } from "vitest";
import { ClaudeProvider } from "../src/providers/claude.js";
import { CodexProvider } from "../src/providers/codex.js";
import { GeminiProvider } from "../src/providers/gemini.js";

describe("ClaudeProvider", () => {
  const p = new ClaudeProvider();

  it("binary is claude", () => {
    expect(p.binary).toBe("claude");
    expect(p.supportsSessionResume).toBe(true);
    expect(p.supportsAppendSystemPrompt).toBe(true);
  });

  it("buildArgs includes prompt and model", () => {
    const args = p.buildArgs({ prompt: "hello", model: "sonnet", permissionMode: "acceptEdits" });
    expect(args).toContain("-p");
    expect(args).toContain("hello");
    expect(args).toContain("--model");
    expect(args).toContain("sonnet");
  });

  it("buildArgs includes session resume", () => {
    const args = p.buildArgs({ prompt: "hi", model: "", resumeSessionId: "sess123" });
    expect(args).toContain("-r");
    expect(args).toContain("sess123");
  });

  it("parseLine session_init", () => {
    const e = p.parseLine(JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }));
    expect(e.type).toBe("session_init");
    expect(e.sessionId).toBe("abc");
  });

  it("parseLine text_chunk", () => {
    const e = p.parseLine(JSON.stringify({
      type: "assistant", message: { content: [{ type: "text", text: "hello" }] },
    }));
    expect(e.type).toBe("text_chunk");
    expect(e.text).toBe("hello");
  });

  it("parseLine result", () => {
    const e = p.parseLine(JSON.stringify({ type: "result", result: "done", total_cost_usd: 0.01 }));
    expect(e.type).toBe("result");
    expect(e.text).toBe("done");
    expect(e.cost).toBe(0.01);
  });

  it("parseLine unknown", () => {
    expect(p.parseLine("not json").type).toBe("unknown");
    expect(p.parseLine(JSON.stringify({ type: "other" })).type).toBe("unknown");
  });

  it("buildEnv passes extra vars", () => {
    const env = p.buildEnv({ AGENT_CLI_BRIDGE_DB: "/tmp/db" });
    expect(env.AGENT_CLI_BRIDGE_DB).toBe("/tmp/db");
  });
});

describe("CodexProvider", () => {
  const p = new CodexProvider();

  it("binary is codex", () => {
    expect(p.binary).toBe("codex");
    expect(p.supportsSessionResume).toBe(true);
    expect(p.supportsAppendSystemPrompt).toBe(false);
  });

  it("buildArgs includes exec and prompt", () => {
    const args = p.buildArgs({ prompt: "hello", model: "o3-mini" });
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("-m");
    expect(args).toContain("o3-mini");
    expect(args[1]).toBe("-");
  });

  it("buildArgs uses exec resume when resumeSessionId provided", () => {
    const args = p.buildArgs({ prompt: "hello", model: "o3-mini", resumeSessionId: "abc-123" });
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("abc-123");
    expect(args[3]).toBe("-");
    expect(args).toContain("--json");
  });

  it("getStdinPrompt prepends system context when appendSystemPrompt given", () => {
    const opts = { prompt: "hello", model: "", appendSystemPrompt: "context" };
    const stdin = p.getStdinPrompt!(opts);
    expect(stdin).toContain("[System Context]");
    expect(stdin).toContain("context");
    expect(stdin).toContain("hello");
  });

  it("parseLine thread.started", () => {
    const e = p.parseLine(JSON.stringify({ type: "thread.started", thread_id: "t1" }));
    expect(e.type).toBe("session_init");
    expect(e.sessionId).toBe("t1");
  });

  it("parseLine item.completed", () => {
    const e = p.parseLine(JSON.stringify({
      type: "item.completed", item: { type: "agent_message", text: "hi" },
    }));
    expect(e.type).toBe("text_chunk");
    expect(e.text).toBe("hi");
  });

  it("parseLine turn.completed", () => {
    const e = p.parseLine(JSON.stringify({
      type: "turn.completed", usage: { input_tokens: 100, output_tokens: 50 },
    }));
    expect(e.type).toBe("result");
    expect(e.cost).toBeGreaterThan(0);
  });

  it("buildEnv passes extra vars", () => {
    const env = p.buildEnv({ FOO: "bar" });
    expect(env.FOO).toBe("bar");
  });
});

describe("GeminiProvider", () => {
  const p = new GeminiProvider();

  it("binary is gemini", () => {
    expect(p.binary).toBe("gemini");
    expect(p.supportsSessionResume).toBe(true);
    expect(p.supportsAppendSystemPrompt).toBe(false);
  });

  it("buildArgs includes prompt and stream-json", () => {
    const args = p.buildArgs({ prompt: "hello", model: "gemini-2.5-pro" });
    expect(args).toContain("-p");
    expect(args).toContain("hello");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    expect(args).toContain("--model");
    expect(args).toContain("gemini-2.5-pro");
  });

  it("buildArgs includes resume flag when resumeSessionId provided", () => {
    const args = p.buildArgs({ prompt: "hello", model: "", resumeSessionId: "sess-456" });
    expect(args).toContain("-r");
    expect(args).toContain("sess-456");
  });

  it("buildArgs prepends system context when appendSystemPrompt given", () => {
    const args = p.buildArgs({ prompt: "hello", model: "", appendSystemPrompt: "context" });
    expect(args[1]).toContain("[System Context]");
    expect(args[1]).toContain("context");
    expect(args[1]).toContain("hello");
  });

  it("buildArgs maps permissionMode to approval-mode", () => {
    const args = p.buildArgs({ prompt: "hi", model: "", permissionMode: "acceptEdits" });
    expect(args).toContain("--approval-mode");
    expect(args).toContain("auto_edit");
  });

  it("parseLine init", () => {
    const e = p.parseLine(JSON.stringify({ type: "init", session_id: "gem-abc" }));
    expect(e.type).toBe("session_init");
    expect(e.sessionId).toBe("gem-abc");
  });

  it("parseLine assistant message", () => {
    const e = p.parseLine(JSON.stringify({ type: "message", role: "assistant", content: "hello world" }));
    expect(e.type).toBe("text_chunk");
    expect(e.text).toBe("hello world");
  });

  it("parseLine result with stats", () => {
    const e = p.parseLine(JSON.stringify({
      type: "result", status: "success", response: "done",
      stats: { models: { "gemini-2.5-pro": { input_tokens: 1000, output_tokens: 500 } } },
    }));
    expect(e.type).toBe("result");
    expect(e.text).toBe("done");
    expect(e.cost).toBeGreaterThan(0);
    expect(e.isError).toBe(false);
  });

  it("parseLine result error", () => {
    const e = p.parseLine(JSON.stringify({ type: "result", status: "error" }));
    expect(e.type).toBe("result");
    expect(e.isError).toBe(true);
  });

  it("parseLine unknown", () => {
    expect(p.parseLine("not json").type).toBe("unknown");
    expect(p.parseLine(JSON.stringify({ type: "tool_use" })).type).toBe("unknown");
  });

  it("buildEnv passes extra vars", () => {
    const env = p.buildEnv({ GOOGLE_API_KEY: "test" });
    expect(env.GOOGLE_API_KEY).toBe("test");
  });
});
