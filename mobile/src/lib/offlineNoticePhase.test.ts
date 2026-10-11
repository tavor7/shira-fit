import { nextOfflineNoticePhase } from "./offlineNoticePhase";

describe("nextOfflineNoticePhase", () => {
  it("shows offline at once, whatever was showing", () => {
    expect(nextOfflineNoticePhase(null, { offline: true, loading: false })).toBe("offline");
    expect(nextOfflineNoticePhase("backOnline", { offline: true, loading: true })).toBe("offline");
    expect(nextOfflineNoticePhase("reconnecting", { offline: true, loading: true })).toBe("offline");
  });

  it("reconnects through 'Reconnecting…' only while the page is still loading", () => {
    expect(nextOfflineNoticePhase("offline", { offline: false, loading: true })).toBe("reconnecting");
    expect(nextOfflineNoticePhase("reconnecting", { offline: false, loading: true })).toBe("reconnecting");
    expect(nextOfflineNoticePhase("reconnecting", { offline: false, loading: false })).toBe("backOnline");
    expect(nextOfflineNoticePhase("offline", { offline: false, loading: false })).toBe("backOnline");
  });

  it("stays hidden when online and never offline", () => {
    expect(nextOfflineNoticePhase(null, { offline: false, loading: true })).toBeNull();
    expect(nextOfflineNoticePhase(null, { offline: false, loading: false })).toBeNull();
  });
});
