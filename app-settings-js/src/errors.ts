import type { ErrorCode } from "./types.ts";

/**
 * Codes this SDK raises on top of the ones the server defines. They occupy the
 * same `code` field so a single `catch` can branch on one value.
 */
export type ClientErrorCode =
  /** The request never got a response: DNS, TLS, CORS, offline. */
  | "network_error"
  /** The request exceeded `timeoutMs`, or its signal was aborted. */
  | "timeout"
  /** The caller aborted the request through an `AbortSignal`. */
  | "aborted"
  /** A response arrived but was not the JSON this SDK expected. */
  | "invalid_response"
  /** A typed accessor was used on a setting of a different type. */
  | "type_mismatch"
  /** A value was rejected before it was ever sent. */
  | "invalid_value";

/** Every code an {@link AppSettingsError} can carry. */
export type AnyErrorCode = ErrorCode | ClientErrorCode;

/**
 * The single error type this SDK throws.
 *
 * Branch on {@link AppSettingsError.code}, which is stable, rather than on the
 * message, which is written for a human.
 */
export class AppSettingsError extends Error {
  override readonly name = "AppSettingsError";

  /** A stable identifier for the failure. */
  readonly code: AnyErrorCode;
  /** The HTTP status, when the failure came from a response. */
  readonly status?: number;
  /** The server's `X-Request-ID`, worth quoting in a bug report. */
  readonly requestId?: string;
  /** The request that failed, as `GET /api/v1/settings`. */
  readonly request?: string;
  /** The parsed response body, when there was one. */
  readonly body?: unknown;

  constructor(
    message: string,
    options: {
      code: AnyErrorCode;
      status?: number;
      requestId?: string;
      request?: string;
      body?: unknown;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.code = options.code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.request = options.request;
    this.body = options.body;
  }

  /** Whether the failure is worth trying again unchanged. */
  get retryable(): boolean {
    if (this.code === "network_error" || this.code === "timeout" || this.code === "unavailable") {
      return true;
    }
    return this.status === 429 || (this.status !== undefined && this.status >= 500);
  }

  /** Narrows an unknown caught value to this class. */
  static is(error: unknown): error is AppSettingsError {
    return error instanceof AppSettingsError;
  }
}

/** The requested thing does not exist, or this key may not see that it does. */
export const isNotFound = (error: unknown): boolean => codeIs(error, "not_found");

/** The API key was missing, malformed, expired or revoked. */
export const isUnauthorized = (error: unknown): boolean => codeIs(error, "unauthorized");

/** The key is real but is fenced out of what it asked for. */
export const isForbidden = (error: unknown): boolean => codeIs(error, "forbidden");

/** The request collided with existing state, such as a duplicate name. */
export const isConflict = (error: unknown): boolean => codeIs(error, "conflict");

/** The request was malformed or a value failed validation. */
export const isInvalidRequest = (error: unknown): boolean =>
  codeIs(error, "invalid_request") || codeIs(error, "invalid_value");

function codeIs(error: unknown, code: AnyErrorCode): boolean {
  return AppSettingsError.is(error) && error.code === code;
}
