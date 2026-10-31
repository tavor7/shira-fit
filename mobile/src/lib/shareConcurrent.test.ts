import { shareConcurrent } from "./shareConcurrent";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("shareConcurrent", () => {
  it("shares one request between callers in the same task", async () => {
    const d = deferred<number>();
    const fn = jest.fn(() => d.promise);
    const read = shareConcurrent(fn);
    const a = read();
    const b = read();
    expect(fn).toHaveBeenCalledTimes(1);
    d.resolve(7);
    await expect(a).resolves.toBe(7);
    await expect(b).resolves.toBe(7);
  });

  it("never hands a later caller a request that is still in flight", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const fn = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const read = shareConcurrent(fn);
    const a = read();
    // Next task, e.g. the reload right after the user accepted: the first request has not settled yet.
    await new Promise((r) => setTimeout(r, 0));
    const b = read();
    expect(fn).toHaveBeenCalledTimes(2);
    second.resolve("after-accept");
    first.resolve("before-accept");
    await expect(b).resolves.toBe("after-accept");
    await expect(a).resolves.toBe("before-accept");
  });

  it("does not cache results", async () => {
    const fn = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    const read = shareConcurrent(fn);
    await expect(read()).resolves.toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    await expect(read()).resolves.toBe(2);
  });

  it("propagates failures to every sharer and lets the next task retry", async () => {
    const fn = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce("ok");
    const read = shareConcurrent(fn);
    const a = read();
    const b = read();
    await expect(a).rejects.toThrow("offline");
    await expect(b).rejects.toThrow("offline");
    await new Promise((r) => setTimeout(r, 0));
    await expect(read()).resolves.toBe("ok");
  });
});
