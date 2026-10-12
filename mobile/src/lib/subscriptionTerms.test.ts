import {
  managerTermsStatusText,
  subscriptionTermsProblemKey,
  subscriptionTermsTextProblems,
  termsTextFor,
  type ManagerTermsStatusItem,
} from "./subscriptionTerms";

const t = (k: string) =>
  ({
    "subscriptions.terms.pending": "PENDING",
    "subscriptions.terms.accepted": "ACCEPTED v{v} {date}",
    "subscriptions.terms.notRequired": "NOT_REQUIRED",
    "subscriptions.terms.manualNotRequired": "MANUAL_NOT_REQUIRED",
  })[k] ?? k;
const item = (o: Partial<ManagerTermsStatusItem>): ManagerTermsStatusItem => ({
  subscription_id: "s",
  payee_is_manual: false,
  status: "not_required",
  accepted_version: null,
  accepted_at: null,
  ...o,
});

describe("managerTermsStatusText (from persisted consent records)", () => {
  it("accepted shows version and acceptance date", () => {
    expect(managerTermsStatusText(item({ status: "accepted", accepted_version: 2, accepted_at: "2026-10-12T08:30:00Z" }), t, (d) => `D:${d}`)).toBe(
      "ACCEPTED v2 D:2026-10-12"
    );
  });
  it("pending and not required", () => {
    expect(managerTermsStatusText(item({ status: "pending" }), t, (d) => d)).toBe("PENDING");
    expect(managerTermsStatusText(item({}), t, (d) => d)).toBe("NOT_REQUIRED");
  });
  it("participants without the app are never required", () => {
    expect(managerTermsStatusText(item({ payee_is_manual: true }), t, (d) => d)).toBe("MANUAL_NOT_REQUIRED");
  });
});

describe("termsTextFor", () => {
  const doc = { version: 1, title: "תקנון", title_en: "Terms", body_text: "עברית", body_text_en: "English", effective_at: null };
  it("uses the UI language", () => {
    expect(termsTextFor(doc, "he")).toEqual({ title: "תקנון", body: "עברית" });
    expect(termsTextFor(doc, "en")).toEqual({ title: "Terms", body: "English" });
  });
  it("falls back to the canonical Hebrew text when no English version exists", () => {
    expect(termsTextFor({ ...doc, title_en: null, body_text_en: null }, "en")).toEqual({ title: "תקנון", body: "עברית" });
  });
});

describe("subscriptionTermsTextProblems (mirrors the server's publish validation)", () => {
  const long = "x".repeat(200);
  it("complete in both languages", () => {
    expect(subscriptionTermsTextProblems({ title: "תקנון", title_en: "Terms", body_text: long, body_text_en: long })).toEqual([]);
  });
  it("reports each missing or short part", () => {
    expect(subscriptionTermsTextProblems({ title: " ", title_en: "", body_text: "short", body_text_en: "x".repeat(199) })).toEqual([
      "title_he_missing",
      "title_en_missing",
      "body_he_incomplete",
      "body_en_incomplete",
    ]);
  });
  it("ignores surrounding whitespace when measuring length", () => {
    expect(subscriptionTermsTextProblems({ title: "t", title_en: "t", body_text: `   ${"x".repeat(199)}   `, body_text_en: long })).toEqual([
      "body_he_incomplete",
    ]);
  });
  it("every problem has a translated message key", () => {
    for (const p of ["title_he_missing", "title_en_missing", "body_he_incomplete", "body_en_incomplete"] as const) {
      expect(subscriptionTermsProblemKey(p)).toBe(`subscriptionTermsAdmin.problem.${p}`);
    }
  });
});
