import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPool, poolFailureError } from "./common.ts";

/** A deferred promise plus its resolver, for controlling completion order. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("mapPool caps in-flight workers at the concurrency limit", async () => {
  const gates = Array.from({ length: 6 }, () => deferred());
  let inFlight = 0;
  let peak = 0;

  const run = mapPool([0, 1, 2, 3, 4, 5], 2, async (item) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await gates[item]?.promise;
    inFlight -= 1;
    return item * 10;
  });

  // Release the gates newest-first so completion order differs from input order.
  for (let i = gates.length - 1; i >= 0; i -= 1) {
    gates[i]?.resolve();
    // Yield so a freed worker can claim the next item before the next release.
    // oxlint-disable-next-line no-await-in-loop
    await Promise.resolve();
  }
  const { results, failures } = await run;

  assert.equal(peak, 2, "never more than 2 workers ran at once");
  assert.deepEqual(results, [0, 10, 20, 30, 40, 50], "results stay in input order");
  assert.equal(failures.length, 0);
});

test("mapPool collects every failure without cancelling siblings", async () => {
  const { results, failures } = await mapPool([0, 1, 2, 3], 4, (item) => {
    if (item % 2 === 1) return Promise.reject(new Error(`boom ${item}`));
    return Promise.resolve(item);
  });

  // Successes keep their input index; failed items leave holes (callers filter).
  assert.equal(results[0], 0);
  assert.equal(results[2], 2);
  assert.deepEqual(
    results.filter((value) => value !== undefined),
    [0, 2],
  );
  assert.deepEqual(
    failures.map((failure) => failure.index).toSorted((a, b) => a - b),
    [1, 3],
  );

  const error = poolFailureError("step", "items", 4, failures, (index) => `item ${index}`);
  assert.match(error.message, /step: 2 of 4 items failed — item 1 \(boom 1\), item 3 \(boom 3\)/u);
});
