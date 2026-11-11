import { describe, expect, it } from "vite-plus/test";
import { navigatedDuringRead, poll } from "../src/poll.ts";

// the message WebKit gave on Linux CI when a form post redirected while an expect read the page
const NAVIGATED = new Error(
  "locator.allTextContents: Execution context was destroyed, most likely because of a navigation",
);

function reads<T>(...results: (T | Error)[]): () => Promise<T> {
  let index = 0;
  return async () => {
    const result = results[Math.min(index++, results.length - 1)];
    if (result instanceof Error) throw result;
    return result as T;
  };
}

describe("poll", () => {
  it("reads again after a navigation interrupted a read, and passes on the new page", async () => {
    const seen = await poll(
      reads<string>(NAVIGATED, NAVIGATED, "Receipt by GET"),
      (text) => text === "Receipt by GET",
      1_000,
      1,
    );

    expect(seen).toEqual({ value: "Receipt by GET", ok: true });
  });

  it("throws any other error at once", async () => {
    const broken = new Error(
      "locator.allTextContents: Target page, context or browser has been closed",
    );
    let calls = 0;
    const read = async (): Promise<string> => {
      calls += 1;
      throw broken;
    };

    await expect(poll(read, () => true, 1_000, 1)).rejects.toBe(broken);
    expect(calls).toBe(1);
  });

  it("returns the last value read when the time runs out on an interrupted read", async () => {
    const seen = await poll(
      reads<string>("Order form", NAVIGATED),
      (text) => text === "Receipt by GET",
      30,
      1,
    );

    expect(seen).toEqual({ value: "Order form", ok: false });
  });

  it("throws the navigation error when no read finished before the time ran out", async () => {
    await expect(poll(reads<string>(NAVIGATED), () => true, 30, 1)).rejects.toBe(NAVIGATED);
  });

  it("tells a navigation error from other errors", () => {
    expect(navigatedDuringRead(NAVIGATED)).toBe(true);
    expect(navigatedDuringRead(new Error("frame.evaluate: Frame was detached"))).toBe(true);
    expect(
      navigatedDuringRead(
        new Error("locator.isVisible: Target page, context or browser has been closed"),
      ),
    ).toBe(false);
    expect(navigatedDuringRead("Execution context was destroyed")).toBe(false);
  });
});
