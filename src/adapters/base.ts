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
}

/** Split long text into chunks respecting newlines */
export function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
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
  return chunks;
}
