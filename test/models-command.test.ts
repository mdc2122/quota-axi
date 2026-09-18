import { afterEach, describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { PROVIDERS } from "../src/providers/index.js";
import type { ProviderAdapter, ProviderQuota } from "../src/types.js";

const originalClaude = PROVIDERS.claude;
const originalCodex = PROVIDERS.codex;
const originalCursor = PROVIDERS.cursor;
const originalCopilot = PROVIDERS.copilot;
const originalGrok = PROVIDERS.grok;
const originalKimi = PROVIDERS.kimi;
const originalOmniRoute = PROVIDERS.omniroute;

afterEach(() => {
  PROVIDERS.claude = originalClaude;
  PROVIDERS.codex = originalCodex;
  PROVIDERS.cursor = originalCursor;
  PROVIDERS.copilot = originalCopilot;
  PROVIDERS.grok = originalGrok;
  PROVIDERS.kimi = originalKimi;
  PROVIDERS.omniroute = originalOmniRoute;
  process.exitCode = undefined;
});

describe("models command", () => {
  it("emits filtered JSON model evidence and compact TOON", async () => {
    PROVIDERS.claude = adapter({
      provider: "claude",
      label: "Claude",
      source: "oauth",
      windows: [
        {
          id: "model:fable",
          label: "Fable week",
          kind: "model",
          percentUsed: 20,
          percentRemaining: 80,
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
    });

    const json = JSON.parse(
      await capture([
        "models",
        "--provider",
        "claude",
        "--intelligence",
        "high",
        "--json",
      ]),
    );
    expect(json).toMatchObject({
      schemaVersion: 1,
      catalog: { version: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
    });
    expect(json.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "claude",
          id: "claude-opus-4-5",
          intelligence: "high",
          quotaScopes: ["model:fable"],
          state: { status: "fresh", stale: false },
        }),
      ]),
    );
    expect(json.models).toHaveLength(2);

    const sorted = JSON.parse(
      await capture([
        "models",
        "--provider",
        "claude",
        "--sort",
        "runway",
        "--json",
      ]),
    );
    expect(sorted.sort).toMatchObject({ key: "runway" });
    expect(sorted.sort.tieGroups).toContainEqual([
      { provider: "claude", id: "claude-haiku-4-5" },
      { provider: "claude", id: "claude-opus-4-5" },
      { provider: "claude", id: "claude-sonnet-4-5" },
    ]);

    const toon = await capture(["models", "--provider", "claude"]);
    expect(toon).toContain("models[");
    expect(toon).toContain("claude-opus-4-5");
    expect(toon).toContain(
      "Default model order is deterministic and non-preferential",
    );
  });

  it("rejects unsupported model filters and comparators as usage errors", async () => {
    const intelligence = await capture([
      "models",
      "--intelligence",
      "frontier",
    ]);
    expect(intelligence).toContain(
      "--intelligence requires high, medium, or low",
    );
    expect(process.exitCode).toBe(2);

    process.exitCode = undefined;
    const sort = await capture(["models", "--sort", "cost"]);
    expect(sort).toContain("Supported sort keys: runway");
    expect(process.exitCode).toBe(2);
  });

  it("fetches repeated provider scopes once and emits distinct unmatched scopes", async () => {
    let fetches = 0;
    const quota: ProviderQuota = {
      provider: "claude",
      label: "Claude",
      source: "oauth",
      windows: [
        {
          id: "model:unmapped",
          label: "Unmapped",
          kind: "model",
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["oauth"] },
    };
    PROVIDERS.claude = {
      ...adapter(quota),
      async fetchQuota() {
        fetches++;
        return quota;
      },
    };

    const json = JSON.parse(
      await capture(["models", "--provider", "claude,claude", "--json"]),
    );
    expect(fetches).toBe(1);
    expect(json.unmatchedWindowIds).toEqual(["claude/model:unmapped"]);
  });

  it("represents every OmniRoute seat in model rows with the tightest seat as evidence", async () => {
    PROVIDERS.omniroute = adapter({
      provider: "omniroute",
      label: "OmniRoute",
      source: "api",
      windows: [
        {
          id: "seat:seat_one:total",
          label: "seat_one Total",
          kind: "monthly",
          percentUsed: 80,
          percentRemaining: 20,
          resetsAt: "2026-10-01T00:00:00.000Z",
        },
        {
          id: "seat:seat_two:total",
          label: "seat_two Total",
          kind: "monthly",
          percentUsed: 10,
          percentRemaining: 90,
          resetsAt: "2026-10-01T00:00:00.000Z",
        },
      ],
      state: { status: "fresh", stale: false, sourcesTried: ["omniroute-api"] },
    });

    const json = JSON.parse(
      await capture(["models", "--provider", "omniroute", "--json"]),
    );
    const gemini = json.models.find(
      (model: { id: string }) => model.id === "cursor/gemini-3.8",
    );
    const grok = json.models.find(
      (model: { id: string }) => model.id === "cursor/grok-4.6",
    );
    for (const model of [gemini, grok]) {
      expect(model.quotaScopes).toEqual(["seat:seat_one", "seat:seat_two"]);
      expect(model.effective).toMatchObject({
        scope: "seat:seat_one",
        status: "known",
        effectivePercentRemaining: 20,
      });
    }
  });

  it("fails when every catalog provider fails and rejects non-catalog scopes", async () => {
    for (const provider of ["claude", "codex", "grok", "kimi"] as const) {
      PROVIDERS[provider] = adapter(failedQuota(provider));
    }
    PROVIDERS.cursor = adapter({
      provider: "cursor",
      label: "Cursor",
      source: "api",
      windows: [],
      state: { status: "fresh", stale: false, sourcesTried: ["api"] },
    });

    const json = JSON.parse(await capture(["models", "--json"]));
    expect(json.models).toHaveLength(14);
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    const unsupported = await capture(["models", "--provider", "cursor"]);
    expect(unsupported).toContain("models does not support provider: cursor");
    expect(process.exitCode).toBe(2);
  });
});

async function capture(argv: string[]): Promise<string> {
  const chunks: string[] = [];
  await main({
    argv,
    binPath: "quota-axi",
    stdout: { write: (chunk) => chunks.push(String(chunk)) },
  });
  return chunks.join("");
}

function adapter(quota: ProviderQuota): ProviderAdapter {
  return {
    id: quota.provider,
    label: quota.label,
    async fetchQuota() {
      return quota;
    },
    async inspectAuth() {
      return { provider: quota.provider, sources: [] };
    },
  };
}

function failedQuota(
  provider: "claude" | "codex" | "grok" | "kimi",
): ProviderQuota {
  return {
    provider,
    label: provider,
    source: "unavailable",
    windows: [],
    state: {
      status: "unavailable",
      stale: false,
      sourcesTried: ["unavailable"],
    },
  };
}
