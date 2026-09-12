import { describe, expect, test } from "bun:test";

import { isInstant, localToInstant, parseInstant, toDateTimeLocal, toInstant } from "../src/index.ts";

describe("toInstant", () => {
  test("accepts a Date and an epoch", () => {
    expect(toInstant(new Date("2026-01-02T20:04:05Z"))).toBe("2026-01-02T20:04:05.000Z");
    expect(toInstant(Date.UTC(2026, 0, 2, 20, 4, 5))).toBe("2026-01-02T20:04:05.000Z");
  });

  test("normalises an offset to UTC, as the server does", () => {
    expect(toInstant("2026-01-02T15:04:05-05:00")).toBe("2026-01-02T20:04:05.000Z");
    expect(toInstant("2026-01-03T05:04:05+09:00")).toBe("2026-01-02T20:04:05.000Z");
    expect(toInstant("2026-01-02T20:04:05Z")).toBe("2026-01-02T20:04:05.000Z");
  });

  test("accepts the lower-case t and z RFC 3339 permits", () => {
    expect(toInstant("2026-01-02t20:04:05z")).toBe("2026-01-02T20:04:05.000Z");
  });

  test("names datetime-local specifically, since that is the common mistake", () => {
    expect(() => toInstant("2026-01-02T15:04")).toThrow(/no UTC offset/);
    expect(() => toInstant("2026-01-02T15:04:05")).toThrow(/no UTC offset/);
  });

  test("rejects the shapes the server rejects", () => {
    expect(() => toInstant("2026-01-02")).toThrow(/not an RFC 3339 date-time/);
    expect(() => toInstant("2026-01-02T15:04:05-0500")).toThrow(/not an RFC 3339 date-time/);
    expect(() => toInstant("2026-01-02 15:04:05Z")).toThrow(/not an RFC 3339 date-time/);
    expect(() => toInstant(new Date("nonsense"))).toThrow(/Invalid Date/);
  });
});

describe("localToInstant", () => {
  test("reads a datetime-local input in a named zone", () => {
    expect(localToInstant("2026-01-02T15:04", "America/New_York")).toBe("2026-01-02T20:04:00.000Z");
    expect(localToInstant("2026-01-02T15:04", "UTC")).toBe("2026-01-02T15:04:00.000Z");
    expect(localToInstant("2026-01-03T05:04", "Asia/Tokyo")).toBe("2026-01-02T20:04:00.000Z");
  });

  test("handles a summer reading, where the same zone has a different offset", () => {
    expect(localToInstant("2026-07-02T15:04", "America/New_York")).toBe("2026-07-02T19:04:00.000Z");
  });

  test("accepts seconds, and passes an already-offset value straight through", () => {
    expect(localToInstant("2026-01-02T15:04:30", "UTC")).toBe("2026-01-02T15:04:30.000Z");
    expect(localToInstant("2026-01-02T15:04:05-05:00")).toBe("2026-01-02T20:04:05.000Z");
  });

  test("rejects something that is not a local reading at all", () => {
    expect(() => localToInstant("nonsense", "UTC")).toThrow(/datetime-local/);
  });
});

describe("reading back", () => {
  test("parses a value from the API", () => {
    expect(parseInstant("2026-01-02T20:04:05Z")?.getTime()).toBe(Date.parse("2026-01-02T20:04:05Z"));
  });

  test("treats an unset value as undefined rather than throwing", () => {
    expect(parseInstant(null)).toBeUndefined();
    expect(parseInstant(undefined)).toBeUndefined();
  });

  test("recognises what the server will accept", () => {
    expect(isInstant("2026-01-02T20:04:05Z")).toBe(true);
    expect(isInstant("2026-01-02T15:04")).toBe(false);
    expect(isInstant(42)).toBe(false);
  });

  test("renders back into a datetime-local input", () => {
    expect(toDateTimeLocal("2026-01-02T20:04:05Z", "America/New_York")).toBe("2026-01-02T15:04");
    expect(toDateTimeLocal(new Date("2026-01-02T20:04:05Z"), "UTC")).toBe("2026-01-02T20:04");
  });

  test("round-trips through a zone", () => {
    const local = toDateTimeLocal("2026-07-02T19:04:00Z", "America/New_York");
    expect(localToInstant(local, "America/New_York")).toBe("2026-07-02T19:04:00.000Z");
  });
});
