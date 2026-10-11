import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/server/index.js";

function makeRequest(path, method = "GET") {
  return new Request(`https://coding-sessions.example${path}`, { method });
}

test("health endpoint returns a successful JSON response", async () => {
  const response = await worker.fetch(makeRequest("/api/health"), {});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "coding-sessions-portal-api",
    stage: "google-authentication"
  });
});

test("health endpoint rejects methods other than GET", async () => {
  const response = await worker.fetch(makeRequest("/api/health", "POST"), {});
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
});

test("unknown API routes return JSON 404", async () => {
  const response = await worker.fetch(makeRequest("/api/not-built-yet"), {});
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Not found" });
});

test("non-API requests are passed to the configured static asset binding", async () => {
  const assets = {
    fetch: async request => new Response(`asset:${new URL(request.url).pathname}`)
  };
  const response = await worker.fetch(makeRequest("/"), { ASSETS: assets });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "asset:/");
});

test("missing static asset binding fails safely", async () => {
  const response = await worker.fetch(makeRequest("/"), {});
  assert.equal(response.status, 503);
});




test("account endpoint returns a signed-out state without a database", async () => {
  const response = await worker.fetch(makeRequest("/api/auth/me"), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { user: null });
});

test("Google sign-in fails safely when configuration is missing", async () => {
  const response = await worker.fetch(makeRequest("/api/auth/google"), {});
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Google sign-in is not configured"
  });
});

test("Google callback fails safely when configuration is missing", async () => {
  const response = await worker.fetch(
    makeRequest("/api/auth/google/callback"),
    {}
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Google sign-in is not configured"
  });
});

test("logout rejects methods other than POST", async () => {
  const response = await worker.fetch(makeRequest("/api/auth/logout"), {});
  assert.equal(response.status, 405);
  assert.deepEqual(await response.json(), { error: "Method not allowed" });
});
