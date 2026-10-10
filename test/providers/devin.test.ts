import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withQuotaSemantics } from "../../src/interpretation.js";
import {
  createDevinAdapter,
  DEVIN_USER_STATUS_URL,
  normalizeDevinStatus,
  parseDevinUserStatus,
  resolveDevinCredential,
} from "../../src/providers/devin.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const TOKEN = "devin-session-token$synthetic-devin-token-42";
/**
 * A recorded GetUserStatus response with identity fields replaced by synthetic
 * values and the model catalog cut to the promoted families plus two metered
 * models. Recorded while the Usage & limits page read Pro, daily 0% used,
 * weekly 100% used, renews 2026-10-11, with SWE-2 promotional until Oct 16.
 */
const RECORDED = new Uint8Array(
  readFileSync(join(process.cwd(), "test/fixtures/devin/get-user-status.bin")),
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function authDir(records: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "quota-axi-devin-"));
  for (const [name, value] of Object.entries(records)) {
    writeFileSync(
      join(dir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  return dir;
}

function available() {
  return {
    status: "available" as const,
    token: TOKEN,
    path: "/auth/devin-user.json",
  };
}

function varint(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const low = remaining % 128;
    remaining = Math.floor(remaining / 128);
    bytes.push(remaining > 0 ? low | 0x80 : low);
  } while (remaining > 0);
  return bytes;
}

function message(...parts: number[][]): number[] {
  return parts.flat();
}

function int(field: number, value: number): number[] {
  return [...varint(field << 3), ...varint(value)];
}

function bytes(field: number, value: number[] | string): number[] {
  const payload =
    typeof value === "string" ? [...new TextEncoder().encode(value)] : value;
  return [...varint((field << 3) | 2), ...varint(payload.length), ...payload];
}

/** A GetUserStatusResponse carrying only the given plan-status fields. */
function planStatusResponse(...planStatus: number[][]): Uint8Array {
  return Uint8Array.from(bytes(1, message(bytes(13, message(...planStatus)))));
}

const DAILY_RESET = 1_791_619_200; // 2026-10-10T08:00:00Z
const WEEKLY_RESET = 1_791_705_600; // 2026-10-11T08:00:00Z

describe("Devin GetUserStatus parser", () => {
  it("reads plan, daily and weekly quotas, renewal, and promotions from the recorded response", () => {
    const status = parseDevinUserStatus(RECORDED);
    expect(status).toMatchObject({
      email: "user@example.com",
      plan: "Pro",
      planStart: "2026-09-11T18:14:08.000Z",
      planEnd: "2026-10-11T18:14:08.000Z",
      dailyRemainingPercent: 100,
      dailyResetsAt: "2026-10-10T08:00:00.000Z",
      weeklyResetsAt: "2026-10-11T08:00:00.000Z",
    });
    // The spent weekly quota is the proto3 zero: the field is absent.
    expect(status.weeklyRemainingPercent).toBeUndefined();
    expect(status.promotions).toEqual(
      expect.arrayContaining([
        { family: "swe-2", label: "SWE-2", endsAt: "2026-10-16T06:59:59.000Z" },
        {
          family: "gemini-3-8-flash",
          label: "Gemini 3.8 Flash",
          endsAt: "2027-01-01T08:00:00.000Z",
        },
      ]),
    );
    // Every SWE-2 variant repeats the promotion; it is reported once.
    expect(
      status.promotions.filter(({ family }) => family === "swe-2"),
    ).toHaveLength(1);
    // Metered catalog models carry no promotion.
    expect(status.promotions.map(({ family }) => family)).not.toContain(
      "claude-opus-5-5",
    );
  });

  it("reports the recorded weekly quota as fully used, matching the Usage & limits page", () => {
    const normalized = normalizeDevinStatus(parseDevinUserStatus(RECORDED));
    expect(normalized.plan).toBe("Pro");
    expect(normalized.windows).toEqual(
      expect.arrayContaining([
        {
          id: "daily",
          label: "day",
          kind: "unknown",
          windowSeconds: 86_400,
          percentUsed: 0,
          percentRemaining: 100,
          resetsAt: "2026-10-10T08:00:00.000Z",
        },
        {
          id: "weekly",
          label: "week",
          kind: "weekly",
          windowSeconds: 604_800,
          percentUsed: 100,
          percentRemaining: 0,
          resetsAt: "2026-10-11T08:00:00.000Z",
        },
        {
          id: "plan_period",
          label: "renewal",
          kind: "monthly",
          startsAt: "2026-09-11T18:14:08.000Z",
          resetsAt: "2026-10-11T18:14:08.000Z",
        },
        {
          id: "promo:swe-2",
          label: "SWE-2 promo",
          kind: "model",
          resetsAt: "2026-10-16T06:59:59.000Z",
        },
      ]),
    );
  });

  it("does not invent a zero for a window whose reset the response does not carry", () => {
    const normalized = normalizeDevinStatus(
      parseDevinUserStatus(planStatusResponse(int(17, DAILY_RESET))),
    );
    expect(normalized.windows.map(({ id }) => id)).toEqual(["daily"]);
    expect(normalized.windows[0]).toMatchObject({ percentRemaining: 0 });

    expect(
      normalizeDevinStatus(parseDevinUserStatus(planStatusResponse())).windows,
    ).toEqual([]);
  });

  it("names an out-of-range percentage untrusted instead of clamping it", () => {
    const normalized = normalizeDevinStatus(
      parseDevinUserStatus(
        planStatusResponse(
          int(14, 140),
          int(15, 40),
          int(17, DAILY_RESET),
          int(18, WEEKLY_RESET),
        ),
      ),
    );
    expect(normalized.untrustedWindowIds).toEqual(["daily"]);
    expect(normalized.windows.map(({ id }) => id)).toEqual(["weekly"]);
    expect(normalized.windows[0]).toMatchObject({
      percentRemaining: 40,
      percentUsed: 60,
    });
  });

  it("rejects a truncated protobuf message", () => {
    expect(() =>
      parseDevinUserStatus(RECORDED.subarray(0, RECORDED.length - 7)),
    ).toThrow("malformed_response");
  });
});

describe("Devin credential discovery", () => {
  it("reads the single enabled CLIProxyAPI devin login in CLIProxyAPI's field order", () => {
    const dir = authDir({
      "devin-user.json": {
        type: "devin",
        api_key: TOKEN,
        session_token: "devin-session-token$other",
      },
      "claude-user.json": { type: "claude", access_token: "x" },
    });
    expect(resolveDevinCredential(dir)).toEqual({
      status: "available",
      token: TOKEN,
      path: join(dir, "devin-user.json"),
    });
  });

  it("treats a disabled login as absent and an empty one as invalid", () => {
    expect(
      resolveDevinCredential(
        authDir({
          "devin-user.json": { type: "devin", api_key: TOKEN, disabled: true },
        }),
      ).status,
    ).toBe("missing");
    expect(
      resolveDevinCredential(
        authDir({ "devin-user.json": { type: "devin", api_key: "  " } }),
      ).status,
    ).toBe("invalid");
    expect(
      resolveDevinCredential(authDir({ "devin-user.json": "{not json" }))
        .status,
    ).toBe("invalid");
  });

  it("refuses to pick between two enabled Devin logins", () => {
    const dir = authDir({
      "devin-a.json": { type: "devin", api_key: TOKEN },
      "devin-b.json": { type: "devin", session_token: `${TOKEN}-b` },
    });
    expect(resolveDevinCredential(dir)).toEqual({
      status: "ambiguous",
      path: dir,
    });
  });

  it("reports an absent auth directory as missing", () => {
    expect(
      resolveDevinCredential(join(tmpdir(), "quota-axi-devin-absent", "x")),
    ).toMatchObject({ status: "missing" });
  });

  it("honours $CLIPROXY_AUTH_DIR", () => {
    const dir = authDir({
      "devin-user.json": { type: "devin", api_key: TOKEN },
    });
    vi.stubEnv("CLIPROXY_AUTH_DIR", dir);
    expect(resolveDevinCredential()).toMatchObject({
      status: "available",
      path: join(dir, "devin-user.json"),
    });
  });
});

describe("Devin provider", () => {
  it("posts one GetUserStatus request and reports the plan windows without the token", async () => {
    const request = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response(RECORDED, { status: 200 }),
    );
    const report = await createDevinAdapter({
      credential: available,
      fetch: request as typeof globalThis.fetch,
      now: () => Date.parse("2026-10-10T01:00:00Z"),
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe(DEVIN_USER_STATUS_URL);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/proto");
    expect(headers.get("authorization")).toBe(`Basic ${TOKEN}-${TOKEN}`);
    expect(new TextDecoder().decode(init?.body as Uint8Array)).toContain(TOKEN);

    expect(report).toMatchObject({
      provider: "devin",
      source: "api",
      plan: "Pro",
      account: { email: "user@example.com" },
      state: { status: "fresh", stale: false },
      attempts: [{ source: "cliproxy:devin", status: "success" }],
    });
    expect(report.windows.find(({ id }) => id === "weekly")).toMatchObject({
      percentRemaining: 0,
      percentUsed: 100,
    });
    expect(JSON.stringify(report)).not.toContain("synthetic-devin-token");
  });

  it("classifies rejection, rate limiting, and request failure", async () => {
    const run = (response: Response) =>
      createDevinAdapter({
        credential: available,
        fetch: vi.fn(async () => response),
        now: () => Date.parse("2026-10-10T01:00:00Z"),
      }).fetchQuota(OPTIONS);

    expect(
      (await run(new Response("no", { status: 401 }))).state,
    ).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
    expect(
      (
        await run(
          new Response("slow down", {
            status: 429,
            headers: { "retry-after": "60" },
          }),
        )
      ).state,
    ).toMatchObject({
      status: "rate_limited",
      error: "provider_rate_limited",
      retryAfter: "2026-10-10T01:01:00.000Z",
    });
    // The service answers a malformed or unknown session with 400, not 401.
    expect(
      (await run(new Response('{"code":"invalid_argument"}', { status: 400 })))
        .state,
    ).toMatchObject({ status: "error", error: "provider_request_rejected" });
    expect(
      (await run(new Response(Uint8Array.from([0x0a, 0x7f]), { status: 200 })))
        .state,
    ).toMatchObject({ status: "error", error: "malformed_response" });
  });

  it("sends nothing without a usable credential", async () => {
    const request = vi.fn();
    const adapter = createDevinAdapter({
      credential: () => ({ status: "missing", path: "/auth" }),
      fetch: request,
    });
    const report = await adapter.fetchQuota(OPTIONS);
    expect(request).not.toHaveBeenCalled();
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "devin_credential_unavailable",
    });
    expect(await adapter.inspectAuth(OPTIONS)).toEqual({
      provider: "devin",
      sources: [{ source: "cliproxy:devin", path: "/auth", status: "missing" }],
    });

    const ambiguous = await createDevinAdapter({
      credential: () => ({ status: "ambiguous", path: "/auth" }),
      fetch: request,
    }).fetchQuota(OPTIONS);
    expect(request).not.toHaveBeenCalled();
    expect(ambiguous.state).toMatchObject({
      status: "error",
      error: "devin_credential_ambiguous",
    });
  });
});

describe("Devin quota semantics", () => {
  async function recordedReport(now: string) {
    const report = await createDevinAdapter({
      credential: available,
      fetch: vi.fn(async () => new Response(RECORDED, { status: 200 })),
      now: () => Date.parse(now),
    }).fetchQuota(OPTIONS);
    return withQuotaSemantics(report, now).quotaSemantics;
  }

  it("bounds all models by the plan windows but does not mark a running promotion exhausted", async () => {
    const semantics = await recordedReport("2026-10-10T01:00:00.000Z");
    expect(semantics?.status).toBe("known");
    expect(
      semantics?.effectiveAvailability.find(
        ({ scope }) => scope === "all_models",
      ),
    ).toMatchObject({
      status: "known",
      effectivePercentRemaining: 0,
      boundedBy: ["daily", "weekly"],
      limitingWindowIds: ["weekly"],
    });
    const swe2 = semantics?.effectiveAvailability.find(
      ({ scope }) => scope === "promo:swe-2",
    );
    expect(swe2).toMatchObject({ status: "unknown" });
    expect(swe2?.effectivePercentRemaining).toBeUndefined();
    expect(swe2?.runway?.status).toBe("unknown");
  });

  it("bounds a family by the plan windows once its promotion has ended", async () => {
    const semantics = await recordedReport("2026-10-16T07:00:00.000Z");
    expect(
      semantics?.effectiveAvailability.find(
        ({ scope }) => scope === "promo:swe-2",
      ),
    ).toMatchObject({
      status: "known",
      boundedBy: ["daily", "weekly"],
    });
  });
});
