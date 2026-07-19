import { test } from "node:test";
import assert from "node:assert/strict";
import { falRest, pingFal, FAL_REST_BASE } from "./fal.ts";
import type { FetchImpl } from "./fal.ts";

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

type ResponseSpec =
  | { status: number; body?: unknown; raw?: string | null }
  | { throws: string; name?: string };

/** Builds a fake fetch that records calls and replays scripted responses. */
function fakeFetch(responses: ResponseSpec[]): {
  fetchImpl: FetchImpl;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (spec && "throws" in spec) {
      const error = new Error(spec.throws);
      if (spec.name !== undefined) error.name = spec.name;
      return Promise.reject(error);
    }
    const status = spec?.status ?? 200;
    const body =
      spec && "raw" in spec ? spec.raw : spec && "body" in spec ? JSON.stringify(spec.body) : "";
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as FetchImpl;
  return { fetchImpl, calls };
}

test("falRest builds the URL with query and sends the Key auth header + a timeout signal", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { characters: [] } }]);
  const result = await falRest<{ characters: unknown[] }>("/assets/characters", {
    key: "abc123",
    query: { limit: 1, expand: undefined },
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, `${FAL_REST_BASE}/assets/characters?limit=1`);
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("authorization"), "Key abc123");
  assert.equal(call.init?.method, "GET");
  assert.ok(call.init?.signal instanceof AbortSignal, "a timeout signal is attached");
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, { characters: [] });
});

test("falRest sends JSON body and Content-Type for writes", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 201, body: { id: "x" } }]);
  await falRest("/assets/characters", {
    key: "k",
    method: "POST",
    body: { name: "Isolde" },
    headers: { "Idempotency-Key": "uuid-1" },
    fetchImpl,
  });
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.init?.method, "POST");
  assert.equal(call.init?.body, JSON.stringify({ name: "Isolde" }));
  const headers = new Headers(call.init?.headers);
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("idempotency-key"), "uuid-1");
});

test("falRest returns data:null for a non-JSON 2xx body (raw preserved)", async () => {
  const { fetchImpl } = fakeFetch([{ status: 200, raw: "OK" }]);
  const result = await falRest("/health", { key: "k", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.data, null);
  assert.equal(result.raw, "OK");
});

test("falRest returns data:null for an empty 204 body", async () => {
  const { fetchImpl } = fakeFetch([{ status: 204, raw: null }]);
  const result = await falRest("/assets/characters/x", { key: "k", method: "DELETE", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 204);
  assert.equal(result.data, null);
  assert.equal(result.raw, "");
});

test("pingFal returns ok on a 2xx from the first endpoint", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { characters: [] } }]);
  const res = await pingFal("k", { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

for (const status of [401, 403]) {
  test(`pingFal treats ${status} as a definitive rejection and stops probing`, async () => {
    const { fetchImpl, calls } = fakeFetch([{ status, body: { error: "bad" } }]);
    const res = await pingFal("k", { fetchImpl });
    assert.equal(res.ok, false);
    assert.equal(res.status, status);
    assert.equal(calls.length, 1, "should not fall through after a definitive rejection");
  });
}

test("pingFal falls through a non-auth error to the next endpoint", async () => {
  const { fetchImpl, calls } = fakeFetch([
    { status: 404, body: { error: "not found" } },
    { status: 200, body: { data: [] } },
  ]);
  const res = await pingFal("k", { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(res.endpoint, "/models?limit=1");
});

test("pingFal recovers when probe 1 throws but probe 2 succeeds", async () => {
  const { fetchImpl, calls } = fakeFetch([{ throws: "ECONNRESET" }, { status: 200, body: {} }]);
  const res = await pingFal("k", { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 2);
});

test("pingFal preserves an earlier HTTP status when a later probe throws", async () => {
  const { fetchImpl } = fakeFetch([
    { status: 500, body: { error: "boom" } },
    { throws: "ECONNRESET" },
  ]);
  const res = await pingFal("k", { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, 500, "the 500 from probe 1 is not discarded");
  assert.equal(res.endpoint, "/models?limit=1");
  assert.equal(res.error, "ECONNRESET");
});

test("pingFal surfaces a timeout as a distinct error", async () => {
  const { fetchImpl } = fakeFetch([
    { throws: "The operation timed out", name: "TimeoutError" },
    { throws: "The operation timed out", name: "TimeoutError" },
  ]);
  const res = await pingFal("k", { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.error, "timeout");
});

test("pingFal captures network errors without throwing", async () => {
  const { fetchImpl } = fakeFetch([{ throws: "ECONNREFUSED" }, { throws: "ECONNREFUSED" }]);
  const res = await pingFal("k", { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, null);
  assert.equal(res.error, "ECONNREFUSED");
});
