import type { Provider } from "./base.js";
import { ClaudeProvider } from "./claude.js";
import { CodexProvider } from "./codex.js";

const providers = new Map<string, Provider>([
  ["claude", new ClaudeProvider()],
  ["codex", new CodexProvider()],
]);

export function getProvider(name: string): Provider {
  const p = providers.get(name);
  if (!p) throw new Error(`Unknown provider: ${name}. Available: ${[...providers.keys()].join(", ")}`);
  return p;
}
