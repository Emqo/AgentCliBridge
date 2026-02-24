import { AgentResponse } from "../core/agent.js";

export interface MessageContext {
  userId: string;
  text: string;
  platform: string;
  reply: (text: string) => Promise<void>;
}

export interface Adapter {
  start(): Promise<void>;
  stop(): void;
  reloadConfig?(config: any, locale: string): void;
}

/** Split long text into chunks respecting newlines, with code-block-aware balancing */
export function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  // Phase 1: split by newlines (existing logic)
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n", maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }

  // Phase 2: balance code fences across chunks
  // Ensures each chunk is self-contained valid MarkdownV2
  let inCode = false;
  let lang = "";

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const startsInCode: boolean = inCode;

    // Scan fences in original chunk to determine end state and track language
    const fenceRegex = /```(\w*)/g;
    let toggleState: boolean = startsInCode;
    let m: RegExpExecArray | null;
    while ((m = fenceRegex.exec(chunk)) !== null) {
      // Opening fence (not in code) → track language
      if (!toggleState && m[1]) {
        lang = m[1];
      }
      toggleState = !toggleState;
    }
    inCode = toggleState;

    // Apply fixes: reopen/close code blocks as needed
    let fixed = chunk;
    if (startsInCode) {
      fixed = "```" + lang + "\n" + fixed;
    }
    if (inCode) {
      fixed = fixed + "\n```";
      // inCode stays true — next chunk's content is still logically inside code
    }

    chunks[i] = fixed;
  }

  return chunks;
}
