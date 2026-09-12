import type { AppSettingsClient, ResolveUserOptions } from "./client.ts";
import { toInstant } from "./datetime.ts";
import { AppSettingsError } from "./errors.ts";
import { SettingsSnapshot } from "./snapshot.ts";
import type { ResolveResponse, SettingValue } from "./types.ts";

/**
 * A reactive store over one resolution.
 *
 * It deliberately knows nothing about any UI framework. What it exposes is the
 * `subscribe` / `getSnapshot` pair that React's `useSyncExternalStore` wants,
 * which is also the shape Vue, Svelte and Solid adapt to in a line or two.
 *
 * @example React, with no React-specific code in this package:
 * const store = createSettingsStore(client, { userId: "alice" });
 *
 * function useSettings() {
 *   return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
 * }
 */

/** What a subscriber reads. This object's identity changes only when something did. */
export interface SettingsState {
  /**
   * `idle` before the first load, `loading` during it, then `ready` or `error`.
   * A background refresh leaves the status alone and raises `isValidating`.
   */
  status: "idle" | "loading" | "ready" | "error";
  /** The current resolution, or null before the first one arrives. */
  snapshot: SettingsSnapshot | null;
  /** Why the last load failed. Cleared by a successful one. */
  error: AppSettingsError | null;
  /** Whether a request is in flight, including a background refresh. */
  isValidating: boolean;
  /** When the current snapshot arrived, as epoch milliseconds. */
  updatedAt: number | null;
}

/** How the store should resolve, and when it should do so again. */
export interface SettingsStoreOptions {
  /** The user to resolve for. Omit for a server resolution. */
  userId?: string;
  /** Overrides the client's environment. */
  environment?: string;
  /** Restricts the resolution to these platforms. */
  platform?: string | string[];
  /** Resolves as this role instead of the key's own. */
  role?: string;
  /** Groups applied without stored membership. */
  groupId?: string | string[];
  /** Re-resolves on this interval. 0, the default, disables it. */
  refreshIntervalMs?: number;
  /** Re-resolves when the tab is focused again. Browsers only. */
  revalidateOnFocus?: boolean;
  /** Re-resolves when the network comes back. Browsers only. */
  revalidateOnReconnect?: boolean;
  /**
   * A resolution already in hand, so the first render has data.
   *
   * This is the server-rendering path: resolve on the server, serialise the
   * response into the page, and pass it here.
   */
  initialData?: ResolveResponse | SettingsSnapshot;
  /** Called on every failed load, for logging. Failures also land in the state. */
  onError?: (error: AppSettingsError) => void;
}

/** The store returned by {@link createSettingsStore}. */
export interface SettingsStore {
  /** Registers a listener and returns its unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** The current state. Stable between changes, as `useSyncExternalStore` requires. */
  getSnapshot: () => SettingsState;
  /** The state to render on a server, where nothing is ever fetched. */
  getServerSnapshot: () => SettingsState;
  /** Re-resolves now. Never rejects; the failure lands in the state. */
  refresh: () => Promise<SettingsState>;
  /**
   * Writes a personal value and shows it immediately.
   *
   * The change is applied to the local snapshot before the request goes out and
   * rolled back if it fails, so a control feels instant but never lies.
   *
   * @throws {AppSettingsError} if the write is rejected.
   */
  set: (name: string, value: SettingValue) => Promise<void>;
  /** Clears the user's own value, falling back to whatever lies beneath it. */
  clear: (name: string) => Promise<void>;
  /** Points the store at a different user, discarding the current snapshot. */
  setUser: (userId: string | undefined) => void;
  /** Stops timers and listeners. Safe to call more than once. */
  dispose: () => void;
}

/** Builds a store. Nothing is fetched until something subscribes or refreshes. */
export function createSettingsStore(
  client: AppSettingsClient,
  options: SettingsStoreOptions = {},
): SettingsStore {
  const listeners = new Set<() => void>();
  const initial = initialSnapshot(options.initialData);

  let userId = options.userId;
  let state: SettingsState = {
    status: initial ? "ready" : "idle",
    snapshot: initial,
    error: null,
    isValidating: false,
    updatedAt: initial ? Date.now() : null,
  };
  // A server render must be deterministic, so it always sees the initial state.
  const serverState: SettingsState = state;

  let generation = 0;
  let inFlight: Promise<SettingsState> | null = null;
  let interval: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  function emit(next: Partial<SettingsState>): void {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  async function load(): Promise<SettingsState> {
    if (disposed) return state;
    // One request at a time: a second caller joins the first rather than
    // racing it, which is what makes focus and interval refreshes cheap.
    if (inFlight) return inFlight;

    const ticket = ++generation;
    emit({ isValidating: true, status: state.snapshot ? state.status : "loading" });

    inFlight = (async () => {
      try {
        const resolveOptions: ResolveUserOptions = {
          environment: options.environment,
          platform: options.platform,
          role: options.role,
          groupId: options.groupId,
        };
        const snapshot = userId
          ? await client.resolveUser(userId, resolveOptions)
          : await client.resolveServer(resolveOptions);

        // A newer load, or a setUser, has superseded this one.
        if (ticket !== generation || disposed) return state;
        emit({ status: "ready", snapshot, error: null, isValidating: false, updatedAt: Date.now() });
      } catch (caught) {
        if (ticket !== generation || disposed) return state;
        const error = asError(caught);
        options.onError?.(error);
        // Keep the last good snapshot: stale settings beat none at all.
        emit({ status: state.snapshot ? "ready" : "error", error, isValidating: false });
      } finally {
        if (ticket === generation) inFlight = null;
      }
      return state;
    })();

    return inFlight;
  }

  /** Everything a write needs, with the reasons it cannot proceed spelled out. */
  function writeTarget(name: string) {
    const snapshot = state.snapshot;
    if (!snapshot) {
      throw new AppSettingsError(`cannot write "${name}" before the first resolution has loaded`, {
        code: "invalid_request",
      });
    }
    if (!userId) {
      throw new AppSettingsError(
        `cannot write "${name}": this store resolves the server layer, which has no personal value. ` +
          "Give the store a `userId`, or use client.values.server.set().",
        { code: "invalid_request" },
      );
    }
    const setting = snapshot.get(name);
    if (!setting) {
      throw new AppSettingsError(`no setting named "${name}" is visible to this key and role`, {
        code: "not_found",
      });
    }
    return { snapshot, setting, userId };
  }

  async function writePersonal(name: string, value: SettingValue | undefined): Promise<void> {
    const target = writeTarget(name);
    const previous = state.snapshot;

    // An enforced override beats whatever is stored underneath it, so the
    // effective value will not move. Store the write, but do not pretend.
    const optimistic =
      value !== undefined && !target.snapshot.isEnforced(name)
        ? target.snapshot.with(name, value)
        : target.snapshot;

    if (optimistic !== previous) emit({ snapshot: optimistic });

    try {
      if (value === undefined) {
        await client.values.personal.clear(target.setting.id, target.userId);
      } else {
        await client.values.personal.set(target.setting.id, target.userId, value);
      }
    } catch (caught) {
      if (state.snapshot === optimistic) emit({ snapshot: previous });
      throw asError(caught);
    }

    // The server canonicalises values — a DATETIME comes back in UTC — and a
    // clear falls through to a layer only it knows about, so re-resolve.
    await load();
  }

  function startTimers(): void {
    const target = eventTarget();
    if (!target) return;

    if (options.revalidateOnFocus) target.addEventListener("focus", onWake);
    if (options.revalidateOnReconnect) target.addEventListener("online", onWake);
  }

  function stopTimers(): void {
    if (interval !== undefined) {
      clearInterval(interval);
      interval = undefined;
    }
    const target = eventTarget();
    target?.removeEventListener("focus", onWake);
    target?.removeEventListener("online", onWake);
  }

  function onWake(): void {
    void load();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);

      // The first subscriber starts the store; nothing polls an empty room.
      if (listeners.size === 1 && !disposed) {
        if (!state.snapshot) void load();
        if (options.refreshIntervalMs && options.refreshIntervalMs > 0) {
          interval = setInterval(onWake, options.refreshIntervalMs);
        }
        startTimers();
      }

      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) stopTimers();
      };
    },

    getSnapshot: () => state,
    getServerSnapshot: () => serverState,
    refresh: load,

    set: (name, value) => writePersonal(name, normalise(value)),
    clear: (name) => writePersonal(name, undefined),

    setUser(next) {
      if (next === userId) return;
      userId = next;
      // Invalidate anything in flight: it is about the previous user.
      generation++;
      inFlight = null;
      emit({ status: "loading", snapshot: null, error: null, updatedAt: null });
      void load();
    },

    dispose() {
      disposed = true;
      generation++;
      stopTimers();
      listeners.clear();
    },
  };
}

/**
 * The `window` object, when there is one.
 *
 * Typed structurally rather than through the DOM lib, so this package compiles
 * in a project that does not include DOM types and still works in a browser.
 */
interface WakeTarget {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

function eventTarget(): WakeTarget | undefined {
  const candidate = (globalThis as { window?: WakeTarget }).window;
  return typeof candidate?.addEventListener === "function" ? candidate : undefined;
}

/** Accepts either form of seed data, so an SSR payload needs no unwrapping. */
function initialSnapshot(data: SettingsStoreOptions["initialData"]): SettingsSnapshot | null {
  if (!data) return null;
  return data instanceof SettingsSnapshot ? data : new SettingsSnapshot(data);
}

/** A `Date` is the natural thing to hand a DATETIME setting, so accept one. */
function normalise(value: SettingValue): SettingValue {
  return value instanceof Date ? toInstant(value) : value;
}

function asError(caught: unknown): AppSettingsError {
  if (AppSettingsError.is(caught)) return caught;
  return new AppSettingsError(caught instanceof Error ? caught.message : String(caught), {
    code: "internal_error",
    cause: caught,
  });
}
