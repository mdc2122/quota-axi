import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCachedProvider, writeCachedProviders } from "../../src/cache.js";
import { withQuotaSemantics } from "../../src/interpretation.js";
import { createOmniRouteAdapter } from "../../src/providers/omniroute.js";
import type { ProviderQuota } from "../../src/types.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const BASE_URL = "http://omniroute.test:20128";
const API_KEY = "om-test-key-42";
const ENV = {
  OMNIROUTE_BASE_URL: BASE_URL,
  OMNIROUTE_API_KEY: API_KEY,
};

const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-omniroute-cache-"));
  process.env.XDG_CACHE_HOME = tempDir;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function gatewayFetch(handlers: Record<string, unknown | Response>) {
  return vi.fn(async (input: unknown): Promise<Response> => {
    const url = String(input);
    for (const [path, value] of Object.entries(handlers)) {
      if (
        url === `${BASE_URL}${path}` ||
        url.startsWith(`${BASE_URL}${path}?`)
      ) {
        return value instanceof Response ? value : jsonResponse(value);
      }
    }
    return jsonResponse({ error: "not found" }, 404);
  });
}

const CONNECTIONS = {
  connections: [
    {
      id: "conn-seat-1",
      provider: "cursor",
      name: "Seat One",
      isActive: true,
    },
    {
      id: "conn-seat-2",
      provider: "cursor-api",
      name: "Seat Two",
      isActive: true,
    },
    { id: "conn-other", provider: "muse-code", name: "Muse", isActive: true },
    {
      id: "conn-disabled",
      provider: "cursor",
      name: "Disabled",
      isActive: false,
    },
  ],
  total: 4,
};

const SEAT_ONE_USAGE = {
  plan: "Cursor Pro",
  quotas: {
    Total: {
      used: 12.5,
      total: 50,
      currency: "USD",
      remaining: 37.5,
      remainingPercentage: 75,
      resetAt: "2026-10-01T00:00:00.000Z",
      unlimited: false,
    },
    "Auto + Composer": {
      used: 10,
      total: 50,
      remainingPercentage: 80,
      resetAt: "2026-10-01T00:00:00.000Z",
      unlimited: false,
    },
    API: {
      used: 45,
      total: 50,
      remainingPercentage: 10,
      resetAt: "2026-10-01T00:00:00.000Z",
      unlimited: false,
    },
  },
};

const SEAT_TWO_USAGE = {
  quotas: {
    Total: {
      used: 5,
      total: 20,
      remainingPercentage: 75,
      resetAt: "2026-10-01T00:00:00.000Z",
      unlimited: false,
    },
  },
};

describe("OmniRoute provider", () => {
  it("reports auth_required without contacting the gateway when the API key is unset", async () => {
    const request = vi.fn();
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: { OMNIROUTE_BASE_URL: BASE_URL },
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(request).not.toHaveBeenCalled();
    expect(report.state.status).toBe("auth_required");
    expect(report.state.error).toContain("OMNIROUTE_API_KEY");
    expect(report.attempts).toEqual([
      expect.objectContaining({ source: "omniroute-api", status: "skipped" }),
    ]);
  });

  it("reports each active Cursor seat as its own scope with the joint minimum", async () => {
    const request = gatewayFetch({
      "/api/providers": CONNECTIONS,
      "/api/usage/conn-seat-1": SEAT_ONE_USAGE,
      "/api/usage/conn-seat-2": SEAT_TWO_USAGE,
    });
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: ENV,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.source).toBe("api");
    // Non-cursor and inactive connections are not seats.
    expect(request).toHaveBeenCalledTimes(3);
    const urls = request.mock.calls.map((call) => String(call[0]));
    expect(urls).not.toContain(`${BASE_URL}/api/usage/conn-other`);
    expect(urls).not.toContain(`${BASE_URL}/api/usage/conn-disabled`);

    const windowIds = report.windows.map((window) => window.id);
    expect(windowIds).toEqual([
      "seat:seat_one:total",
      "seat:seat_one:auto_composer",
      "seat:seat_one:api",
      "seat:seat_two:total",
    ]);
    expect(report.windows[0]).toMatchObject({
      kind: "monthly",
      percentUsed: 25,
      percentRemaining: 75,
      resetsAt: "2026-10-01T00:00:00.000Z",
      spentUsd: 12.5,
      limitUsd: 50,
    });

    const withSemantics = withQuotaSemantics(report, "2026-09-17T00:00:00Z");
    const scopes =
      withSemantics.quotaSemantics?.effectiveAvailability.map(
        (scope) => scope.scope,
      ) ?? [];
    expect(scopes).toEqual(["seat:seat_one", "seat:seat_two"]);
    const seatOne = withSemantics.quotaSemantics?.effectiveAvailability[0];
    expect(seatOne).toMatchObject({
      status: "known",
      effectivePercentRemaining: 10,
      limitingWindowIds: ["seat:seat_one:api"],
    });
  });

  it("keeps a seat visible with unknown headroom when its usage read fails", async () => {
    const request = gatewayFetch({
      "/api/providers": CONNECTIONS,
      "/api/usage/conn-seat-1": SEAT_ONE_USAGE,
      "/api/usage/conn-seat-2": jsonResponse({ error: "boom" }, 500),
    });
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: ENV,
    });

    const report = await adapter.fetchQuota(OPTIONS);
    const withSemantics = withQuotaSemantics(report, "2026-09-17T00:00:00Z");

    expect(report.state.status).toBe("fresh");
    expect(report.state.error).toContain("seat_two");
    const seatTwo = withSemantics.quotaSemantics?.effectiveAvailability.find(
      (scope) => scope.scope === "seat:seat_two",
    );
    expect(seatTwo?.status).toBe("unknown");
    expect(withSemantics.quotaSemantics?.status).toBe("partial");
    expect(withSemantics.quotaSemantics?.unresolvedWindowIds).toContain(
      "seat:seat_two:usage",
    );
  });

  it("keeps duplicate seat slugs tied to connection ids when inventory order changes", async () => {
    const usage = (remainingPercentage: number) => ({
      quotas: {
        Total: { remainingPercentage, resetAt: "2026-10-01T00:00:00.000Z" },
      },
    });
    const firstRequest = gatewayFetch({
      "/api/providers": {
        connections: [
          { id: "conn-b", provider: "cursor", name: "Shared", isActive: true },
          { id: "conn-a", provider: "cursor", name: "Shared", isActive: true },
        ],
      },
      "/api/usage/conn-a": usage(80),
      "/api/usage/conn-b": usage(20),
    });
    const secondRequest = gatewayFetch({
      "/api/providers": {
        connections: [
          { id: "conn-a", provider: "cursor", name: "Shared", isActive: true },
          { id: "conn-b", provider: "cursor", name: "Shared", isActive: true },
        ],
      },
      "/api/usage/conn-a": usage(80),
      "/api/usage/conn-b": usage(20),
    });

    const first = await createOmniRouteAdapter({
      fetch: firstRequest,
      environment: ENV,
    }).fetchQuota(OPTIONS);
    const second = await createOmniRouteAdapter({
      fetch: secondRequest,
      environment: ENV,
    }).fetchQuota(OPTIONS);

    const windowValues = (report: ProviderQuota) =>
      Object.fromEntries(
        report.windows.map((window) => [window.id, window.percentRemaining]),
      );
    expect(windowValues(first)).toEqual({
      "seat:shared:total": 80,
      "seat:shared-2:total": 20,
    });
    expect(windowValues(second)).toEqual(windowValues(first));
  });

  it("leaves unfamiliar quota keys unresolved instead of folding them into the bound", async () => {
    const request = gatewayFetch({
      "/api/providers": {
        connections: [
          { id: "c1", provider: "cursor", name: "Seat", isActive: true },
        ],
      },
      "/api/usage/c1": {
        quotas: {
          Total: { used: 1, total: 10, remainingPercentage: 90 },
          Mystery: { used: 3, total: 10, remainingPercentage: 70 },
          Broken: null,
        },
      },
    });
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: ENV,
    });

    const report = await adapter.fetchQuota(OPTIONS);
    const withSemantics = withQuotaSemantics(report, "2026-09-17T00:00:00Z");

    expect(withSemantics.quotaSemantics?.status).toBe("partial");
    expect(withSemantics.quotaSemantics?.unresolvedWindowIds).toEqual([
      "seat:seat:mystery",
      "seat:seat:broken",
    ]);
    const seat = withSemantics.quotaSemantics?.effectiveAvailability[0];
    expect(seat?.status).toBe("unknown");
  });

  it("retires the cache and reports auth_required on a definitive rejection", async () => {
    writeCachedProviders([cachedOmniRouteQuota()]);
    const request = gatewayFetch({
      "/api/providers": jsonResponse({ error: "Invalid API key" }, 403),
    });
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: ENV,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(report.state.status).toBe("auth_required");
    expect(report.state.error).toContain("manage scope");
    expect(readCachedProvider("omniroute")).toBeUndefined();
  });

  it("serves the stale snapshot when the gateway is unreachable", async () => {
    writeCachedProviders([cachedOmniRouteQuota()]);
    const request = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: ENV,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(report.state.status).toBe("stale");
    expect(report.source).toBe("cache");
    expect(report.windows.map((window) => window.id)).toEqual([
      "seat:seat_one:total",
    ]);
  });

  it("reports a fresh empty reading when the gateway has no Cursor seats", async () => {
    writeCachedProviders([cachedOmniRouteQuota()]);
    const request = gatewayFetch({
      "/api/providers": { connections: [], total: 0 },
    });
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: ENV,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(report.state.status).toBe("fresh");
    expect(report.windows).toEqual([]);
  });

  it("serves the stale snapshot when the inventory shape is malformed", async () => {
    writeCachedProviders([cachedOmniRouteQuota()]);
    const request = gatewayFetch({
      "/api/providers": { providers: [] },
    });
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: ENV,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(report.state.status).toBe("stale");
    expect(report.source).toBe("cache");
    expect(report.windows.map((window) => window.id)).toEqual([
      "seat:seat_one:total",
    ]);
    expect(report.state.error).toContain("missing connections array");
  });

  it("serves the stale snapshot when a connection entry is malformed", async () => {
    writeCachedProviders([cachedOmniRouteQuota()]);
    const request = gatewayFetch({
      "/api/providers": {
        connections: [{ provider: "cursor", isActive: true }],
      },
    });
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: ENV,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(report.state.status).toBe("stale");
    expect(report.source).toBe("cache");
    expect(report.windows.map((window) => window.id)).toEqual([
      "seat:seat_one:total",
    ]);
    expect(report.state.error).toContain("malformed connection");
  });

  it("sends the API key as a bearer token and never leaks it into errors", async () => {
    const request = vi.fn(async () =>
      jsonResponse({ error: `denied for ${API_KEY}` }, 500),
    );
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: ENV,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    const init = request.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(report.state.error).not.toContain(API_KEY);
  });

  it("propagates per-seat rate limits with their retry deadline", async () => {
    const request = gatewayFetch({
      "/api/providers": CONNECTIONS,
      "/api/usage/conn-seat-1": new Response(null, {
        status: 429,
        headers: { "retry-after": "Wed, 17 Sep 2026 00:05:00 GMT" },
      }),
    });
    const adapter = createOmniRouteAdapter({
      fetch: request,
      environment: ENV,
    });

    const report = await adapter.fetchQuota(OPTIONS);

    expect(report.state.status).toBe("rate_limited");
    expect(report.state.retryAfter).toBe("2026-09-17T00:05:00.000Z");
  });

  it("reports the environment source in inspectAuth", async () => {
    const configured = await createOmniRouteAdapter({
      environment: ENV,
    }).inspectAuth(OPTIONS);
    expect(configured.sources[0]).toMatchObject({
      source: "omniroute-api",
      status: "available",
      credentialPresent: true,
      path: BASE_URL,
    });

    const missing = await createOmniRouteAdapter({
      environment: {},
    }).inspectAuth(OPTIONS);
    expect(missing.sources[0]).toMatchObject({
      source: "omniroute-api",
      status: "missing",
      credentialPresent: false,
    });
  });
});

function cachedOmniRouteQuota(): ProviderQuota {
  return {
    provider: "omniroute",
    label: "OmniRoute",
    source: "api",
    windows: [
      {
        id: "seat:seat_one:total",
        label: "seat_one Total",
        kind: "monthly",
        percentUsed: 40,
        percentRemaining: 60,
      },
    ],
    state: {
      status: "fresh",
      stale: false,
      refreshedAt: "2026-09-17T00:00:00.000Z",
      sourcesTried: ["omniroute-api"],
    },
  };
}
