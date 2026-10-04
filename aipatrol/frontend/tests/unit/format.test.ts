import { describe, expect, it } from "vitest";
import {
  basename,
  cost,
  duration,
  relativeTime,
  titleFrom,
} from "../../src/lib/format";

describe("relativeTime", () => {
  const now = 1_000_000_000_000;

  it("calls anything under 45s just now", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 44_000, now)).toBe("just now");
  });

  it("steps up through minutes, hours and days", () => {
    expect(relativeTime(now - 45_000, now)).toBe("1m ago");
    expect(relativeTime(now - 4 * 60_000, now)).toBe("4m ago");
    expect(relativeTime(now - 2 * 3_600_000, now)).toBe("2h ago");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3d ago");
  });

  // Clock skew between events and Date.now() must not read as the future.
  it("clamps a timestamp in the future", () => {
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});

describe("duration", () => {
  it("drops precision as the number grows", () => {
    expect(duration(0)).toBe("0ms");
    expect(duration(432)).toBe("432ms");
    expect(duration(2_800)).toBe("2.8s");
    expect(duration(5_500)).toBe("5.5s");
    expect(duration(42_000)).toBe("42s");
    expect(duration(95_000)).toBe("1m 35s");
    expect(duration(3_720_000)).toBe("1h 2m");
  });

  it("does not print a bare unit at a boundary", () => {
    expect(duration(1_000)).toBe("1.0s");
    expect(duration(60_000)).toBe("1m 0s");
  });

  it("shows an em dash for a missing or nonsense value", () => {
    expect(duration(Number.NaN)).toBe("—");
    expect(duration(-1)).toBe("—");
    expect(duration(Number.POSITIVE_INFINITY)).toBe("—");
  });
});

describe("cost", () => {
  // Free is not the same as "less than a cent" — the distinction is the point.
  it("keeps zero distinct from a fraction of a cent", () => {
    expect(cost(0)).toBe("$0.00");
    expect(cost(0.004)).toBe("<$0.01");
  });

  it("rounds to cents above a cent", () => {
    expect(cost(0.01)).toBe("$0.01");
    expect(cost(0.0649)).toBe("$0.06");
    expect(cost(12.5)).toBe("$12.50");
  });

  it("shows an em dash for a nonsense value", () => {
    expect(cost(Number.NaN)).toBe("—");
  });
});

describe("basename", () => {
  it("takes the trailing segment", () => {
    expect(basename("/home/you/scratch")).toBe("scratch");
    expect(basename("scratch")).toBe("scratch");
  });

  it("ignores trailing slashes", () => {
    expect(basename("/home/you/scratch/")).toBe("scratch");
    expect(basename("/home/you/scratch///")).toBe("scratch");
  });

  it("keeps the root as a name of its own", () => {
    expect(basename("/")).toBe("/");
  });
});

describe("titleFrom", () => {
  it("takes the first line", () => {
    expect(titleFrom("fix the parser\n\nand add tests")).toBe("fix the parser");
  });

  it("clips to the budget, ellipsis included", () => {
    const title = titleFrom("x".repeat(100));
    expect(title).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("leaves a line exactly at the budget alone", () => {
    expect(titleFrom("x".repeat(60))).toBe("x".repeat(60));
  });

  it("respects a custom budget", () => {
    expect(titleFrom("abcdefghij", 5)).toBe("abcd…");
  });
});
