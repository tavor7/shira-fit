import { classifyRpcOutcome, classifyWith, type OutcomeRegistry } from "./classify";

/** A small synthetic registry exercising every rule type. */
const R: OutcomeRegistry = {
  globalRules: {
    full: ["business", "global business"],
    forbidden: "authorization_validation",
    boom: "technical",
    maybe: "uncertain",
  },
  operationRules: {
    op_a: { not_found: "business", full: ["technical", "override"], local_only: "business" },
    op_b: { not_found: "technical", relayed_code: ["business", "from b"] },
    op_c: {},
  },
  delegates: { op_c: ["op_b"], op_loop1: ["op_loop2"], op_loop2: ["op_loop1"], op_deep: ["op_c"] },
  dynamicErrorSites: { op_a: ["sqlerrm"] },
};

describe("classifyWith: precedence and classes", () => {
  it("known global business code -> business", () => {
    const c = classifyWith(R, "any_op", "full");
    expect(c.class).toBe("business");
    expect(c.source).toBe("global");
  });
  it("known global authorization code -> authorization_validation", () => {
    expect(classifyWith(R, "any_op", "forbidden").class).toBe("authorization_validation");
  });
  it("known technical code -> technical", () => {
    expect(classifyWith(R, "any_op", "boom").class).toBe("technical");
  });
  it("registered ambiguous code -> uncertain (not unknown)", () => {
    const c = classifyWith(R, "any_op", "maybe");
    expect(c.class).toBe("uncertain");
    expect(c.class).not.toBe("unknown");
  });
  it("operation-specific rule beats the global rule", () => {
    const c = classifyWith(R, "op_a", "full");
    expect(c).toMatchObject({ class: "technical", source: "operation", rationale: "override" });
    expect(classifyWith(R, "other", "full").class).toBe("business");
  });
  it("the same code means different things in different operations", () => {
    expect(classifyWith(R, "op_a", "not_found").class).toBe("business");
    expect(classifyWith(R, "op_b", "not_found").class).toBe("technical");
  });
  it("a code registered for one operation is NOT applied to another operation", () => {
    expect(classifyWith(R, "op_b", "local_only").class).toBe("unknown");
    expect(classifyWith(R, "unregistered_op", "not_found").class).toBe("unknown");
    expect(classifyWith(R, "unregistered_op", "local_only").class).toBe("unknown");
  });
  it("relays: an operation that relays a delegate inherits the delegate's rules, own rules still win", () => {
    expect(classifyWith(R, "op_c", "relayed_code")).toMatchObject({ class: "business", source: "delegate", via: "op_b" });
    expect(classifyWith(R, "op_c", "not_found")).toMatchObject({ class: "technical", via: "op_b" });
    expect(classifyWith(R, "op_deep", "relayed_code")).toMatchObject({ source: "delegate", via: "op_b" });
  });
  it("a relay does not leak codes the delegate never registered", () => {
    expect(classifyWith(R, "op_c", "not_registered_anywhere").class).toBe("unknown");
  });
  it("relay cycles terminate", () => {
    expect(classifyWith(R, "op_loop1", "x").class).toBe("unknown");
  });
  it("unknown code -> unknown, a real result of lookup", () => {
    const c = classifyWith(R, "op_a", "never_seen");
    expect(c).toMatchObject({ class: "unknown", source: "none" });
  });
  it("flags operations that can return raw dynamic text, without classifying that text", () => {
    expect(classifyWith(R, "op_a", 'duplicate key value violates unique constraint "x"')).toMatchObject({
      class: "unknown",
      dynamicErrorPossible: true,
    });
    expect(classifyWith(R, "op_b", "never_seen").dynamicErrorPossible).toBeUndefined();
  });
  it("lookup is exact and own-property only (no prototype pollution, no case folding, no trimming)", () => {
    for (const code of ["constructor", "__proto__", "toString", "hasOwnProperty", "FULL", " full", "full "]) {
      expect(classifyWith({ ...R, globalRules: { full: "business" } }, "op_a", code).class).toBe("unknown");
    }
    expect(classifyWith(R, "constructor", "full").class).toBe("business");
    expect(classifyWith(R, "__proto__", "x").class).toBe("unknown");
  });
});

describe("naming patterns never silently classify an unknown code", () => {
  const wide: OutcomeRegistry = {
    globalRules: { forbidden: "authorization_validation" },
    operationRules: { op: { not_found: "business" } },
    delegates: {},
    dynamicErrorSites: {},
  };
  it.each([
    "not_something",
    "invalid_something",
    "already_something",
    "something_required",
    "not_found_v2",
    "invalid_amount",
    "already_registered",
    "name_required",
    "not_authenticated",
  ])("%s is unknown unless explicitly registered", (code) => {
    expect(classifyWith(wide, "op", code).class).toBe("unknown");
  });
});

describe("classification has no side effects", () => {
  it("does not mutate the registry, logs nothing, and is deterministic", () => {
    const snapshot = JSON.stringify(R);
    const log = jest.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    const err = jest.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = jest.fn();
    const originalFetch = (globalThis as { fetch?: unknown }).fetch;
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;
    try {
      const a = classifyWith(R, "op_c", "relayed_code");
      const b = classifyWith(R, "op_c", "relayed_code");
      expect(a).toEqual(b);
      classifyWith(R, "x", "y");
      classifyRpcOutcome("register_for_session", "full");
      classifyRpcOutcome("register_for_session", "brand_new_code");
      expect(JSON.stringify(R)).toBe(snapshot);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      (globalThis as { fetch?: unknown }).fetch = originalFetch;
      log.mockRestore();
      warn.mockRestore();
      err.mockRestore();
    }
  });
  it("the classification result is not shared mutable state", () => {
    const c1 = classifyWith(R, "op_a", "full") as { class: string };
    (c1 as { class: string }).class = "business";
    expect(classifyWith(R, "op_a", "full").class).toBe("technical");
  });
});

describe("the real registry (spot checks of reviewed decisions)", () => {
  it("expected business outcomes of registration", () => {
    for (const code of ["full", "already_registered", "registration_closed", "session_ended", "subscription_limit_exceeded"]) {
      expect(classifyRpcOutcome("register_for_session", code).class).toBe("business");
    }
  });
  it("global authorization codes apply to any operation, including future ones", () => {
    expect(classifyRpcOutcome("a_future_rpc", "not_authenticated").class).toBe("authorization_validation");
    expect(classifyRpcOutcome("a_future_rpc", "forbidden").class).toBe("authorization_validation");
  });
  it("the same code differs by operation: session_not_found", () => {
    expect(classifyRpcOutcome("register_for_session", "session_not_found").class).toBe("business");
    expect(classifyRpcOutcome("update_session_note", "session_not_found").class).toBe("technical");
    expect(classifyRpcOutcome("manager_set_cancellation_charge", "session_not_found").class).toBe("technical");
  });
  it("the same code differs by operation: not_found and account_disabled", () => {
    expect(classifyRpcOutcome("cancel_document", "not_found").class).toBe("business");
    expect(classifyRpcOutcome("get_current_legal_document", "not_found").class).toBe("technical");
    expect(classifyRpcOutcome("register_for_session", "account_disabled").class).toBe("authorization_validation");
    expect(classifyRpcOutcome("staff_move_session_participant", "account_disabled").class).toBe("business");
  });
  it("invariant violations are technical and ambiguous races stay uncertain", () => {
    expect(classifyRpcOutcome("register_for_session", "no_profile").class).toBe("technical");
    expect(classifyRpcOutcome("freeze_subscription", "no_current_version").class).toBe("technical");
    expect(classifyRpcOutcome("cancel_registration", "update_failed").class).toBe("uncertain");
    expect(classifyRpcOutcome("edit_subscription_version", "concurrent_modification").class).toBe("uncertain");
  });
  it("a relaying RPC resolves the relayed helper's codes", () => {
    expect(classifyRpcOutcome("coach_add_athlete", "subscription_limit_exceeded")).toMatchObject({
      class: "business",
      source: "delegate",
      via: "_coach_add_athlete_core",
    });
    expect(classifyRpcOutcome("stop_subscription", "freeze_overlap").class).toBe("business");
    expect(classifyRpcOutcome("manager_revert_activity_event", "session_full").class).toBe("business");
  });
  it("a known code used by an operation that never registered it is UNKNOWN, not suppressed", () => {
    expect(classifyRpcOutcome("register_for_session", "invalid_amount").class).toBe("unknown");
    expect(classifyRpcOutcome("cancel_registration", "full").class).toBe("unknown");
    expect(classifyRpcOutcome("brand_new_rpc", "full").class).toBe("unknown");
    expect(classifyRpcOutcome("coach_add_athlete", "full").class).toBe("business"); // relayed from _coach_add_athlete_core
    expect(classifyRpcOutcome("coach_add_athlete", "invalid_amount").class).toBe("unknown");
  });
  it("naming patterns stay unknown on the real registry", () => {
    for (const code of ["not_something", "invalid_something", "already_something", "something_required"]) {
      expect(classifyRpcOutcome("register_for_session", code).class).toBe("unknown");
      expect(classifyRpcOutcome("a_future_rpc", code).class).toBe("unknown");
    }
  });
  it("raw database text is never classified", () => {
    const c = classifyRpcOutcome("coach_add_athlete", 'insert or update on table "x" violates foreign key constraint');
    expect(c).toMatchObject({ class: "unknown", dynamicErrorPossible: true });
  });
});
