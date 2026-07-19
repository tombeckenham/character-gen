import { test } from "node:test";
import assert from "node:assert/strict";
import { falRest, pingFal, FAL_REST_BASE } from "./fal.ts";
import type { FetchImpl } from "./fal.ts";

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

/** Builds a fake fetch that records calls and replays scripted responses. */
function fakeFetch(responses: Array<{ status: number; body?: unknown } | { throws: string }>): {
  fetchImpl: FetchImpl;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  let i = 0;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const spec = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (spec && "throws" in spec) return Promise.reject(new Error(spec.throws));
    const status = spec?.status ?? 200;
    const body = spec && "body" in spec ? JSON.stringify(spec.body) : "";
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as FetchImpl;
  return { fetchImpl, calls };
}

test("falRest builds the URL with query and sends the Key auth header", async () => {
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

test("pingFal returns ok on a 2xx from the first endpoint", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 200, body: { characters: [] } }]);
  const res = await pingFal("k", { fetchImpl });
  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
});

test("pingFal treats 401 as a definitive rejection and stops probing", async () => {
  const { fetchImpl, calls } = fakeFetch([{ status: 401, body: { error: "bad" } }]);
  const res = await pingFal("k", { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 1, "should not fall through after a 401");
});

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

test("pingFal captures network errors without throwing", async () => {
  const { fetchImpl } = fakeFetch([{ throws: "ECONNREFUSED" }, { throws: "ECONNREFUSED" }]);
  const res = await pingFal("k", { fetchImpl });
  assert.equal(res.ok, false);
  assert.equal(res.status, null);
  assert.equal(res.error, "ECONNREFUSED");
});
