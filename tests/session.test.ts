import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/core/store.js";
import { SessionManager } from "../src/core/session.js";

describe("SessionManager", () => {
  let store: Store;
  let mgr: SessionManager;

  beforeEach(() => {
    store = new Store(":memory:");
    mgr = new SessionManager(store, {
      enabled: true, max_per_user: 3, idle_timeout_minutes: 30,
      dispatcher_budget: 0.05, classifier_model: "",
    });
  });

  it("create and get session", () => {
    const s = mgr.create("u1", "telegram", "c1", "topic");
    expect(s.id).toBeTruthy();
    expect(s.label).toBe("topic");
    const got = mgr.get(s.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(s.id);
  });

  it("canCreate respects limit", () => {
    expect(mgr.canCreate("u1", "telegram")).toBe(true);
    mgr.create("u1", "telegram", "c1", "a");
    mgr.create("u1", "telegram", "c1", "b");
    mgr.create("u1", "telegram", "c1", "c");
    expect(mgr.canCreate("u1", "telegram")).toBe(false);
  });

  it("close and closeAll", () => {
    const s1 = mgr.create("u1", "telegram", "c1", "a");
    const s2 = mgr.create("u1", "telegram", "c1", "b");
    mgr.close(s1.id);
    expect(mgr.getActive("u1", "telegram").length).toBe(1);
    mgr.closeAll("u1");
    expect(mgr.getActive("u1", "telegram").length).toBe(0);
  });

  it("isUsable checks status", () => {
    const s = mgr.create("u1", "telegram", "c1", "test");
    expect(mgr.isUsable(s)).toBe(true);
    mgr.close(s.id);
    const closed = mgr.get(s.id)!;
    expect(mgr.isUsable(closed)).toBe(false);
  });

  it("trackMessage and getSessionByMessage", () => {
    const s = mgr.create("u1", "telegram", "c1", "test");
    mgr.trackMessage("msg1", "c1", s.id);
    expect(mgr.getSessionByMessage("msg1", "c1")).toBe(s.id);
    expect(mgr.getSessionByMessage("msg2", "c1")).toBeNull();
  });

  it("touch and addCost", () => {
    const s = mgr.create("u1", "telegram", "c1", "test");
    mgr.touch(s.id);
    mgr.addCost(s.id, 0.5);
    const updated = mgr.get(s.id)!;
    expect(updated.messageCount).toBe(1);
    expect(updated.totalCost).toBeCloseTo(0.5);
  });
});
