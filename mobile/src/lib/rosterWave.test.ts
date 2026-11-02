const mockCalls: string[] = [];
jest.mock("./supabase", () => {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in"]) q[m] = () => q;
    q.single = () => Promise.resolve({ data: { table }, error: null });
    q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
    return q;
  };
  return {
    supabase: {
      from: (t: string) => {
        mockCalls.push(t);
        return chain(t);
      },
      rpc: (fn: string) => {
        mockCalls.push(fn);
        return Promise.resolve({ data: { ok: true }, error: null });
      },
    },
  };
});

import { prefetchRosterWave1, takeRosterWave1 } from "./rosterWave";

const waves = () => mockCalls.filter((c) => c === "session_payment_receipt_locks").length;

describe("rosterWave prefetch", () => {
  beforeEach(() => {
    mockCalls.length = 0;
  });

  it("the roster's first load uses the wave the screen started", async () => {
    prefetchRosterWave1("s1");
    await takeRosterWave1("s1");
    expect(waves()).toBe(1);
  });

  it("is single use: the next load fetches fresh", async () => {
    prefetchRosterWave1("s1");
    await takeRosterWave1("s1");
    await takeRosterWave1("s1");
    expect(waves()).toBe(2);
  });

  it("is ignored for another session", async () => {
    prefetchRosterWave1("s1");
    await takeRosterWave1("s2");
    expect(waves()).toBe(2);
  });

  it("is ignored when older than a few seconds", async () => {
    prefetchRosterWave1("s1");
    await takeRosterWave1("s1", Date.now() + 5_000);
    expect(waves()).toBe(2);
  });

  it("without a prefetch, loads normally", async () => {
    await takeRosterWave1("s3");
    expect(waves()).toBe(1);
  });
});
