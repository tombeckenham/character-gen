import { ApiError, createFalClient } from "@fal-ai/client";

export const FAL_REST_BASE = "https://api.fal.ai/v1";

/** Default per-request timeout for REST calls. */
export const FAL_REST_TIMEOUT_MS = 10_000;

export type FalClient = ReturnType<typeof createFalClient>;

/** Builds a fal client configured with the given credentials. */
export function makeFalClient(key: string): FalClient {
  return createFalClient({ credentials: key });
}

export type FetchImpl = typeof fetch;

/** Renders a fal `ApiError` body (validation `detail`, string, or JSON) to a
 * single-line detail string, or null when there is nothing useful to add. */
function formatFalErrorBody(body: unknown): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body.length > 0 ? body : null;
  if (typeof body === "object") {
    const detail = (body as { detail?: unknown }).detail;
    if (Array.isArray(detail)) {
      const parts = detail.map((entry) => {
        if (entry !== null && typeof entry === "object") {
          const loc = (entry as { loc?: unknown }).loc;
          const msg = (entry as { msg?: unknown }).msg;
          const where = Array.isArray(loc) ? loc.join(".") : "";
          return where ? `${where}: ${String(msg)}` : String(msg);
        }
        return String(entry);
      });
      if (parts.length > 0) return parts.join("; ");
    }
    try {
      return JSON.stringify(body);
    } catch {
      return null;
    }
  }
  return String(body);
}

/**
 * Turns any thrown value into a readable message. For a fal `ApiError` it folds
 * in the HTTP status and the response body detail, so a 422 surfaces the failing
 * field instead of a bare "Unprocessable Entity".
 */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const detail = formatFalErrorBody(error.body);
    const base = `${error.message} (${error.status})`;
    return detail ? `${base}: ${detail}` : base;
  }
  return error instanceof Error ? error.message : String(error);
}

/** True for an abort/timeout rejection (`AbortSignal.timeout` → TimeoutError). */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

export interface FalRestOptions {
  key: string;
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  baseUrl?: string;
  /** Injectable fetch so callers/tests can avoid the network. */
  fetchImpl?: FetchImpl;
  /** Per-request timeout in ms (default FAL_REST_TIMEOUT_MS). */
  timeoutMs?: number;
  /** Overrides the timeout signal entirely (tests/cancellation). */
  signal?: AbortSignal;
}

export interface FalRestResult<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  raw: string;
}

function buildUrl(base: string, path: string, query?: FalRestOptions["query"]): string {
  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * Small typed helper over the fal platform REST API. Sends
 * `Authorization: Key <key>` and JSON. Never throws on HTTP status — inspect
 * `result.ok` / `result.status`. Network failures and timeouts reject (a timeout
 * rejects with a TimeoutError — see `isTimeoutError`). A non-JSON 2xx body yields
 * `data: null` with the text still in `raw`.
 */
export async function falRest<T = unknown>(
  path: string,
  options: FalRestOptions,
): Promise<FalRestResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = buildUrl(options.baseUrl ?? FAL_REST_BASE, path, options.query);
  const headers: Record<string, string> = {
    Authorization: `Key ${options.key}`,
    ...options.headers,
  };
  const hasBody = options.body !== undefined;
  if (hasBody) headers["Content-Type"] = "application/json";

  const signal = options.signal ?? AbortSignal.timeout(options.timeoutMs ?? FAL_REST_TIMEOUT_MS);
  const response = await fetchImpl(url, {
    method: options.method ?? "GET",
    headers,
    signal,
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
  });

  const raw = await response.text();
  let data: T | null = null;
  if (raw.length > 0) {
    try {
      data = JSON.parse(raw) as T;
    } catch {
      data = null;
    }
  }
  return { ok: response.ok, status: response.status, data, raw };
}

export interface PingResult {
  /** True when a probe returned 2xx — the key is valid. */
  ok: boolean;
  /** Most recent HTTP status observed across probes, or null if none connected. */
  status: number | null;
  /** The probe URL that produced the final verdict. */
  endpoint: string | null;
  /** Failure detail when it wasn't an HTTP status: "timeout" or the error text. */
  error?: string;
}

/**
 * Default doctor ping endpoints. `assets/characters` leads because it is the
 * surface this project publishes to; `models` is a fallback in case the assets
 * surface is unavailable.
 */
export const PING_ENDPOINTS = ["/assets/characters?limit=1", "/models?limit=1"] as const;

export interface PingOptions {
  fetchImpl?: FetchImpl;
  baseUrl?: string;
  endpoints?: readonly string[];
  timeoutMs?: number;
}

/**
 * Validates a key by probing the fal REST API. A 2xx from any probe means the
 * key is valid; a 401/403 is a definitive rejection (no further probes). Other
 * statuses fall through to the next probe. A probe that throws (network/timeout)
 * preserves any HTTP status already observed rather than discarding it.
 */
export async function pingFal(key: string, options: PingOptions = {}): Promise<PingResult> {
  const endpoints = options.endpoints ?? PING_ENDPOINTS;
  let last: PingResult = { ok: false, status: null, endpoint: null };

  for (const path of endpoints) {
    try {
      // Probes are intentionally sequential: a 2xx or a 401/403 ends the loop
      // early, so parallelizing would waste requests and lose the ordering.
      // oxlint-disable-next-line no-await-in-loop
      const res = await falRest(path, {
        key,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      if (res.ok) return { ok: true, status: res.status, endpoint: path };
      last = { ok: false, status: res.status, endpoint: path };
      if (res.status === 401 || res.status === 403) return last;
    } catch (err) {
      last = {
        ok: false,
        // Preserve an HTTP status already seen on an earlier probe.
        status: last.status,
        endpoint: path,
        error: isTimeoutError(err) ? "timeout" : err instanceof Error ? err.message : String(err),
      };
    }
  }
  return last;
}
