import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readJsonFileResult } from "../lib/fs.js";
import { providerFetch } from "../lib/http.js";
import { retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderQuota,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import { failedProvider, sourceNames, successProvider } from "./common.js";

/**
 * Devin's "Usage & limits" page reads the account's plan status from the
 * Windsurf/Codeium seat-management service. This is the same Connect-RPC unary
 * call CLIProxyAPI's Devin executor makes to refresh its quota signals; the
 * request and response are binary protobuf, not JSON.
 */
export const DEVIN_USER_STATUS_URL =
  "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetUserStatus";
export const DEVIN_CREDENTIAL_SOURCE = "cliproxy:devin";

const LABEL = "Devin";
const DEADLINE_MS = 15_000;
/** The live response carries a ~140 KiB catalog alongside the plan status. */
const RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;
const DAY_SECONDS = 86_400;
const WEEK_SECONDS = 604_800;
/** CLIProxyAPI's default `auth-dir`. */
const DEFAULT_AUTH_DIR = join(homedir(), ".cli-proxy-api");
/** Client metadata the seat-management service expects (as CLIProxyAPI sends). */
const IDE_NAME = "chisel";
const IDE_VERSION = "3000.10.21";
const DEVICE_FINGERPRINT_BYTES = 366;

type CredentialResolution =
  | { status: "available"; token: string; path: string }
  | { status: "missing" | "invalid" | "ambiguous" | "error"; path: string };

type Dependencies = {
  credential: () => CredentialResolution;
  fetch: typeof globalThis.fetch;
  now: () => number;
  deadlineMs: number;
};

/** A model family the service marks as promotional until `endsAt`. */
export type DevinPromotion = {
  /** The catalog's model-family key, e.g. `swe-2`. */
  family: string;
  label: string;
  endsAt: string;
};

export type DevinUserStatus = {
  email?: string;
  plan?: string;
  planStart?: string;
  planEnd?: string;
  dailyRemainingPercent?: number;
  weeklyRemainingPercent?: number;
  dailyResetsAt?: string;
  weeklyResetsAt?: string;
  promotions: DevinPromotion[];
};

export type NormalizedDevinStatus = {
  plan?: string;
  email?: string;
  windows: QuotaWindow[];
  untrustedWindowIds: string[];
};

/** `$CLIPROXY_AUTH_DIR`, else CLIProxyAPI's default `~/.cli-proxy-api`. */
export function devinAuthDir(): string {
  const configured = process.env.CLIPROXY_AUTH_DIR?.trim();
  return configured ? configured : DEFAULT_AUTH_DIR;
}

/**
 * Find the single enabled Devin login CLIProxyAPI stored as
 * `devin-<identifier>.json` in its auth directory. Several enabled logins name
 * several accounts, and picking one would attribute its numbers to the others,
 * so that case resolves as `ambiguous` and sends nothing.
 */
export function resolveDevinCredential(
  dir = devinAuthDir(),
): CredentialResolution {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    return {
      status: errorCode(error) === "ENOENT" ? "missing" : "error",
      path: dir,
    };
  }
  const files = names
    .filter((name) => name.startsWith("devin-") && name.endsWith(".json"))
    .sort();
  const resolutions = files.map((name) => {
    const path = join(dir, name);
    const result = readJsonFileResult(path);
    if (result.status === "missing")
      return { status: "missing" as const, path };
    if (result.status === "invalid")
      return {
        status:
          result.error === "file_read_error"
            ? ("error" as const)
            : ("invalid" as const),
        path,
      };
    return extractDevinCredential(result.value, path);
  });
  const available = resolutions.filter(
    (resolution) => resolution.status === "available",
  );
  if (available.length > 1) return { status: "ambiguous", path: dir };
  if (available.length === 1) return available[0];
  return (
    resolutions.find((resolution) => resolution.status === "error") ??
    resolutions.find((resolution) => resolution.status === "invalid") ?? {
      status: "missing",
      path: dir,
    }
  );
}

/**
 * Read the session token from one CLIProxyAPI Devin auth record, in the field
 * order CLIProxyAPI itself uses (`api_key`, then `session_token`, then
 * `token`). A disabled record is one CLIProxyAPI will not use, so it is not a
 * login for this account either.
 */
export function extractDevinCredential(
  value: unknown,
  path: string,
): CredentialResolution {
  const record = objectValue(value);
  if (!record || record.type !== "devin") return { status: "missing", path };
  if (record.disabled === true) return { status: "missing", path };
  const token = [record.api_key, record.session_token, record.token]
    .map(sessionToken)
    .find((candidate): candidate is string => candidate !== undefined);
  return token
    ? { status: "available", token, path }
    : { status: "invalid", path };
}

export function createDevinAdapter(
  overrides: Partial<Dependencies> = {},
): ProviderAdapter {
  const dependencies: Dependencies = {
    credential: () => resolveDevinCredential(),
    fetch: providerFetch,
    now: Date.now,
    deadlineMs: DEADLINE_MS,
    ...overrides,
  };
  return {
    id: "devin",
    label: LABEL,
    fetchQuota: () => fetchQuota(dependencies),
    inspectAuth: () => inspectAuth(dependencies),
  };
}

export const devinAdapter = createDevinAdapter();

async function fetchQuota(dependencies: Dependencies): Promise<ProviderQuota> {
  const resolution = dependencies.credential();
  if (resolution.status !== "available") {
    const error = credentialError(resolution);
    const attempts: SourceAttempt[] = [
      {
        source: DEVIN_CREDENTIAL_SOURCE,
        status: "skipped",
        error,
        ...(resolution.status === "missing" ? {} : { credentialPresent: true }),
      },
    ];
    return failedProvider({
      provider: "devin",
      label: LABEL,
      status: resolution.status === "missing" ? "auth_required" : "error",
      error,
      source: "api",
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
  try {
    const body = await requestUserStatus(resolution.token, dependencies);
    const normalized = normalizeDevinStatus(parseDevinUserStatus(body));
    if (normalized.windows.length === 0)
      throw new DevinFailure("quota_missing");
    const attempts: SourceAttempt[] = [
      { source: DEVIN_CREDENTIAL_SOURCE, status: "success" },
    ];
    const report = successProvider({
      provider: "devin",
      label: LABEL,
      source: "api",
      ...(normalized.plan ? { plan: normalized.plan } : {}),
      ...(normalized.email ? { account: { email: normalized.email } } : {}),
      windows: normalized.windows,
      refreshedAt: new Date(dependencies.now()).toISOString(),
      sourcesTried: sourceNames(attempts),
      attempts,
    });
    return normalized.untrustedWindowIds.length > 0
      ? {
          ...report,
          state: {
            ...report.state,
            untrustedWindowIds: normalized.untrustedWindowIds,
          },
        }
      : report;
  } catch (error) {
    const failure =
      error instanceof DevinFailure
        ? error
        : new DevinFailure("quota_request_failed");
    const attempts: SourceAttempt[] = [
      {
        source: DEVIN_CREDENTIAL_SOURCE,
        status: "failed",
        error: failure.message,
      },
    ];
    return failedProvider({
      provider: "devin",
      label: LABEL,
      status:
        failure.message === "provider_auth_rejected"
          ? "auth_required"
          : failure.message === "provider_rate_limited"
            ? "rate_limited"
            : "error",
      error: failure.message,
      source: "api",
      retryAfter: failure.retryAfter,
      sourcesTried: sourceNames(attempts),
      attempts,
    });
  }
}

async function inspectAuth(
  dependencies: Dependencies,
): Promise<AuthProviderReport> {
  const resolution = dependencies.credential();
  const source: AuthSourceReport = {
    source: DEVIN_CREDENTIAL_SOURCE,
    path: resolution.path,
    status:
      resolution.status === "available"
        ? "available"
        : resolution.status === "missing"
          ? "missing"
          : resolution.status === "error"
            ? "error"
            : "invalid",
    ...(resolution.status === "available" || resolution.status === "missing"
      ? {}
      : { error: credentialError(resolution) }),
  };
  return { provider: "devin", sources: [source] };
}

class DevinFailure extends Error {
  constructor(
    code: string,
    readonly retryAfter?: string,
  ) {
    super(code);
  }
}

async function requestUserStatus(
  token: string,
  dependencies: Dependencies,
): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(dependencies.deadlineMs);
  let response: Response;
  try {
    response = await dependencies.fetch(DEVIN_USER_STATUS_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${token}-${token}`,
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/proto",
        Accept: "*/*",
      },
      body: encodeGetUserStatusRequest(token),
      credentials: "omit",
      redirect: "manual",
      signal,
    });
  } catch {
    throw new DevinFailure(
      signal.aborted ? "provider_timeout" : "network_unavailable",
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403)
      throw new DevinFailure("provider_auth_rejected");
    if (response.status === 429)
      throw new DevinFailure(
        "provider_rate_limited",
        retryAfterToIso(
          response.headers.get("retry-after"),
          dependencies.now(),
        ),
      );
    throw new DevinFailure("provider_request_rejected");
  }
  try {
    return await readBoundedBody(response);
  } catch (error) {
    if (error instanceof DevinFailure) throw error;
    throw new DevinFailure(
      signal.aborted ? "provider_timeout" : "network_unavailable",
    );
  }
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > RESPONSE_LIMIT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new DevinFailure("response_too_large");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DevinFailure("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * `GetUserStatusRequest { metadata (1) { ide_name (1), extension_version (2),
 * api_key (3), locale (4), os (5), ide_version (7), extension_name (12),
 * device_fingerprint (31) } }`. The fingerprint is random per request, so it
 * never links readings across runs.
 */
export function encodeGetUserStatusRequest(
  token: string,
): Uint8Array<ArrayBuffer> {
  const metadata = concat([
    bytesField(1, IDE_NAME),
    bytesField(2, IDE_VERSION),
    bytesField(3, token),
    bytesField(4, "en"),
    bytesField(5, clientOs()),
    bytesField(7, IDE_VERSION),
    bytesField(12, IDE_NAME),
    bytesField(31, randomBytes(DEVICE_FINGERPRINT_BYTES).toString("hex")),
  ]);
  return bytesField(1, metadata);
}

/**
 * Decode the fields quota-axi reports from a `GetUserStatusResponse`:
 * `user_status (1) { email (7), plan_status (13) { plan_info (1) { plan_name
 * (2) }, plan_start (2) { seconds (1) }, plan_end (3) { seconds (1) },
 * daily_quota_remaining_percent (14), weekly_quota_remaining_percent (15),
 * daily_quota_reset_at_unix (17), weekly_quota_reset_at_unix (18) },
 * model_catalog (33) { model (1) { promotion (19) { ends_at (2) { seconds (1)
 * } }, config (23) { family (23) }, display (30) { family_label (1) } } } }`.
 * Every other field is skipped unread.
 *
 * @throws when the bytes are not a well-formed protobuf message
 */
export function parseDevinUserStatus(data: Uint8Array): DevinUserStatus {
  const status: DevinUserStatus = { promotions: [] };
  for (const field of fields(data)) {
    if (field.number !== 1 || !field.bytes) continue;
    for (const user of fields(field.bytes)) {
      if (user.number === 7 && user.bytes) status.email = text(user.bytes);
      if (user.number === 13 && user.bytes) readPlanStatus(user.bytes, status);
      if (user.number === 33 && user.bytes)
        readCatalogPromotions(user.bytes, status.promotions);
    }
  }
  return status;
}

/**
 * The catalog marks a promotional model with a `promotion` message carrying
 * its end time; every variant of a family (`SWE-2 High`, `SWE-2 Max`, ...)
 * repeats it. One entry per family is kept, at the earliest end any variant
 * reports, so a promotion is never reported as running longer than the
 * service says for some variant of it.
 */
function readCatalogPromotions(
  data: Uint8Array,
  promotions: DevinPromotion[],
): void {
  for (const entry of fields(data)) {
    if (entry.number !== 1 || !entry.bytes) continue;
    let endsAt: string | undefined;
    let family: string | undefined;
    let label: string | undefined;
    for (const model of fields(entry.bytes)) {
      if (!model.bytes) continue;
      if (model.number === 19) {
        for (const promotion of fields(model.bytes)) {
          if (promotion.number === 2 && promotion.bytes)
            endsAt = timestampField(promotion.bytes);
        }
      } else if (model.number === 23) {
        for (const config of fields(model.bytes)) {
          if (config.number === 23 && config.bytes) family = text(config.bytes);
        }
      } else if (model.number === 30) {
        for (const display of fields(model.bytes)) {
          if (display.number === 1 && display.bytes)
            label = text(display.bytes);
        }
      }
    }
    if (!endsAt || !family || !/^[a-z0-9][a-z0-9.-]*$/.test(family)) continue;
    const existing = promotions.find((item) => item.family === family);
    if (!existing) {
      promotions.push({ family, label: label ?? family, endsAt });
    } else if (endsAt < existing.endsAt) {
      existing.endsAt = endsAt;
    }
  }
}

function readPlanStatus(data: Uint8Array, status: DevinUserStatus): void {
  for (const field of fields(data)) {
    if (field.bytes) {
      if (field.number === 1) {
        for (const info of fields(field.bytes)) {
          if (info.number === 2 && info.bytes) status.plan = text(info.bytes);
        }
      } else if (field.number === 2) {
        status.planStart = timestampField(field.bytes);
      } else if (field.number === 3) {
        status.planEnd = timestampField(field.bytes);
      }
      continue;
    }
    if (field.varint === undefined) continue;
    if (field.number === 14)
      status.dailyRemainingPercent = percentValue(field.varint);
    else if (field.number === 15)
      status.weeklyRemainingPercent = percentValue(field.varint);
    else if (field.number === 17) status.dailyResetsAt = epoch(field.varint);
    else if (field.number === 18) status.weeklyResetsAt = epoch(field.varint);
  }
}

/**
 * Turn a decoded plan status into quota windows.
 *
 * Protobuf (proto3) omits a numeric field whose value is zero, and the live
 * service does exactly that for a fully spent quota: the page read "Weekly
 * quota 100% used" while the response carried no weekly remaining field at
 * all. A missing remaining percentage therefore reads as zero remaining, but
 * only when the same window's reset timestamp is present - that proves the
 * plan status actually describes this window rather than being an empty or
 * foreign message. A value outside 0-100 is untrusted rather than clamped.
 *
 * The plan's subscription period is reported as a `plan_period` window that
 * carries only `startsAt`/`resetsAt` (its renewal date) and no percentage: it
 * is account context, not a quota, and bounds no scope.
 *
 * Each promoted model family becomes a `promo:<family>` model window whose
 * `resetsAt` is the promotion's end. It carries no percentage either: the
 * service reports no meter for promotional usage, only that it is promotional
 * until then.
 */
export function normalizeDevinStatus(
  status: DevinUserStatus,
): NormalizedDevinStatus {
  const windows: QuotaWindow[] = [];
  const untrustedWindowIds: string[] = [];
  const quotaWindows = [
    {
      id: "daily",
      label: "day",
      kind: "unknown" as const,
      windowSeconds: DAY_SECONDS,
      remaining: status.dailyRemainingPercent,
      resetsAt: status.dailyResetsAt,
    },
    {
      id: "weekly",
      label: "week",
      kind: "weekly" as const,
      windowSeconds: WEEK_SECONDS,
      remaining: status.weeklyRemainingPercent,
      resetsAt: status.weeklyResetsAt,
    },
  ];
  for (const { remaining, resetsAt, ...identity } of quotaWindows) {
    if (resetsAt === undefined) continue;
    const percentRemaining = remaining ?? 0;
    if (!Number.isInteger(percentRemaining) || percentRemaining > 100) {
      untrustedWindowIds.push(identity.id);
      continue;
    }
    windows.push({
      ...identity,
      percentUsed: 100 - percentRemaining,
      percentRemaining,
      resetsAt,
    });
  }
  if (windows.length > 0 && status.planEnd) {
    windows.push({
      id: "plan_period",
      label: "renewal",
      kind: "monthly",
      ...(status.planStart ? { startsAt: status.planStart } : {}),
      resetsAt: status.planEnd,
    });
  }
  if (windows.length > 0) {
    for (const promotion of status.promotions) {
      windows.push({
        id: `promo:${promotion.family}`,
        label: `${promotion.label} promo`,
        kind: "model",
        resetsAt: promotion.endsAt,
      });
    }
  }
  return {
    ...(status.plan ? { plan: status.plan } : {}),
    ...(status.email ? { email: status.email } : {}),
    windows,
    untrustedWindowIds,
  };
}

type ProtoField = { number: number; varint?: bigint; bytes?: Uint8Array };

function* fields(data: Uint8Array): Generator<ProtoField> {
  let offset = 0;
  while (offset < data.length) {
    const [tag, afterTag] = readVarint(data, offset);
    offset = afterTag;
    const number = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (number === 0) throw new DevinFailure("malformed_response");
    if (wireType === 0) {
      const [value, next] = readVarint(data, offset);
      offset = next;
      yield { number, varint: value };
    } else if (wireType === 2) {
      const [length, start] = readVarint(data, offset);
      const end = start + Number(length);
      if (length > BigInt(data.length) || end > data.length)
        throw new DevinFailure("malformed_response");
      offset = end;
      yield { number, bytes: data.subarray(start, end) };
    } else if (wireType === 1 || wireType === 5) {
      offset += wireType === 1 ? 8 : 4;
      if (offset > data.length) throw new DevinFailure("malformed_response");
    } else {
      throw new DevinFailure("malformed_response");
    }
  }
}

function readVarint(data: Uint8Array, start: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  for (let offset = start; offset < data.length && shift < 70n; offset++) {
    const byte = data[offset];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, offset + 1];
    shift += 7n;
  }
  throw new DevinFailure("malformed_response");
}

function bytesField(
  number: number,
  value: string | Uint8Array,
): Uint8Array<ArrayBuffer> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  return concat([
    encodeVarint(BigInt((number << 3) | 2)),
    encodeVarint(BigInt(bytes.length)),
    bytes,
  ]);
}

function encodeVarint(value: bigint): Uint8Array {
  const bytes: number[] = [];
  let remaining = value;
  do {
    const low = Number(remaining & 0x7fn);
    remaining >>= 7n;
    bytes.push(remaining > 0n ? low | 0x80 : low);
  } while (remaining > 0n);
  return Uint8Array.from(bytes);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function timestampField(data: Uint8Array): string | undefined {
  for (const field of fields(data)) {
    if (field.number === 1 && field.varint !== undefined)
      return epoch(field.varint);
  }
  return undefined;
}

/** Unix seconds; zero and out-of-range values carry no timestamp. */
function epoch(value: bigint): string | undefined {
  if (value <= 0n || value > 253_402_300_799n) return undefined;
  return new Date(Number(value) * 1000).toISOString();
}

/** A non-percentage is kept as NaN so normalization names it untrusted. */
function percentValue(value: bigint): number {
  return value <= 100n ? Number(value) : Number.NaN;
}

function text(bytes: Uint8Array): string | undefined {
  const value = new TextDecoder().decode(bytes).trim();
  return value || undefined;
}

function clientOs(): string {
  return process.platform === "win32" ? "windows" : process.platform;
}

/**
 * Devin session tokens are literal `devin-session-token$...` values, so the
 * shared `usableLiteralSecret` guard (which refuses `$` as an environment
 * reference) does not apply; this keeps its control-byte rule.
 */
function sessionToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  if (!token) return undefined;
  for (const character of token) {
    const code = character.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) return undefined;
  }
  return token;
}

function credentialError(
  resolution: Exclude<CredentialResolution, { status: "available" }>,
): string {
  switch (resolution.status) {
    case "missing":
      return "devin_credential_unavailable";
    case "invalid":
      return "devin_credential_invalid";
    case "ambiguous":
      return "devin_credential_ambiguous";
    case "error":
      return "credential_resolution_failed";
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
