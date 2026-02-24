import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { log, setLogLevel, getLogLevel } from "../src/core/logger.js";

describe("Logger", () => {
  let origLevel: string;
  beforeEach(() => { origLevel = getLogLevel(); });
  afterEach(() => { setLogLevel(origLevel as any); });

  it("child creates sub-logger", () => {
    const child = log.child("test");
    expect(child).toBeDefined();
    expect(child.info).toBeTypeOf("function");
  });

  it("setLogLevel changes level", () => {
    setLogLevel("error");
    expect(getLogLevel()).toBe("error");
    setLogLevel("debug");
    expect(getLogLevel()).toBe("debug");
  });

  it("log methods do not throw", () => {
    const child = log.child("test");
    expect(() => child.debug("test")).not.toThrow();
    expect(() => child.info("test", { key: "val" })).not.toThrow();
    expect(() => child.warn("test")).not.toThrow();
    expect(() => child.error("test")).not.toThrow();
  });
});
