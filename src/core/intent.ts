import { spawn } from "child_process";
import { IntentConfig } from "./config.js";
import { EndpointRotator } from "./keys.js";

export interface IntentResult {
  type: "reminder" | "task" | "memory" | "forget" | "clear_session" | "none";
  description?: string;
  minutes?: number;
}

const patterns: [RegExp, (m: RegExpMatchArray) => IntentResult][] = [
  [/(?:提醒我?|remind\s*me)\s*(\d+)\s*(?:分钟|min(?:ute)?s?|m)\s*(?:后|later)?\s*(.+)/i,
    m => ({ type: "reminder", minutes: +m[1], description: m[2].trim() })],
  [/^(?:添加|加个?|创建|add|create)\s*(?:一个)?(?:任务|task)[：:\s]*(.+)/i,
    m => ({ type: "task", description: m[1].trim() })],
  [/^(?:记住|记下|记忆|帮我记|remember)\s*(?:that|this)?[：:\s]*(.+)/i,
    m => ({ type: "memory", description: m[1].trim() })],
  [/^(?:忘记所有|清除记忆|forget\s*all|clear\s*memo)/i,
    () => ({ type: "forget" })],
  [/^(?:新会话|新对话|new\s*session|clear\s*session)/i,
    () => ({ type: "clear_session" })],
];

/** Loose keywords that hint the message *might* be an intent — worth a Claude check */
const hintPatterns = [
  /提醒|醒我|remind/i,
  /任务|待办|todo|task/i,
  /记住|记下|记得|记忆|帮我记|remember/i,
  /忘记|忘掉|forget/i,
  /新会话|新对话|new\s*session|clear\s*session/i,
  /\d+\s*(?:分钟|min|m|小时|hour|h)\s*(?:后|later)/i,
];

function mightBeIntent(text: string): boolean {
  return hintPatterns.some(re => re.test(text));
}

export function regexDetect(text: string): IntentResult {
  for (const [re, fn] of patterns) {
    const m = text.match(re);
    if (m) return fn(m);
  }
  return { type: "none" };
}

export function claudeDetect(text: string, rotator: EndpointRotator): Promise<IntentResult> {
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve({ type: "none" }), 15000);
    const ep = rotator.count
      ? rotator.next()
      : { name: "cli-default", api_key: "", base_url: "", model: "" };
    const env: Record<string, string> = { ...process.env as Record<string, string> };
    if (ep.api_key) env.ANTHROPIC_API_KEY = ep.api_key;
    if (ep.base_url) env.ANTHROPIC_BASE_URL = ep.base_url;
    const prompt = `You are an intent classifier. Classify the user message into exactly ONE of these types. Output ONLY a single JSON object, nothing else.

Types:
- "reminder": user wants to be reminded later. Extract minutes and description. Example: {"type":"reminder","minutes":5,"description":"check server"}
- "task": user wants to add a task/todo. Extract description. Example: {"type":"task","description":"buy milk"}
- "memory": user wants you to remember something. Extract description. Example: {"type":"memory","description":"I like TypeScript"}
- "none": normal conversation, not an intent. Output: {"type":"none"}

Rules:
- Output ONLY one JSON object on a single line
- Do NOT output any explanation or extra text
- If unsure, output {"type":"none"}

User message: ${text.slice(0, 500)}`;
    const args = ["-p", prompt, "--output-format", "stream-json", "--max-turns", "1", "--max-budget-usd", "0.005"];
    if (ep.model) args.push("--model", ep.model);
    const child = spawn("claude", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    let result = "";
    let buffer = "";
    child.stdout.on("data", (d: Buffer) => {
      buffer += d.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try { const msg = JSON.parse(line); if (msg.type === "result" && msg.result) result = msg.result; } catch {}
      }
    });
    child.on("close", () => {
      clearTimeout(timeout);
      try {
        const m = result.match(/\{[^}]+\}/);
        if (m) { const obj = JSON.parse(m[0]); if (obj.type && obj.type !== "none") { resolve(obj); return; } }
      } catch {}
      resolve({ type: "none" });
    });
    child.on("error", () => { clearTimeout(timeout); resolve({ type: "none" }); });
  });
}

export async function detectIntent(text: string, rotator: EndpointRotator, config?: IntentConfig): Promise<IntentResult> {
  const r = regexDetect(text);
  if (r.type !== "none") return r;
  // Only call Claude fallback if text contains hint keywords (saves cost)
  if (config?.use_claude_fallback !== false && mightBeIntent(text)) {
    return claudeDetect(text, rotator);
  }
  return { type: "none" };
}
