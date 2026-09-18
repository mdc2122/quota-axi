import { deleteCachedProvider, readCachedProvider } from "../cache.js";
import { providerFetch } from "../lib/http.js";
import { usableLiteralSecret, redactSecret } from "../lib/secret.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  staleFromCache,
  successProvider,
  withRemaining,
} from "./common.js";

/**
 * OmniRoute (diegosouzapw/OmniRoute) is a self-hosted AI gateway that holds
 * provider connections - including Cursor seats - in its own store on the
 * gateway host. Those seats' credentials never exist on this machine, so the
 * only truthful reading is the gateway's own per-connection usage API:
 *   GET {base}/api/providers            -> connection inventory (metadata only)
 *   GET {base}/api/usage/{connectionId} -> live quota fetch, the same call the
 *     dashboard's quota page makes (fetchAndPersistProviderLimits)
 * Both are management routes: the API key needs the `manage` scope. quota-axi
 * never writes to the gateway, never reads seat credential material, and never
 * asks the gateway to mint or rotate anything - the usage route's own refresh
 * behavior is OmniRoute's, identical to what its dashboard triggers.
 *
 * Configuration is environment-only:
 *   OMNIROUTE_BASE_URL  gateway origin (default http://127.0.0.1:20128)
 *   OMNIROUTE_API_KEY   manage-scope API key; absent -> auth_required
 */
const OMNIROUTE_BASE_URL_ENV = "OMNIROUTE_BASE_URL";
const OMNIROUTE_API_KEY_ENV = "OMNIROUTE_API_KEY";
const DEFAULT_BASE_URL = "http://127.0.0.1:20128";
const REQUEST_TIMEOUT_MS = 15_000;
const SOURCE = "omniroute-api";

/**
 * OmniRoute provider ids that are Cursor seats. `cursor` is the IDE/OAuth
 * session connection; `cursor-api` is the same catalog driven by a `crsr_`
 * user API key. Both meter the same Cursor account pools.
 */
const CURSOR_SEAT_PROVIDERS: Record<string, true> = {
  cursor: true,
  "cursor-api": true,
};

type OmniRouteConnection = {
  id: string;
  provider: string;
  name?: string;
  email?: string;
  isActive: boolean;
};

type OmniRouteConfig =
  | { status: "configured"; baseUrl: string; apiKey: string }
  | { status: "missing"; error: string };

export type OmniRouteDeps = {
  fetch?: typeof providerFetch;
  environment?: Readonly<Record<string, string | undefined>>;
};

export function createOmniRouteAdapter(
  deps: OmniRouteDeps = {},
): ProviderAdapter {
  const fetchImpl = deps.fetch ?? providerFetch;
  const environment = deps.environment ?? process.env;
  const config = resolveConfig(environment);

  async function gatewayGet(path: string): Promise<unknown> {
    if (config.status !== "configured") {
      throw new Error(config.error);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${config.baseUrl}${path}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new OmniRouteAuthError(
          `OmniRoute rejected the API key (${response.status}); it needs the manage scope`,
        );
      }
      if (response.status === 429) {
        throw new OmniRouteRateLimitError(response.headers.get("retry-after"));
      }
      if (!response.ok) {
        throw new Error(`OmniRoute request failed (${response.status})`);
      }
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function listCursorSeats(): Promise<OmniRouteConnection[]> {
    const data = await gatewayGet("/api/providers");
    const body = objectValue(data);
    const connections = Array.isArray(body?.connections)
      ? (body.connections as unknown[])
      : [];
    const seats: OmniRouteConnection[] = [];
    for (const raw of connections) {
      const record = objectValue(raw);
      if (!record) continue;
      const id = stringValue(record.id);
      const provider = stringValue(record.provider);
      if (!id || !provider || !CURSOR_SEAT_PROVIDERS[provider]) continue;
      if (record.isActive === false || record.is_active === false) continue;
      seats.push({
        id,
        provider,
        name: stringValue(record.name),
        email: stringValue(record.email),
        isActive: true,
      });
    }
    return seats;
  }

  async function fetchSeatUsage(
    connectionId: string,
  ): Promise<Record<string, unknown>> {
    const data = await gatewayGet(
      `/api/usage/${encodeURIComponent(connectionId)}`,
    );
    const record = objectValue(data);
    if (!record) throw new Error("usage response not an object");
    const message = stringValue(record.error) ?? stringValue(record.message);
    if (message) throw new Error(message);
    return record;
  }

  function apiKey(): string {
    return config.status === "configured" ? config.apiKey : "";
  }

  async function fetchQuota(): Promise<ProviderQuota> {
    const attempts: SourceAttempt[] = [];

    if (config.status !== "configured") {
      attempts.push({
        source: SOURCE,
        status: "skipped",
        error: config.error,
        credentialPresent: false,
      });
      return failedProvider({
        provider: "omniroute",
        label: "OmniRoute",
        status: "auth_required",
        error: config.error,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    }

    attempts.push({ source: SOURCE, status: "failed" });
    let seats: OmniRouteConnection[];
    try {
      seats = await listCursorSeats();
    } catch (error) {
      return gatewayFailure(error, attempts);
    }

    const windows: QuotaWindow[] = [];
    const seatErrors: string[] = [];
    const seatSlugs = assignSeatSlugs(seats);
    for (const seat of seats) {
      const slug = seatSlugs.get(seat.id) ?? seat.id;
      try {
        const usage = await fetchSeatUsage(seat.id);
        windows.push(...seatWindows(slug, usage));
      } catch (error) {
        // A seat that cannot be read still gets named: its scope reports
        // unknown headroom instead of silently disappearing from the pool view.
        seatErrors.push(`${slug}: ${errorMessage(error, apiKey())}`);
        windows.push({
          id: `seat:${slug}:usage`,
          label: `${slug} usage`,
          kind: "unknown",
        });
      }
    }

    attempts[attempts.length - 1] = { source: SOURCE, status: "success" };
    // A reachable gateway with no Cursor seats is a fresh empty reading, not a
    // failure: it clears any cached seat snapshot rather than serving it.
    const provider = successProvider({
      provider: "omniroute",
      label: "OmniRoute",
      source: "api",
      windows,
      refreshedAt: nowIso(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    if (seatErrors.length > 0) {
      provider.state.error = seatErrors.join("; ");
    } else if (seats.length === 0) {
      provider.state.error =
        "gateway reachable; no active Cursor seat connections";
    }
    return provider;
  }

  async function inspectAuth(): Promise<AuthProviderReport> {
    return {
      provider: "omniroute",
      sources: [
        config.status === "configured"
          ? {
              source: SOURCE,
              path: config.baseUrl,
              status: "available",
              credentialPresent: true,
            }
          : {
              source: SOURCE,
              path:
                environment[OMNIROUTE_BASE_URL_ENV]?.trim() ?? DEFAULT_BASE_URL,
              status: "missing",
              error: config.error,
              credentialPresent: false,
            },
      ],
    };
  }

  function gatewayFailure(
    error: unknown,
    attempts: SourceAttempt[],
  ): ProviderQuota {
    const message = errorMessage(error, apiKey());
    attempts[attempts.length - 1] = {
      source: SOURCE,
      status: "failed",
      error: message,
    };
    if (error instanceof OmniRouteAuthError) {
      // A definitive rejection retires the cached snapshot: the key on file no
      // longer describes a usable reading.
      try {
        deleteCachedProvider("omniroute");
      } catch {
        // Cache retirement is best effort.
      }
      return failedProvider({
        provider: "omniroute",
        label: "OmniRoute",
        status: "auth_required",
        error: message,
        sourcesTried: sourceNames(attempts),
        attempts,
      });
    }
    const cached = readCachedProvider("omniroute");
    if (cached) {
      return staleFromCache(cached, message, sourceNames(attempts), attempts);
    }
    return failedProvider({
      provider: "omniroute",
      label: "OmniRoute",
      status:
        error instanceof OmniRouteRateLimitError ? "rate_limited" : "error",
      error: message,
      retryAfter:
        error instanceof OmniRouteRateLimitError ? error.retryAfter : undefined,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }

  return { id: "omniroute", label: "OmniRoute", fetchQuota, inspectAuth };
}

export const omnirouteAdapter: ProviderAdapter = createOmniRouteAdapter();
function resolveConfig(
  environment: Readonly<Record<string, string | undefined>>,
): OmniRouteConfig {
  const rawBase = environment[OMNIROUTE_BASE_URL_ENV]?.trim();
  const baseUrl = rawBase ?? DEFAULT_BASE_URL;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return {
      status: "missing",
      error: `${OMNIROUTE_BASE_URL_ENV} is not a valid URL`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      status: "missing",
      error: `${OMNIROUTE_BASE_URL_ENV} must be http or https`,
    };
  }
  const apiKey = usableLiteralSecret(environment[OMNIROUTE_API_KEY_ENV]);
  if (!apiKey) {
    return {
      status: "missing",
      error: `${OMNIROUTE_API_KEY_ENV} not set (needs an OmniRoute API key with manage scope)`,
    };
  }
  return { status: "configured", baseUrl: parsed.origin, apiKey };
}

/**
 * One scope per seat: each OmniRoute connection is an independent Cursor
 * account pool, so windows are prefixed `seat:<slug>:` and the seat's quota
 * keys become its windows. Dollar-denominated quotas carry spent/limit USD;
 * other units report percentages only.
 */
function seatWindows(
  slug: string,
  usage: Record<string, unknown>,
): QuotaWindow[] {
  const quotas = objectValue(usage.quotas);
  if (!quotas) {
    return [
      { id: `seat:${slug}:usage`, label: `${slug} usage`, kind: "unknown" },
    ];
  }
  const windows: QuotaWindow[] = [];
  for (const [key, raw] of Object.entries(quotas)) {
    const quota = objectValue(raw);
    if (!quota || quota.unlimited === true) continue;
    const keySlug = normalizeKey(key);
    const percentUsed = quotaPercentUsed(quota);
    const resetsAt = isoValue(quota.resetAt);
    const isUsd =
      typeof quota.currency === "string" &&
      quota.currency.trim().toLowerCase() === "usd";
    const total = numberValue(quota.total);
    const used = numberValue(quota.used);
    windows.push(
      withRemaining({
        id: `seat:${slug}:${keySlug}`,
        label: `${slug} ${key}`,
        kind: resetsAt ? "monthly" : "unknown",
        percentUsed,
        resetsAt,
        ...(isUsd && used !== undefined ? { spentUsd: used } : {}),
        ...(isUsd && total !== undefined && total > 0
          ? { limitUsd: total }
          : {}),
      }),
    );
  }
  if (windows.length === 0) {
    windows.push({
      id: `seat:${slug}:usage`,
      label: `${slug} usage`,
      kind: "unknown",
    });
  }
  return windows;
}

function quotaPercentUsed(quota: Record<string, unknown>): number | undefined {
  const usedPercentage = numberValue(quota.usedPercentage);
  if (usedPercentage !== undefined) return clampPercent(usedPercentage);
  const remainingPercentage = numberValue(quota.remainingPercentage);
  if (remainingPercentage !== undefined) {
    return clampPercent(100 - remainingPercentage);
  }
  const used = numberValue(quota.used);
  const total = numberValue(quota.total);
  if (used !== undefined && total !== undefined && total > 0) {
    return clampPercent((used / total) * 100);
  }
  return undefined;
}

/**
 * Seat slugs name scopes and window ids, so they must be unique and stable:
 * prefer the connection name (or email), fall back to the connection id, and
 * suffix collisions deterministically in listed order.
 */
function assignSeatSlugs(seats: OmniRouteConnection[]): Map<string, string> {
  const slugs = new Map<string, string>();
  const taken = new Map<string, number>();
  for (const seat of seats) {
    const base = normalizeKey(seat.name ?? seat.email ?? "") || seat.id;
    const seen = taken.get(base) ?? 0;
    taken.set(base, seen + 1);
    slugs.set(seat.id, seen === 0 ? base : `${base}-${seen + 1}`);
  }
  return slugs;
}

function normalizeKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isoValue(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function errorMessage(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return redactSecret(raw, apiKey);
}

class OmniRouteAuthError extends Error {}

class OmniRouteRateLimitError extends Error {
  retryAfter?: string;
  constructor(retryAfterHeader: string | null) {
    super("OmniRoute rate limited the request");
    this.retryAfter = retryAfterToIso(retryAfterHeader);
  }
}
