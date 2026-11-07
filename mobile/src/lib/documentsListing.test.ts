import type { DocumentRow } from "./documents";
import {
  appendDocumentsPage,
  documentDateKind,
  documentsListState,
  hasMoreDocuments,
  payeeFilterArgs,
  sortDocuments,
} from "./documentsListing";
import { translations } from "../i18n/translations";

const doc = (id: string, document_number: string, paid_at: string) => ({ id, document_number, paid_at }) as DocumentRow;

describe("payee filter reaches the server", () => {
  it("sends the app user id, or the quick-add participant id, and nothing for all payees", () => {
    expect(payeeFilterArgs({ type: "app", id: "u1", label: "A" })).toEqual({ profile_user_id: "u1", manual_participant_id: null });
    expect(payeeFilterArgs({ type: "manual", id: "m1", label: "B" })).toEqual({ profile_user_id: null, manual_participant_id: "m1" });
    expect(payeeFilterArgs({ type: "all" })).toEqual({ profile_user_id: null, manual_participant_id: null });
  });
});

describe("list state", () => {
  it("keeps loading, failure, no matches and results apart", () => {
    expect(documentsListState({ loading: true, error: false, count: 0 })).toBe("loading");
    expect(documentsListState({ loading: false, error: true, count: 0 })).toBe("error");
    expect(documentsListState({ loading: false, error: false, count: 0 })).toBe("empty");
    expect(documentsListState({ loading: false, error: false, count: 3 })).toBe("ready");
  });

  it("offers more only while fewer rows are loaded than the server counted", () => {
    expect(hasMoreDocuments(200, 516)).toBe(true);
    expect(hasMoreDocuments(516, 516)).toBe(false);
    expect(hasMoreDocuments(0, 0)).toBe(false);
  });
});

describe("paging", () => {
  it("appends a later page without repeating a row that shifted across the page boundary", () => {
    const merged = appendDocumentsPage([doc("a", "001", "2026-07-02"), doc("b", "002", "2026-07-01")], [doc("b", "002", "2026-07-01"), doc("c", "003", "2026-06-30")]);
    expect(merged.map((d) => d.id)).toEqual(["a", "b", "c"]);
  });
});

describe("sorting", () => {
  // 001101 and 001102 share a session start (2026-07-29 15:00 UTC); 001099 is the next morning.
  const rows = [doc("x", "001101", "2026-07-29T15:00:00Z"), doc("y", "001099", "2026-07-30T05:00:00Z"), doc("z", "001102", "2026-07-29T15:00:00Z")];

  it("orders by the listed date, newest first, ties by document number like the server", () => {
    expect(sortDocuments(rows, "desc").map((d) => d.document_number)).toEqual(["001099", "001102", "001101"]);
    expect(sortDocuments(rows, "asc").map((d) => d.document_number)).toEqual(["001101", "001102", "001099"]);
  });
});

describe("date semantics", () => {
  it("names what the listed date is, so a session date is not read as the issue date", () => {
    expect(documentDateKind("session_payment")).toBe("session");
    expect(documentDateKind("account_payment")).toBe("payment");
    expect(documentDateKind("cancellation_penalty")).toBe("cancellation");
    expect(documentDateKind("manual")).toBe("issued");
    expect(documentDateKind(null)).toBe("issued");
    for (const lang of ["en", "he"] as const) {
      for (const k of ["session", "payment", "cancellation", "issued"]) {
        expect(translations[lang][`ui.documentsInvoices.dateKind.${k}`]).toBeTruthy();
      }
    }
  });
});
