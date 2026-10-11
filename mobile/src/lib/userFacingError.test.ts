import { classifyUserError, userFacingErrorMessage } from "./userFacingError";
import { SupabaseQueryError } from "./supabaseErrors";

describe("classifyUserError", () => {
  it("treats fetch failures as network errors (Chrome, Safari, React Native)", () => {
    expect(classifyUserError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyUserError(new TypeError("Load failed"))).toBe("network");
    expect(classifyUserError(new TypeError("Network request failed"))).toBe("network");
  });

  it("treats a single-row miss as not found", () => {
    expect(classifyUserError({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" })).toBe("notFound");
    expect(classifyUserError(new Error("Cannot coerce the result to a single JSON object"))).toBe("notFound");
    const wrapped = new SupabaseQueryError("load session", {
      code: "PGRST116",
      message: "Cannot coerce the result to a single JSON object",
      details: "",
      hint: "",
      name: "PostgrestError",
    } as never);
    expect(classifyUserError(wrapped)).toBe("notFound");
  });

  it("recognises expired sessions and missing permissions", () => {
    expect(classifyUserError(new Error("JWT expired"))).toBe("session");
    expect(classifyUserError({ code: "42501", message: "permission denied for table x" })).toBe("permission");
    expect(classifyUserError({ status: 403, message: "x" })).toBe("permission");
  });

  it("falls back to a generic message for anything else", () => {
    expect(classifyUserError(new Error("duplicate key value violates unique constraint"))).toBe("unknown");
    expect(classifyUserError(undefined)).toBe("unknown");
  });
});

describe("userFacingErrorMessage", () => {
  it("never returns the raw error text", () => {
    const t = (k: string) => `<${k}>`;
    expect(userFacingErrorMessage(new TypeError("Failed to fetch"), t)).toBe("<errors.network>");
    expect(userFacingErrorMessage(new Error("Cannot coerce the result to a single JSON object"), t)).toBe("<errors.notFound>");
    expect(userFacingErrorMessage({ code: "42P01", message: "relation \"sessions\" does not exist" }, t)).toBe("<errors.generic>");
  });
});

describe("messages that are already written for people", () => {
  const t = (k: string) => `<${k}>`;
  it("keeps database business-rule messages (P0001)", () => {
    expect(userFacingErrorMessage({ code: "P0001", message: "Registration closes 2 hours before the session" }, t)).toBe(
      "Registration closes 2 hours before the session"
    );
    const wrapped = new SupabaseQueryError("register", { code: "P0001", message: "Session is full", details: "", hint: "", name: "PostgrestError" } as never);
    expect(userFacingErrorMessage(wrapped, t)).toBe("Session is full");
  });

  it("keeps readable messages thrown by app code", () => {
    expect(userFacingErrorMessage(new Error("יש לבחור מאמן"), t)).toBe("יש לבחור מאמן");
  });

  it("hides SQL and integrity details", () => {
    expect(userFacingErrorMessage({ code: "23505", message: "duplicate key value violates unique constraint \"x\"" }, t)).toBe("<errors.generic>");
    expect(userFacingErrorMessage(new TypeError("Cannot read properties of undefined (reading 'id')"), t)).toBe("<errors.generic>");
  });
});

describe("toUserFacingText", () => {
  const t = (k: string) => `<${k}>`;
  it("rewrites technical text and keeps everything else", () => {
    const { toUserFacingText } = jest.requireActual("./userFacingError") as typeof import("./userFacingError");
    expect(toUserFacingText("TypeError: Failed to fetch", t)).toBe("<errors.network>");
    expect(toUserFacingText("Cannot coerce the result to a single JSON object", t)).toBe("<errors.notFound>");
    expect(toUserFacingText('insert or update on table "x" violates foreign key constraint', t)).toBe("<errors.generic>");
    expect(toUserFacingText("Saved", t)).toBe("Saved");
    expect(toUserFacingText("ההרשמה נסגרת שעתיים לפני האימון", t)).toBe("ההרשמה נסגרת שעתיים לפני האימון");
    expect(toUserFacingText(undefined, t)).toBeUndefined();
  });
});

describe("plain text that merely mentions connections", () => {
  it("is not mistaken for a network failure", () => {
    const t = (k: string) => `<${k}>`;
    const { toUserFacingText } = jest.requireActual("./userFacingError") as typeof import("./userFacingError");
    expect(toUserFacingText("Connected to WhatsApp", t)).toBe("Connected to WhatsApp");
    expect(toUserFacingText("Session timeout settings saved", t)).toBe("Session timeout settings saved");
  });
});
