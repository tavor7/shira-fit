import { parseCustomSlotPriceDraft, resolveSessionBillingPriceLocal } from "./sessionSlotPrice";
import type { PricingRateTierRow } from "./pricingRates";

describe("parseCustomSlotPriceDraft", () => {
  it("treats an empty (or whitespace-only) draft as clearing the override", () => {
    expect(parseCustomSlotPriceDraft("")).toEqual({ ok: true, price: null });
    expect(parseCustomSlotPriceDraft("   ")).toEqual({ ok: true, price: null });
  });

  it("parses a plain number", () => {
    expect(parseCustomSlotPriceDraft("120")).toEqual({ ok: true, price: 120 });
  });

  it("accepts a comma as a decimal separator", () => {
    expect(parseCustomSlotPriceDraft("99,5")).toEqual({ ok: true, price: 99.5 });
  });

  it("accepts zero", () => {
    expect(parseCustomSlotPriceDraft("0")).toEqual({ ok: true, price: 0 });
  });

  it("rejects a negative price", () => {
    expect(parseCustomSlotPriceDraft("-5")).toEqual({ ok: false });
  });

  it("rejects non-numeric input", () => {
    expect(parseCustomSlotPriceDraft("abc")).toEqual({ ok: false });
  });
});

describe("resolveSessionBillingPriceLocal", () => {
  const globalTiers: PricingRateTierRow[] = [
    { max_participants: 4, price_ils: 100, effective_from: "2026-01-01", effective_to: null },
  ];
  const athleteTiers: PricingRateTierRow[] = [
    { max_participants: 4, price_ils: 80, effective_from: "2026-01-01", effective_to: null },
  ];
  const kickboxTiers: PricingRateTierRow[] = [
    { max_participants: 4, price_ils: 150, effective_from: "2026-01-01", effective_to: null },
  ];

  it("a session custom price wins over every other source", () => {
    const price = resolveSessionBillingPriceLocal({
      customSlotPriceIls: 999,
      maxParticipants: 4,
      sessionDate: "2026-07-13",
      globalTiers,
      athleteTiers,
    });
    expect(price).toBe(999);
  });

  it("returns null for a non-finite or sub-1 capacity", () => {
    expect(
      resolveSessionBillingPriceLocal({ customSlotPriceIls: null, maxParticipants: 0 })
    ).toBeNull();
    expect(
      resolveSessionBillingPriceLocal({ customSlotPriceIls: null, maxParticipants: NaN })
    ).toBeNull();
  });

  describe("with a session date (tier-row hierarchy)", () => {
    it("prefers the athlete override tier over the global tier", () => {
      const price = resolveSessionBillingPriceLocal({
        customSlotPriceIls: null,
        maxParticipants: 4,
        sessionDate: "2026-07-13",
        athleteTiers,
        globalTiers,
      });
      expect(price).toBe(80);
    });

    it("falls back to the global tier when there is no athlete override", () => {
      const price = resolveSessionBillingPriceLocal({
        customSlotPriceIls: null,
        maxParticipants: 4,
        sessionDate: "2026-07-13",
        globalTiers,
      });
      expect(price).toBe(100);
    });

    it("for kickbox sessions, prefers the kickbox tier over the regular global tier", () => {
      const price = resolveSessionBillingPriceLocal({
        customSlotPriceIls: null,
        maxParticipants: 4,
        isKickbox: true,
        sessionDate: "2026-07-13",
        globalKickboxTiers: kickboxTiers,
        globalTiers,
      });
      expect(price).toBe(150);
    });

    it("for kickbox sessions, falls back to the regular global tier when no kickbox tier matches", () => {
      const price = resolveSessionBillingPriceLocal({
        customSlotPriceIls: null,
        maxParticipants: 4,
        isKickbox: true,
        sessionDate: "2026-07-13",
        globalTiers,
      });
      expect(price).toBe(100);
    });

    it("returns null when no tier matches at all", () => {
      const price = resolveSessionBillingPriceLocal({
        customSlotPriceIls: null,
        maxParticipants: 9,
        sessionDate: "2026-07-13",
        globalTiers,
      });
      expect(price).toBeNull();
    });
  });

  describe("without a session date (flat price-by-capacity maps)", () => {
    it("prefers the athlete price map over the global price map", () => {
      const price = resolveSessionBillingPriceLocal({
        customSlotPriceIls: null,
        maxParticipants: 4,
        athletePriceByCap: { 4: 70 },
        globalPriceByCap: { 4: 100 },
      });
      expect(price).toBe(70);
    });

    it("falls back to the global price map when there is no athlete entry", () => {
      const price = resolveSessionBillingPriceLocal({
        customSlotPriceIls: null,
        maxParticipants: 4,
        globalPriceByCap: { 4: 100 },
      });
      expect(price).toBe(100);
    });

    it("for kickbox sessions, prefers the kickbox price map over the global one", () => {
      const price = resolveSessionBillingPriceLocal({
        customSlotPriceIls: null,
        maxParticipants: 4,
        isKickbox: true,
        globalKickboxPriceByCap: { 4: 150 },
        globalPriceByCap: { 4: 100 },
      });
      expect(price).toBe(150);
    });

    it("returns null when no map has an entry for the capacity", () => {
      const price = resolveSessionBillingPriceLocal({
        customSlotPriceIls: null,
        maxParticipants: 9,
        globalPriceByCap: { 4: 100 },
      });
      expect(price).toBeNull();
    });
  });
});
