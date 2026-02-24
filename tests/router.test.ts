import { describe, it, expect, beforeEach } from "vitest";
import { Store } from "../src/core/store.js";
import { SessionManager } from "../src/core/session.js";
import { SessionRouter } from "../src/core/router.js";
import { EndpointRotator } from "../src/core/keys.js";

describe("SessionRouter", () => {
  let store: Store;
  let mgr: SessionManager;
  let router: SessionRouter;
  const config = {
    enabled: true, max_per_user: 3, idle_timeout_minutes: 30,
    classifier_budget: 0.05, classifier_model: "",
  };

  beforeEach(() => {
    store = new Store(":memory:");
    mgr = new SessionManager(store, config);
    router = new SessionRouter(mgr, new EndpointRotator([]), config);
  });

  it("tier 2: 0 sessions → create", async () => {
    const d = await router.route("u1", "telegram", "c1", "hello");
    expect(d.action).toBe("create");
    expect(d.label).toBe("hello");
  });

  it("tier 2: 1 session → route to it", async () => {
    const s = mgr.create("u1", "telegram", "c1", "topic");
    const d = await router.route("u1", "telegram", "c1", "hello");
    expect(d.action).toBe("route");
    expect(d.subSessionId).toBe(s.id);
  });

  it("tier 1: reply-to routes to correct session", async () => {
    const s = mgr.create("u1", "telegram", "c1", "topic");
    mgr.trackMessage("msg42", "c1", s.id);
    // Create a second session so tier 2 wouldn't auto-route
    mgr.create("u1", "telegram", "c1", "other");
    const d = await router.route("u1", "telegram", "c1", "reply text", "msg42");
    expect(d.action).toBe("route");
    expect(d.subSessionId).toBe(s.id);
  });

  it("tier 1: reply-to to closed session falls through", async () => {
    const s = mgr.create("u1", "telegram", "c1", "topic");
    mgr.trackMessage("msg42", "c1", s.id);
    mgr.close(s.id);
    const d = await router.route("u1", "telegram", "c1", "reply text", "msg42");
    expect(d.action).toBe("create");
  });
});
