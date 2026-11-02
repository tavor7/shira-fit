const mockExpoSync = jest.fn(async () => {});
const mockWebSync = jest.fn(async () => {});
jest.mock("./pushTokenSync", () => ({ syncExpoPushTokenIfNeeded: () => mockExpoSync() }));
jest.mock("./webPushSync", () => ({ syncWebPushSubscriptionIfNeeded: () => mockWebSync() }));

import { __resetPushSyncScheduleForTests, syncPushRegistrationIfStale, syncPushRegistrationNow } from "./pushSyncSchedule";

describe("pushSyncSchedule", () => {
  beforeEach(() => {
    __resetPushSyncScheduleForTests();
    mockExpoSync.mockClear();
    mockWebSync.mockClear();
  });

  it("login sync always runs, and the home focus right after it does not repeat it", () => {
    syncPushRegistrationNow();
    expect(syncPushRegistrationIfStale()).toBe(false);
    expect(mockWebSync).toHaveBeenCalledTimes(1);
    expect(mockExpoSync).toHaveBeenCalledTimes(1);
  });

  it("home focus re-syncs once the last sync is 10 minutes old", () => {
    const t0 = Date.now();
    syncPushRegistrationNow();
    expect(syncPushRegistrationIfStale(t0 + 9 * 60_000)).toBe(false);
    expect(syncPushRegistrationIfStale(t0 + 10 * 60_000 + 1)).toBe(true);
    expect(mockWebSync).toHaveBeenCalledTimes(2);
  });

  it("the first home focus syncs when nothing has synced yet", () => {
    expect(syncPushRegistrationIfStale()).toBe(true);
    expect(mockWebSync).toHaveBeenCalledTimes(1);
  });
});
