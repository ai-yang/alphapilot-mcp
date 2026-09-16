import test from "node:test";
import assert from "node:assert/strict";
import { ApiClient, boundedJson } from "../dist/client.js";
test("reads retry twice; mutations do not; job retries retain original key and body", async () => {
  for (const [method, submit, expected] of [
    ["GET", false, 3],
    ["PATCH", false, 1],
    ["POST", true, 3],
  ]) {
    const calls = [];
    const api = new ApiClient(
      "http://localhost",
      "token",
      "test",
      2000,
      async (url, init) => {
        calls.push(init);
        throw new Error("dropped");
      },
    );
    await assert.rejects(
      api.request("/api/v1/jobs", {
        method,
        submit,
        body: method === "GET" ? undefined : { a: 1 },
        headers: submit ? { "Idempotency-Key": "original" } : {},
      }),
      (e) =>
        e.error.code ===
        (submit ? "SUBMISSION_UNCONFIRMED" : "UPSTREAM_UNAVAILABLE"),
    );
    assert.equal(calls.length, expected);
    if (submit)
      for (const call of calls) {
        assert.equal(call.headers["Idempotency-Key"], "original");
        assert.equal(call.body, '{"a":1}');
      }
  }
});
test("preserve backend errors and request IDs, no silent truncation", async () => {
  const api = new ApiClient(
    "http://localhost",
    "token",
    "test",
    1000,
    async () =>
      new Response(
        JSON.stringify({
          code: "VERSION_CONFLICT",
          message: "stale",
          request_id: "backend-id",
          details: { revision: 2 },
          retryable: false,
        }),
        { status: 412 },
      ),
  );
  await assert.rejects(
    api.request("/api/v1/factors/id", { method: "PATCH" }),
    (e) =>
      e.error.code === "VERSION_CONFLICT" &&
      e.error.request_id === "backend-id",
  );
  await assert.rejects(
    boundedJson(
      new Response(
        JSON.stringify({ text: "中".repeat(30000), next_cursor: 100 }),
      ),
      65536,
    ),
    (e) => e.error.code === "RESULT_TOO_LARGE",
  );
});
test("call cancellation aborts HTTP only, never sends business cancellation", async () => {
  const ac = new AbortController();
  const paths = [];
  const api = new ApiClient(
    "http://localhost",
    "token",
    "test",
    1000,
    async (url, init) => {
      paths.push(url);
      await new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(new Error()), {
          once: true,
        }),
      );
    },
  );
  const pending = api.request("/api/v1/jobs", {
    method: "POST",
    submit: true,
    headers: { "Idempotency-Key": "cancelled-call" },
    signal: ac.signal,
  });
  ac.abort();
  await assert.rejects(
    pending,
    (e) => e.error.code === "SUBMISSION_UNCONFIRMED",
  );
  assert.equal(paths.length, 1);
  assert.ok(!paths.some((p) => p.endsWith("/cancel")));
});
