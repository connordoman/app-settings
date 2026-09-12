import { AppSettingsError } from "./errors.ts";
import { createTransport, request, type FetchLike, type RequestOptions, type TransportConfig, type TransportOptions } from "./http.ts";
import { SettingsSnapshot } from "./snapshot.ts";
import type {
  ApiKey,
  CreatedApiKey,
  Environment,
  Group,
  GroupMember,
  Health,
  IntermediateValue,
  PersonalValue,
  Platform,
  ResolveResponse,
  Role,
  Scope,
  ServerValue,
  Setting,
  SettingScope,
  SettingType,
  SettingValue,
  TypeConfig,
  WhoAmI,
} from "./types.ts";

/** How to reach the server, and what to assume when a call does not say. */
export interface ClientOptions extends TransportOptions {
  /**
   * The environment used by calls that require one. Resolution always needs an
   * environment, so setting it here means most calls take no options at all.
   */
  environment?: string;
  /** The platform filter applied to resolution and to setting lookups. */
  platform?: string | string[];
}

/** Options shared by both resolution calls. */
export interface ResolveOptions extends RequestOptions {
  /** Overrides the client's environment. Required if the client has none. */
  environment?: string;
  /** Restricts the resolution to these platforms. Capped by the key's own fence. */
  platform?: string | string[];
  /** Resolves as this role instead of the key's. It may not outrank the key. */
  role?: string;
}

/** Resolution for one user. */
export interface ResolveUserOptions extends ResolveOptions {
  /**
   * Groups to apply without storing membership, which is how an ad-hoc group
   * is used. Saved memberships apply regardless.
   */
  groupId?: string | string[];
}

/** Filters for listing setting definitions. */
export interface ListSettingsOptions extends RequestOptions {
  environment?: string;
  platform?: string;
  scope?: SettingScope;
}

/** A new setting definition. Type, scope, platform and environment are fixed at creation. */
export interface CreateSettingInput {
  name: string;
  type: SettingType;
  scope: SettingScope;
  platform: string;
  /** Defaults to the client's environment. */
  environment?: string;
  description?: string;
  /** The rules for this type. See {@link TypeConfig}. */
  typeConfig?: TypeConfig;
  /** Defaults to the calling key's own role. */
  role?: string;
  /** Used when no layer supplies a value. */
  defaultValue?: SettingValue;
}

/** The parts of a definition that are safe to change after creation. */
export interface UpdateSettingInput {
  description?: string;
  typeConfig?: TypeConfig;
  role?: string;
  defaultValue?: SettingValue;
}

/** Options for writing a group override. */
export interface GroupValueOptions extends RequestOptions {
  /** Whether the user is meant to observe the override. Defaults to true. */
  visible?: boolean;
  /** Whether the override beats the user's own value. Defaults to false. */
  enforced?: boolean;
}

/** A new group. */
export interface CreateGroupInput {
  name: string;
  description?: string;
  /** Omit to span every environment, which a fenced key may not do. */
  environment?: string | null;
  /** Higher priority wins when two groups override the same setting. */
  priority?: number;
  /** Marks an ad-hoc group so operators can prune it later. */
  ephemeral?: boolean;
  /** Seeds membership in the same request. */
  members?: string[];
}

/** A new API key. It can never reach further than the key that mints it. */
export interface CreateKeyInput {
  name: string;
  scopes: Scope[];
  /** Empty inherits the creating key's fence rather than granting everything. */
  environments?: string[];
  platforms?: string[];
  /** Defaults to the lowest-ranked role. May not outrank the creating key. */
  role?: string;
  /** Supply at most one of these. */
  expiresAt?: Date | string;
  /** A Go duration such as `"720h"`. */
  expiresIn?: string;
}

/**
 * A client for the App Settings API.
 *
 * One instance is cheap and holds no connection state, so it is safe to build
 * once at module scope and share it.
 *
 * @example
 * const client = new AppSettingsClient({
 *   baseUrl: "https://settings.example.com",
 *   apiKey: process.env.SETTINGS_API_KEY!,
 *   environment: "production",
 * });
 *
 * const settings = await client.resolveUser("alice");
 * if (settings.boolean("dark_mode")) { ... }
 */
export class AppSettingsClient {
  readonly #transport: TransportConfig;
  readonly #environment?: string;
  readonly #platform?: string[];

  constructor(options: ClientOptions) {
    this.#transport = createTransport(options);
    this.#environment = options.environment;
    this.#platform = options.platform === undefined ? undefined : toArray(options.platform);
  }

  /** The environment this client defaults to, if it has one. */
  get environment(): string | undefined {
    return this.#environment;
  }

  /** A copy of this client bound to a different environment. */
  withEnvironment(environment: string): AppSettingsClient {
    return new AppSettingsClient({
      ...this.#transport,
      environment,
      platform: this.#platform,
    });
  }

  // --- Effective settings -------------------------------------------------

  /**
   * Every setting a user can see, collapsed to one effective value each.
   *
   * This is the call a product backend makes. Precedence, lowest to highest, is
   * `default < server < advisory group < personal < enforced group`.
   */
  async resolveUser(userId: string, options: ResolveUserOptions = {}): Promise<SettingsSnapshot> {
    const response = await this.#request<ResolveResponse>({
      method: "GET",
      path: `/api/v1/resolve/user/${encode(userId)}`,
      query: {
        ...this.#resolveQuery(options),
        group_id: options.groupId === undefined ? undefined : toArray(options.groupId),
      },
      options,
    });
    return new SettingsSnapshot(response);
  }

  /** The server's own settings, with no user layer applied. */
  async resolveServer(options: ResolveOptions = {}): Promise<SettingsSnapshot> {
    const response = await this.#request<ResolveResponse>({
      method: "GET",
      path: "/api/v1/resolve/server",
      query: this.#resolveQuery(options),
      options,
    });
    return new SettingsSnapshot(response);
  }

  // --- Identity and health ------------------------------------------------

  /** Describes the calling key, so a deployment can confirm what it can do. */
  whoami(options?: RequestOptions): Promise<WhoAmI> {
    return this.#request({ method: "GET", path: "/api/v1/whoami", options });
  }

  /** Whether the process is up. Needs no API key on the server, but sends one. */
  health(options?: RequestOptions): Promise<Health> {
    return this.#request({ method: "GET", path: "/healthz", options });
  }

  /** Whether the server's dependencies are reachable. */
  ready(options?: RequestOptions): Promise<Health> {
    return this.#request({ method: "GET", path: "/readyz", options });
  }

  // --- Setting definitions ------------------------------------------------

  readonly settings = {
    /** Every definition this key may see, narrowed by the given filters. */
    list: async (options: ListSettingsOptions = {}): Promise<Setting[]> => {
      const body = await this.#request<{ settings: Setting[] }>({
        method: "GET",
        path: "/api/v1/settings",
        query: {
          environment: options.environment ?? this.#environment,
          platform: options.platform ?? this.#platform?.[0],
          scope: options.scope,
        },
        options,
      });
      return body.settings ?? [];
    },

    /** One definition by id. */
    get: (id: string, options?: RequestOptions): Promise<Setting> =>
      this.#request({ method: "GET", path: `/api/v1/settings/${encode(id)}`, options }),

    /** Defines a new setting. */
    create: async (input: CreateSettingInput, options?: RequestOptions): Promise<Setting> => {
      const environment = input.environment ?? this.#environment;
      if (!environment) throw missingEnvironment("settings.create");

      return this.#request({
        method: "POST",
        path: "/api/v1/settings",
        body: {
          name: input.name,
          description: input.description ?? "",
          type: input.type,
          type_config: input.typeConfig ?? {},
          role: input.role,
          scope: input.scope,
          platform: input.platform,
          environment,
          default_value: input.defaultValue ?? null,
        },
        options,
      });
    },

    /** Changes a definition. Omitted fields are left as they are. */
    update: (id: string, input: UpdateSettingInput, options?: RequestOptions): Promise<Setting> =>
      this.#request({
        method: "PATCH",
        path: `/api/v1/settings/${encode(id)}`,
        body: {
          description: input.description,
          type_config: input.typeConfig,
          role: input.role,
          default_value: input.defaultValue,
        },
        options,
      }),

    /**
     * Removes a definition.
     *
     * A delete that would destroy stored values is refused with a `conflict`
     * naming how many, unless `cascade` says to go ahead.
     */
    delete: (id: string, options: RequestOptions & { cascade?: boolean } = {}): Promise<void> =>
      this.#request({
        method: "DELETE",
        path: `/api/v1/settings/${encode(id)}`,
        query: { cascade: options.cascade ? "true" : undefined },
        options,
      }),
  };

  // --- Stored values, one namespace per layer -----------------------------

  readonly values = {
    /** The server-wide layer, beneath every group and user value. */
    server: {
      get: (settingId: string, options?: RequestOptions): Promise<ServerValue> =>
        this.#request({ method: "GET", path: `/api/v1/settings/${encode(settingId)}/server`, options }),

      set: async (settingId: string, value: SettingValue, options?: RequestOptions): Promise<ServerValue> =>
        this.#request({
          method: "PUT",
          path: `/api/v1/settings/${encode(settingId)}/server`,
          body: { value: requireValue(value) },
          options,
        }),

      /** Removes the value, falling back to the definition's default. */
      clear: (settingId: string, options?: RequestOptions): Promise<void> =>
        this.#request({ method: "DELETE", path: `/api/v1/settings/${encode(settingId)}/server`, options }),
    },

    /** One user's own choice. */
    personal: {
      get: (settingId: string, userId: string, options?: RequestOptions): Promise<PersonalValue> =>
        this.#request({
          method: "GET",
          path: `/api/v1/settings/${encode(settingId)}/personal/${encode(userId)}`,
          options,
        }),

      set: async (settingId: string, userId: string, value: SettingValue, options?: RequestOptions): Promise<PersonalValue> =>
        this.#request({
          method: "PUT",
          path: `/api/v1/settings/${encode(settingId)}/personal/${encode(userId)}`,
          body: { value: requireValue(value) },
          options,
        }),

      clear: (settingId: string, userId: string, options?: RequestOptions): Promise<void> =>
        this.#request({
          method: "DELETE",
          path: `/api/v1/settings/${encode(settingId)}/personal/${encode(userId)}`,
          options,
        }),
    },

    /** A group override, in either direction. */
    group: {
      get: (settingId: string, groupId: string, options?: RequestOptions): Promise<IntermediateValue> =>
        this.#request({
          method: "GET",
          path: `/api/v1/settings/${encode(settingId)}/intermediate/${encode(groupId)}`,
          options,
        }),

      /**
       * Writes an override. `enforced` decides its direction: an enforced
       * override beats the user's own value, an advisory one yields to it.
       */
      set: async (
        settingId: string,
        groupId: string,
        value: SettingValue,
        options: GroupValueOptions = {},
      ): Promise<IntermediateValue> =>
        this.#request({
          method: "PUT",
          path: `/api/v1/settings/${encode(settingId)}/intermediate/${encode(groupId)}`,
          body: { value: requireValue(value), visible: options.visible, enforced: options.enforced },
          options,
        }),

      clear: (settingId: string, groupId: string, options?: RequestOptions): Promise<void> =>
        this.#request({
          method: "DELETE",
          path: `/api/v1/settings/${encode(settingId)}/intermediate/${encode(groupId)}`,
          options,
        }),
    },
  };

  // --- Groups -------------------------------------------------------------

  readonly groups = {
    list: async (
      options: RequestOptions & { environment?: string; includeEphemeral?: boolean } = {},
    ): Promise<Group[]> => {
      const body = await this.#request<{ groups: Group[] }>({
        method: "GET",
        path: "/api/v1/groups",
        query: {
          environment: options.environment ?? this.#environment,
          include_ephemeral: options.includeEphemeral === false ? "false" : undefined,
        },
        options,
      });
      return body.groups ?? [];
    },

    get: (id: string, options?: RequestOptions): Promise<Group> =>
      this.#request({ method: "GET", path: `/api/v1/groups/${encode(id)}`, options }),

    create: (input: CreateGroupInput, options?: RequestOptions): Promise<Group> =>
      this.#request({
        method: "POST",
        path: "/api/v1/groups",
        body: {
          name: input.name,
          description: input.description ?? "",
          // null is meaningful here — it spans every environment — so only an
          // omitted field falls back to the client's own.
          environment: input.environment === undefined ? (this.#environment ?? null) : input.environment,
          priority: input.priority ?? 0,
          ephemeral: input.ephemeral ?? false,
          members: input.members,
        },
        options,
      }),

    update: (
      id: string,
      input: { description?: string; priority?: number },
      options?: RequestOptions,
    ): Promise<Group> =>
      this.#request({ method: "PATCH", path: `/api/v1/groups/${encode(id)}`, body: input, options }),

    delete: (id: string, options?: RequestOptions): Promise<void> =>
      this.#request({ method: "DELETE", path: `/api/v1/groups/${encode(id)}`, options }),

    /** Everyone whose membership is saved. Ad-hoc application does not appear here. */
    members: async (id: string, options?: RequestOptions): Promise<GroupMember[]> => {
      const body = await this.#request<{ members: GroupMember[] }>({
        method: "GET",
        path: `/api/v1/groups/${encode(id)}/members`,
        options,
      });
      return body.members ?? [];
    },

    addMembers: async (id: string, userIds: string[], options?: RequestOptions): Promise<number> => {
      const body = await this.#request<{ added: number }>({
        method: "POST",
        path: `/api/v1/groups/${encode(id)}/members`,
        body: { members: userIds },
        options,
      });
      return body.added ?? 0;
    },

    removeMembers: async (id: string, userIds: string[], options?: RequestOptions): Promise<number> => {
      const body = await this.#request<{ removed: number }>({
        method: "DELETE",
        path: `/api/v1/groups/${encode(id)}/members`,
        body: { members: userIds },
        options,
      });
      return body.removed ?? 0;
    },
  };

  // --- Roles, platforms and environments ----------------------------------

  readonly taxonomy = {
    roles: async (options?: RequestOptions): Promise<Role[]> =>
      (await this.#request<{ roles: Role[] }>({ method: "GET", path: "/api/v1/roles", options })).roles ?? [],

    /** Creates or updates a role. Rank orders roles and may not exceed the key's. */
    upsertRole: (name: string, input: { rank: number; description?: string }, options?: RequestOptions): Promise<Role> =>
      this.#request({
        method: "PUT",
        path: `/api/v1/roles/${encode(name)}`,
        body: { rank: input.rank, description: input.description ?? "" },
        options,
      }),

    deleteRole: (name: string, options?: RequestOptions): Promise<void> =>
      this.#request({ method: "DELETE", path: `/api/v1/roles/${encode(name)}`, options }),

    platforms: async (options?: RequestOptions): Promise<Platform[]> =>
      (await this.#request<{ platforms: Platform[] }>({ method: "GET", path: "/api/v1/platforms", options }))
        .platforms ?? [],

    upsertPlatform: (name: string, description = "", options?: RequestOptions): Promise<Platform> =>
      this.#request({ method: "PUT", path: `/api/v1/platforms/${encode(name)}`, body: { description }, options }),

    deletePlatform: (name: string, options?: RequestOptions): Promise<void> =>
      this.#request({ method: "DELETE", path: `/api/v1/platforms/${encode(name)}`, options }),

    environments: async (options?: RequestOptions): Promise<Environment[]> =>
      (await this.#request<{ environments: Environment[] }>({
        method: "GET",
        path: "/api/v1/environments",
        options,
      })).environments ?? [],

    upsertEnvironment: (name: string, description = "", options?: RequestOptions): Promise<Environment> =>
      this.#request({ method: "PUT", path: `/api/v1/environments/${encode(name)}`, body: { description }, options }),

    deleteEnvironment: (name: string, options?: RequestOptions): Promise<void> =>
      this.#request({ method: "DELETE", path: `/api/v1/environments/${encode(name)}`, options }),
  };

  // --- API keys -----------------------------------------------------------

  readonly keys = {
    list: async (options: RequestOptions & { includeRevoked?: boolean } = {}): Promise<ApiKey[]> => {
      const body = await this.#request<{ keys: ApiKey[] }>({
        method: "GET",
        path: "/api/v1/keys",
        query: { include_revoked: options.includeRevoked ? "true" : undefined },
        options,
      });
      return body.keys ?? [];
    },

    /**
     * Mints a key. The returned `token` is the only time it is ever available:
     * only its hash is stored.
     */
    create: (input: CreateKeyInput, options?: RequestOptions): Promise<CreatedApiKey> =>
      this.#request({
        method: "POST",
        path: "/api/v1/keys",
        body: {
          name: input.name,
          scopes: input.scopes,
          environments: input.environments,
          platforms: input.platforms,
          role: input.role,
          expires_at: input.expiresAt instanceof Date ? input.expiresAt.toISOString() : input.expiresAt,
          expires_in: input.expiresIn,
        },
        options,
      }),

    /** Revokes a key. This is permanent and takes effect immediately. */
    revoke: (id: string, options?: RequestOptions): Promise<void> =>
      this.#request({ method: "DELETE", path: `/api/v1/keys/${encode(id)}`, options }),
  };

  // --- Internals ----------------------------------------------------------

  #request<T>(spec: Parameters<typeof request>[1]): Promise<T> {
    return request<T>(this.#transport, spec);
  }

  /** The query shared by both resolution endpoints. */
  #resolveQuery(options: ResolveOptions): Record<string, string | string[] | undefined> {
    const environment = options.environment ?? this.#environment;
    if (!environment) throw missingEnvironment("resolve");

    const platform = options.platform === undefined ? this.#platform : toArray(options.platform);
    return { environment, platform, role: options.role };
  }
}

function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/** Path segments are user data — a user id or a role name — so escape them. */
function encode(segment: string): string {
  return encodeURIComponent(segment);
}

/** The server treats an absent value as an error, and DELETE as the way to clear. */
function requireValue(value: SettingValue): SettingValue {
  if (value === undefined) {
    throw new AppSettingsError("`value` is required; use clear() to remove a value", {
      code: "invalid_value",
    });
  }
  return value;
}

function missingEnvironment(operation: string): AppSettingsError {
  return new AppSettingsError(
    `${operation} needs an environment. Pass one as \`environment\` in the call, ` +
      "or set it once on the client.",
    { code: "invalid_request" },
  );
}

export type { FetchLike, RequestOptions };
