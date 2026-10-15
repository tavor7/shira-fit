import * as fs from "fs";
import * as path from "path";
import { getCurrentUserId } from "./currentUser";

const mockGetSession = jest.fn();
const mockGetUser = jest.fn();
jest.mock("./supabase", () => ({
  supabase: { auth: { getSession: () => mockGetSession(), getUser: () => mockGetUser() } },
}));

beforeEach(() => {
  mockGetSession.mockReset();
  mockGetUser.mockReset();
});

describe("getCurrentUserId (Performance Phase 1 / step 1)", () => {
  it("returns the id of the locally stored session without asking the Auth server", async () => {
    mockGetSession.mockResolvedValue({ data: { session: { user: { id: "u-1" } } }, error: null });
    await expect(getCurrentUserId()).resolves.toBe("u-1");
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it("returns null when signed out", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(getCurrentUserId()).resolves.toBeNull();
  });

  it("returns null (never throws) when the session cannot be read", async () => {
    mockGetSession.mockRejectedValue(new Error("storage unavailable"));
    await expect(getCurrentUserId()).resolves.toBeNull();
  });
});

describe("no auth.getUser() round trips on screen/data paths", () => {
  const SRC = path.join(__dirname, "..");
  const APP = path.join(SRC, "..", "app");
  /** Once-per-login push subscription syncs keep the server-validated getUser() on purpose (see currentUser.ts). */
  const ALLOWED = new Set(["src/lib/pushTokenSync.ts", "src/lib/webPushSync.ts"]);
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
    }
    return out;
  };

  it("only the allow-listed push syncs call supabase.auth.getUser()", () => {
    const root = path.join(SRC, "..");
    const offenders = [...walk(SRC), ...walk(APP)]
      .filter((f) => /auth\.getUser\(/.test(fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")))
      .map((f) => path.relative(root, f))
      .filter((f) => !ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });
});
