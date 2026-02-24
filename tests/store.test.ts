import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/core/store.js";

describe("Store", () => {
  let store: Store;
  beforeEach(() => { store = new Store(":memory:"); });

  describe("sessions", () => {
    it("set and get session", () => {
      store.setSession("u1", "sess1", "telegram");
      expect(store.getSession("u1")).toBe("sess1");
    });
    it("clear session", () => {
      store.setSession("u1", "sess1", "telegram");
      store.clearSession("u1");
      expect(store.getSession("u1")).toBeNull();
    });
    it("returns null for unknown user", () => {
      expect(store.getSession("unknown")).toBeNull();
    });
  });

  describe("usage", () => {
    it("record and get usage", () => {
      store.recordUsage("u1", "telegram", 0.5);
      store.recordUsage("u1", "telegram", 0.3);
      const u = store.getUsage("u1");
      expect(u.count).toBe(2);
      expect(u.total_cost).toBeCloseTo(0.8);
    });
    it("get all usage", () => {
      store.recordUsage("u1", "telegram", 1);
      store.recordUsage("u2", "discord", 2);
      const all = store.getUsageAll();
      expect(all.length).toBe(2);
      expect(all[0].total_cost).toBeGreaterThanOrEqual(all[1].total_cost);
    });
  });

  describe("history", () => {
    it("add and get history", () => {
      store.addHistory("u1", "telegram", "user", "hello");
      store.addHistory("u1", "telegram", "assistant", "hi");
      const h = store.getHistory("u1", 10);
      expect(h.length).toBe(2);
    });
  });

  describe("memories", () => {
    it("add and get memories", () => {
      store.addMemory("u1", "likes TypeScript");
      const m = store.getMemories("u1");
      expect(m.length).toBe(1);
      expect(m[0].content).toBe("likes TypeScript");
    });
    it("dedup identical memories", () => {
      store.addMemory("u1", "same");
      const added = store.addMemory("u1", "same");
      expect(added).toBe(false);
      expect(store.getMemories("u1").length).toBe(1);
    });
    it("clear memories", () => {
      store.addMemory("u1", "test");
      store.clearMemories("u1");
      expect(store.getMemories("u1").length).toBe(0);
    });
    it("trim memories", () => {
      for (let i = 0; i < 5; i++) store.addMemory("u1", `mem${i}`);
      store.trimMemories("u1", 3);
      expect(store.getMemories("u1").length).toBe(3);
    });
  });

  describe("tasks", () => {
    it("add and list tasks", () => {
      const id = store.addTask("u1", "telegram", "c1", "buy milk");
      expect(id).toBeGreaterThan(0);
    });
    it("add auto task", () => {
      const id = store.addTask("u1", "telegram", "c1", "auto job", undefined, true);
      const tasks = store.getAutoTasks("u1");
      expect(tasks.length).toBe(1);
      expect(tasks[0].id).toBe(id);
    });
  });

  describe("sub_sessions", () => {
    it("create and get sub-session", () => {
      store.createSubSession("s1", "u1", "telegram", "c1", "topic");
      const s = store.getSubSession("s1");
      expect(s).not.toBeNull();
      expect(s!.label).toBe("topic");
      expect(s!.status).toBe("active");
    });
    it("touch increments message count", () => {
      store.createSubSession("s1", "u1", "telegram", "c1", "");
      store.touchSubSession("s1");
      const s = store.getSubSession("s1");
      expect(s!.message_count).toBe(1);
    });
    it("close sub-session", () => {
      store.createSubSession("s1", "u1", "telegram", "c1", "");
      store.closeSubSession("s1");
      expect(store.getSubSession("s1")!.status).toBe("closed");
    });
    it("get active sub-sessions", () => {
      store.createSubSession("s1", "u1", "telegram", "c1", "a");
      store.createSubSession("s2", "u1", "telegram", "c1", "b");
      store.closeSubSession("s2");
      const active = store.getActiveSubSessions("u1", "telegram");
      expect(active.length).toBe(1);
    });
  });

  describe("close", () => {
    it("close without error", () => {
      expect(() => store.close()).not.toThrow();
    });
  });
});
