import { describe, it, expect } from "vitest";
import { ClaudeProvider } from "../src/providers/claude.js";
import { CodexProvider } from "../src/providers/codex.js";

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
    const env = p.buildEnv({ CLAUDEBRIDGE_DB: "/tmp/db" });
    expect(env.CLAUDEBRIDGE_DB).toBe("/tmp/db");
  });
});

describe("CodexProvider", () => {
  const p = new CodexProvider();

  it("binary is codex", () => {
    expect(p.binary).toBe("codex");
    expect(p.supportsSessionResume).toBe(false);
    expect(p.supportsAppendSystemPrompt).toBe(false);
  });

  it("buildArgs includes exec and prompt", () => {
    const args = p.buildArgs({ prompt: "hello", model: "o3-mini" });
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("-m");
    expect(args).toContain("o3-mini");
  });

  it("buildArgs prepends system context when appendSystemPrompt given", () => {
    const args = p.buildArgs({ prompt: "hello", model: "", appendSystemPrompt: "context" });
    expect(args[1]).toContain("[System Context]");
    expect(args[1]).toContain("context");
    expect(args[1]).toContain("hello");
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
