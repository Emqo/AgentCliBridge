import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { ConfigSchema } from "../src/core/schema.js";

describe("Config Schema", () => {
  it("parses valid minimal config", () => {
    const result = ConfigSchema.safeParse({
      agent: { memory: {}, skill: {}, session: {} },
      platforms: { telegram: {}, discord: {} },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.locale).toBe("en");
      expect(result.data.log_level).toBe("info");
      expect(result.data.endpoints).toEqual([]);
      expect(result.data.agent.max_turns).toBe(50);
      expect(result.data.agent.memory.enabled).toBe(true);
    }
  });

  it("parses full config", () => {
    const result = ConfigSchema.safeParse({
      locale: "zh",
      log_level: "debug",
      endpoints: [{ name: "test", model: "sonnet", provider: "claude" }],
      agent: { max_turns: 100, max_budget_usd: 5.0 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.locale).toBe("zh");
      expect(result.data.agent.max_turns).toBe(100);
      expect(result.data.endpoints[0].provider).toBe("claude");
    }
  });

  it("applies defaults for endpoint provider", () => {
    const result = ConfigSchema.safeParse({
      endpoints: [{ name: "test" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.endpoints[0].provider).toBe("claude");
      expect(result.data.endpoints[0].name).toBe("test");
    }
  });

  it("rejects invalid max_turns type", () => {
    const result = ConfigSchema.safeParse({
      agent: { max_turns: "abc" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative max_budget_usd", () => {
    const result = ConfigSchema.safeParse({
      agent: { max_budget_usd: -1 },
    });
    expect(result.success).toBe(false);
  });
});
