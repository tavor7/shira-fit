import {
  DEFAULT_MANAGER_OPERATIONAL_NOTIFICATION_PREFS,
  parseManagerOperationalNotificationPrefs,
  rpcGetManagerOperationalNotificationPrefs,
  rpcSetManagerOperationalNotificationPrefs,
} from "./managerOperationalNotificationPrefs";

describe("DEFAULT_MANAGER_OPERATIONAL_NOTIFICATION_PREFS", () => {
  it("defaults both preferences to true, matching the backend column defaults", () => {
    expect(DEFAULT_MANAGER_OPERATIONAL_NOTIFICATION_PREFS).toEqual({
      notifyGroupSpotAvailable: true,
      notifyNongroupRemoval: true,
    });
  });
});

describe("parseManagerOperationalNotificationPrefs", () => {
  it("parses a well-formed ok response", () => {
    expect(
      parseManagerOperationalNotificationPrefs({ ok: true, notify_group_spot_available: true, notify_nongroup_removal: false })
    ).toEqual({ notifyGroupSpotAvailable: true, notifyNongroupRemoval: false });
  });

  it("parses both preferences independently in either direction", () => {
    expect(
      parseManagerOperationalNotificationPrefs({ ok: true, notify_group_spot_available: false, notify_nongroup_removal: true })
    ).toEqual({ notifyGroupSpotAvailable: false, notifyNongroupRemoval: true });
  });

  it("returns null when ok is false", () => {
    expect(parseManagerOperationalNotificationPrefs({ ok: false, error: "forbidden" })).toBeNull();
  });

  it("returns null for malformed/missing fields rather than coercing to a boolean", () => {
    expect(parseManagerOperationalNotificationPrefs({ ok: true })).toBeNull();
    expect(parseManagerOperationalNotificationPrefs({ ok: true, notify_group_spot_available: "true" })).toBeNull();
    expect(parseManagerOperationalNotificationPrefs(null)).toBeNull();
    expect(parseManagerOperationalNotificationPrefs(undefined)).toBeNull();
    expect(parseManagerOperationalNotificationPrefs("nonsense")).toBeNull();
  });
});

function mockSupabase(rpcResult: { data?: unknown; error?: { message: string } | null }) {
  return { rpc: jest.fn().mockResolvedValue(rpcResult) } as unknown as import("@supabase/supabase-js").SupabaseClient;
}

describe("rpcGetManagerOperationalNotificationPrefs", () => {
  it("returns the parsed prefs on success", async () => {
    const supabase = mockSupabase({ data: { ok: true, notify_group_spot_available: true, notify_nongroup_removal: true } });
    const result = await rpcGetManagerOperationalNotificationPrefs(supabase);
    expect(result).toEqual({ notifyGroupSpotAvailable: true, notifyNongroupRemoval: true });
  });

  it("returns a structured error when the backend rejects (e.g. forbidden for a non-manager)", async () => {
    const supabase = mockSupabase({ data: { ok: false, error: "forbidden" } });
    const result = await rpcGetManagerOperationalNotificationPrefs(supabase);
    expect(result).toEqual({ ok: false, error: "forbidden" });
  });

  it("throws on a transport-level error", async () => {
    const supabase = mockSupabase({ data: null, error: { message: "network down" } });
    await expect(rpcGetManagerOperationalNotificationPrefs(supabase)).rejects.toEqual({ message: "network down" });
  });
});

describe("rpcSetManagerOperationalNotificationPrefs", () => {
  it("passes both flags through as p_notify_group_spot_available/p_notify_nongroup_removal", async () => {
    const rpc = jest.fn().mockResolvedValue({ data: { ok: true, notify_group_spot_available: false, notify_nongroup_removal: true } });
    const supabase = { rpc } as unknown as import("@supabase/supabase-js").SupabaseClient;
    const result = await rpcSetManagerOperationalNotificationPrefs(supabase, {
      notifyGroupSpotAvailable: false,
      notifyNongroupRemoval: true,
    });
    expect(rpc).toHaveBeenCalledWith("set_manager_notification_prefs", {
      p_notify_group_spot_available: false,
      p_notify_nongroup_removal: true,
    });
    expect(result).toEqual({ notifyGroupSpotAvailable: false, notifyNongroupRemoval: true });
  });
});
