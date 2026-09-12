import { AppSettingsError } from "./errors.ts";

/**
 * Helpers for the `DATETIME` type, which accepts only a strict RFC 3339
 * date-time with a mandatory offset. The offset is what makes a value an
 * instant rather than a wall-clock reading, so the server rejects anything
 * without one — including what `<input type="datetime-local">` produces.
 */

/** RFC 3339 §5.6 `date-time`, with the offset required. Lower-case t/z are legal. */
const RFC_3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/** What `<input type="datetime-local">` yields: no offset, often no seconds. */
const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/;

/**
 * Normalises a value to the canonical UTC instant the server stores.
 *
 * A `Date` or an epoch milliseconds number is unambiguous and converts freely.
 * A string must already carry an offset: a bare `2026-01-02T15:04` means a
 * different moment in every timezone, so guessing one would be a bug waiting
 * to happen. Use {@link localToInstant} to state that assumption explicitly.
 *
 * @example
 * toInstant(new Date())                        // "2026-01-02T20:04:05.250Z"
 * toInstant("2026-01-02T15:04:05-05:00")       // "2026-01-02T20:04:05.000Z"
 */
export function toInstant(value: Date | string | number): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw invalid("an Invalid Date cannot be converted to an instant");
    }
    return value.toISOString();
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw invalid(`${value} is not a valid epoch milliseconds value`);
    }
    return new Date(value).toISOString();
  }

  if (DATETIME_LOCAL.test(value)) {
    throw invalid(
      `"${value}" has no UTC offset, so it is a wall-clock reading rather than an instant. ` +
        "Pass it through localToInstant() to read it in a specific timezone, " +
        "or through toInstant(new Date(value)) to accept the runtime's own zone.",
    );
  }
  if (!RFC_3339.test(value)) {
    throw invalid(
      `"${value}" is not an RFC 3339 date-time. The expected shape is ` +
        "2026-01-02T15:04:05Z or 2026-01-02T15:04:05-05:00.",
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalid(`"${value}" is shaped like an RFC 3339 date-time but is not a real moment`);
  }
  return parsed.toISOString();
}

/**
 * Reads a `datetime-local` input in a named timezone and returns the instant.
 *
 * Passing the zone makes the assumption visible at the call site, which is the
 * whole point: the same reading is a different moment in each zone.
 *
 * @param local A `datetime-local` value such as `2026-01-02T15:04`.
 * @param timeZone An IANA zone. Defaults to the runtime's own.
 *
 * @example
 * localToInstant("2026-01-02T15:04", "America/New_York")  // "2026-01-02T20:04:00.000Z"
 */
export function localToInstant(local: string, timeZone?: string): string {
  if (!DATETIME_LOCAL.test(local) && !RFC_3339.test(local)) {
    throw invalid(`"${local}" is not a datetime-local value such as 2026-01-02T15:04`);
  }
  if (RFC_3339.test(local)) return toInstant(local);

  // Without a zone the runtime's own is the only sensible reading, and `Date`
  // already applies it.
  if (!timeZone) {
    const parsed = new Date(local);
    if (Number.isNaN(parsed.getTime())) throw invalid(`"${local}" is not a real moment`);
    return parsed.toISOString();
  }

  // Treat the reading as UTC, then measure how far that guess sits from the
  // target zone and correct by it. Two passes settle the case where the offset
  // itself changes across the correction, as it does at a DST boundary.
  const naive = Date.parse(`${withSeconds(local)}Z`);
  if (Number.isNaN(naive)) throw invalid(`"${local}" is not a real moment`);

  let instant = naive;
  for (let pass = 0; pass < 2; pass++) {
    instant = naive + zoneOffsetMs(instant, timeZone);
  }
  return new Date(instant).toISOString();
}

/**
 * Parses a value returned by the API into a `Date`.
 *
 * Returns `undefined` for null or undefined, so an unset `DATETIME` reads
 * naturally without a guard at every call site.
 */
export function parseInstant(value: unknown): Date | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value;

  if (typeof value !== "string") {
    throw invalid(`expected an RFC 3339 string, got ${typeof value}`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw invalid(`"${value}" is not a parseable date-time`);
  }
  return parsed;
}

/** Reports whether a string is something the server will accept as a DATETIME. */
export function isInstant(value: unknown): value is string {
  return typeof value === "string" && RFC_3339.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Renders an instant for a `<input type="datetime-local">`, which is the
 * inverse of {@link localToInstant} and equally zone-dependent.
 */
export function toDateTimeLocal(value: Date | string | number, timeZone?: string): string {
  const date = value instanceof Date ? value : new Date(typeof value === "string" ? value : Number(value));
  if (Number.isNaN(date.getTime())) throw invalid("cannot render an Invalid Date");

  const parts = zoneParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** How far `timeZone` sits from UTC at a given instant, in milliseconds. */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = zoneParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
    new Date(instant).getUTCMilliseconds(),
  );
  return instant - asUtc;
}

/** Splits an instant into calendar fields as they read in a timezone. */
function zoneParts(date: Date, timeZone: string | undefined) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return parts as Record<"year" | "month" | "day" | "hour" | "minute" | "second", string>;
}

/** `datetime-local` may omit seconds; `Date.parse` wants them. */
function withSeconds(local: string): string {
  return /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}$/.test(local) ? `${local}:00` : local;
}

function invalid(message: string): AppSettingsError {
  return new AppSettingsError(message, { code: "invalid_value" });
}
