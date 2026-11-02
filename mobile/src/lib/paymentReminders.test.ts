/// <reference types="node" />
import * as fs from "fs";
import * as path from "path";
import { translations } from "../i18n/translations";
import { classifyRpcOutcome } from "./rpcOutcomes/classify";
import type { ReminderAccountMember, ReminderAccountStatus, ReminderHistoryRow } from "./paymentReminders";

jest.mock("./supabase", () => ({ supabase: {} }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defaultReminderRecipient, parseAccountStatus, reminderCardState } = require("./paymentReminders") as typeof import("./paymentReminders");

const member = (id: string, own: number | null, reason: string | null = null): ReminderAccountMember => ({
  kind: reason === "no_login" ? "manual" : "app",
  id,
  name: id,
  own_balance: own,
  ineligible_reason: reason,
});
const history = (status: ReminderHistoryRow["status"], recipient = "a"): ReminderHistoryRow => ({
  id: "m1",
  recipient_id: recipient,
  recipient_name: recipient,
  sender_name: "x",
  amount: 100,
  shown_amount: null,
  status,
  sent_at: "2026-11-03T10:00:00Z",
  read_at: null,
  closed_at: null,
});
const account = (over: Partial<ReminderAccountStatus>): ReminderAccountStatus => ({
  account_key: "user:a",
  is_family: false,
  family_name: null,
  balance: 210,
  has_hidden: false,
  members: [member("a", 210)],
  history: [],
  ...over,
});

describe("reminderCardState", () => {
  it("allows sending on a real debt", () => {
    const s = reminderCardState(account({}), "a");
    expect(s).toMatchObject({ balanceTone: "owe", canSend: true, showAction: true, notice: null });
  });
  it("offers nothing on an even balance or a credit", () => {
    expect(reminderCardState(account({ balance: 0 }), "a")).toMatchObject({ canSend: false, showAction: false, notice: "nothingOwed" });
    expect(reminderCardState(account({ balance: -120 }), "a")).toMatchObject({ balanceTone: "credit", showAction: false, notice: "credit" });
  });
  it("blocks a second reminder while one is unread, whoever received it", () => {
    const s = reminderCardState(account({ is_family: true, members: [member("a", 300), member("b", -40)], balance: 260, history: [history("pending", "b")] }), "a");
    expect(s.pending?.recipient_id).toBe("b");
    expect(s.canSend).toBe(false);
    expect(s.showAction).toBe(true);
  });
  it("allows another after the last one was read, with no cooldown", () => {
    expect(reminderCardState(account({ history: [history("read")] }), "a").canSend).toBe(true);
  });
  it("explains a family that nets to even although a member owes", () => {
    const s = reminderCardState(account({ is_family: true, balance: 0, members: [member("a", 150), member("b", -150)] }), "a");
    expect(s).toMatchObject({ notice: "familyEven", showAction: false });
  });
  it("does not offer sending to someone with no login or who is not an active athlete", () => {
    expect(reminderCardState(account({ members: [member("a", 95, "no_login")], balance: 95 }), null)).toMatchObject({ notice: "noLogin", showAction: false });
    expect(reminderCardState(account({ members: [member("a", 95, "not_athlete")], balance: 95 }), null)).toMatchObject({ notice: "notEligible", showAction: false });
    expect(reminderCardState(account({ members: [member("a", 95, "account_disabled")], balance: 95 }), null)).toMatchObject({ notice: "notEligible", showAction: false });
  });
  it("does not offer sending when the chosen person cannot receive it", () => {
    const s = reminderCardState(account({ is_family: true, members: [member("a", 300), member("q", 0, "no_login")] }), "q");
    expect(s.canSend).toBe(false);
  });
  it("treats a hidden balance as unknown, never as zero", () => {
    const s = reminderCardState(account({ balance: null, has_hidden: true }), "a");
    expect(s).toMatchObject({ balanceTone: "unknown", notice: "hidden", showAction: false, canSend: false });
  });
});

describe("defaultReminderRecipient", () => {
  const family = account({ is_family: true, members: [member("a", 1), member("b", 1), member("q", 1, "no_login")] });
  it("prefers the person being viewed", () => expect(defaultReminderRecipient(family, "b")).toBe("b"));
  it("falls back to the first who can receive it", () => expect(defaultReminderRecipient(family, "q")).toBe("a"));
  it("is empty when nobody can", () => expect(defaultReminderRecipient(account({ members: [member("q", 1, "no_login")] }), "q")).toBeNull());
});

describe("parseAccountStatus", () => {
  it("keeps a null balance null and turns numeric strings into numbers", () => {
    const parsed = parseAccountStatus({ balance: null, members: [{ kind: "app", id: "a", own_balance: "12.50" }], history: [{ amount: "12.50", shown_amount: null, status: "read" }] });
    expect(parsed.balance).toBeNull();
    expect(parsed.members[0]!.own_balance).toBe(12.5);
    expect(parsed.history[0]!.amount).toBe(12.5);
    expect(parsed.history[0]!.shown_amount).toBeNull();
  });
});

describe("reminder copy", () => {
  it("states only the amount, in both languages and both account types", () => {
    for (const lang of ["en", "he"] as const) {
      for (const key of ["paymentReminder.message", "paymentReminder.messageFamily"]) {
        const text = translations[lang][key]!;
        expect(text.split("{amount}")).toHaveLength(2);
        expect(text).not.toMatch(/session|אימון|charge|חיוב|subscription|מנוי/i);
      }
    }
    expect(translations.he["paymentReminder.message"]).toBe("היי! רצינו להזכיר שקיימת בחשבונך יתרה לתשלום בסך {amount}. נשמח להסדרת התשלום מול הסטודיו. תודה!");
    expect(translations.he["managerMessage.gotIt"]).toBe("הבנתי");
    expect(translations.en["paymentReminder.sender"]).toBe("Shira Fit Studio");
  });
  it("has every reminder string in both languages", () => {
    const keys = (lang: "en" | "he") => Object.keys(translations[lang]).filter((k) => k.startsWith("paymentReminder."));
    expect(keys("he").sort()).toEqual(keys("en").sort());
    expect(keys("en").length).toBeGreaterThan(30);
  });
});

describe("wiring", () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
  it("classifies the send outcomes", () => {
    for (const code of ["already_pending", "balance_changed", "no_debt", "has_hidden_registrations"]) {
      expect(classifyRpcOutcome("send_payment_reminder", code).class).toBe("business");
    }
    expect(classifyRpcOutcome("send_payment_reminder", "recipient_not_eligible").class).toBe("authorization_validation");
  });
  it("is reachable from both the general search and Reports", () => {
    expect(read("src/screens/StaffUsersScreen.tsx")).toContain("AccountBalanceChip");
    expect(read("src/screens/StaffEditProfileScreen.tsx")).toContain("<PaymentReminderCard");
    expect(read("src/screens/ParticipantHistoryScreen.tsx")).toContain("isManagerHistory && athleteId ? (\n              <PaymentReminderCard");
    expect(read("src/screens/ParticipantHistoryScreen.tsx")).toContain("useAccountBalances(isManagerHistory)");
  });
  it("never sends an amount for the server to store, only what the manager saw", () => {
    const lib = read("src/lib/paymentReminders.ts");
    expect(lib).toContain("p_expected_amount: seenAmount");
    expect(lib).not.toMatch(/from\("manager_direct_messages"\)/);
  });
  it("keeps reminders out of the general sent-messages list", () => {
    expect(read("src/lib/managerDirectMessages.ts")).toContain('.eq("message_kind", "general")');
  });
  it("shows the card only to managers", () => {
    expect(read("src/components/PaymentReminderCard.tsx")).toContain("if (!isManager) return null;");
  });
});
