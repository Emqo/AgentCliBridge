export interface ProviderStreamEvent {
  type: "session_init" | "text_chunk" | "result" | "unknown";
  sessionId?: string;
  text?: string;
  cost?: number;
  isError?: boolean;
}

export interface ProviderExecOpts {
  prompt: string;
  model: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: string;
}

export interface Provider {
  readonly binary: string;
  readonly supportsSessionResume: boolean;
  readonly supportsAppendSystemPrompt: boolean;
  readonly promptViaStdin?: boolean;
  buildArgs(opts: ProviderExecOpts): string[];
  buildEnv(extra: Record<string, string>): Record<string, string>;
  parseLine(line: string): ProviderStreamEvent;
  getStdinPrompt?(opts: ProviderExecOpts): string;
}
