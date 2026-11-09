import test from "node:test";
import assert from "node:assert/strict";
import { connect, readRpc, PROTOCOL } from "../client/mcp.mjs";

const json = (id, result) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
  headers: { "content-type": "application/json" },
});
const initialized = (id) => json(id, { protocolVersion: PROTOCOL, serverInfo: { name: "equitylayer" } });

test("unsupported content types cancel their bodies without waiting for cleanup", { timeout: 500 }, async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), {
    headers: { "content-type": "application/octet-stream" },
  });
  await assert.rejects(readRpc(response, 1), /content type/);
  assert.equal(cancelled, true);
});

test("a matching result does not wait for transport cancellation", { timeout: 500 }, async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n')); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }), { headers: { "content-type": "text/event-stream" } });
  assert.deepEqual(await readRpc(response, 1), { ok: true });
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("request deadline bounds body reads when the transport ignores abort", { timeout: 500 }, async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } }), {
    headers: { "content-type": "text/event-stream" },
  });
  await assert.rejects(connect("http://localhost/mcp", { timeoutMs: 20, fetcher: async () => response }), /timed out/i);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("request deadline bounds a fetcher that never returns headers", { timeout: 500 }, async () => {
  await assert.rejects(connect("http://localhost/mcp", { timeoutMs: 20, fetcher: () => new Promise(() => {}) }), /timed out/i);
});

test("late headers after deadline are cancelled without retry", { timeout: 500 }, async () => {
  let resolveFetch, calls = 0, cancelled = false;
  await assert.rejects(connect("http://localhost/mcp", { timeoutMs: 20, fetcher: () => {
    calls++; return new Promise(resolve => { resolveFetch = resolve; });
  } }), /timed out/i);
  resolveFetch(new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { "content-type": "application/json" },
  }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("HTTP failure and notification cleanup cannot prevent completion", { timeout: 500 }, async () => {
  const stuck = (status) => new Response(new ReadableStream({ cancel: () => new Promise(() => {}) }), { status });
  await assert.rejects(connect("http://localhost/mcp", { timeoutMs: 20, fetcher: async () => stuck(503) }), /HTTP 503/);
  const client = await connect("http://localhost/mcp", { timeoutMs: 20, fetcher: async (_url, init) => {
    const body = JSON.parse(init.body);
    return body.method === "initialize" ? initialized(body.id) : stuck(202);
  } });
  await client.close();
});

test("session close is bounded when DELETE ignores abort", { timeout: 500 }, async () => {
  let deletes = 0;
  const client = await connect("http://localhost/mcp", { timeoutMs: 20, fetcher: async (_url, init) => {
    if (init.method === "DELETE") { deletes++; return new Promise(() => {}); }
    const body = JSON.parse(init.body);
    if (body.method === "initialize") {
      const response = initialized(body.id); response.headers.set("mcp-session-id", "test-session"); return response;
    }
    return new Response(null, { status: 202 });
  } });
  await client.close();
  assert.equal(deletes, 1);
});

test("invalid request deadlines fail before dispatch", async () => {
  for (const timeoutMs of [0, -1, NaN, Infinity, 0.5, 3_600_001]) {
    await assert.rejects(connect("http://localhost/mcp", { timeoutMs, fetcher: () => assert.fail("No dispatch expected") }), /deadline/i);
  }
});

test("invalid late responses do not create unhandled cleanup failures", { timeout: 1000 }, async () => {
  const throwing = Object.defineProperty({}, "body", { get() { throw new Error("REMOTE_PRIVATE_VALUE"); } });
  for (const late of [null, throwing]) {
    let release;
    await assert.rejects(connect("http://localhost/mcp", { timeoutMs: 20, fetcher: () => new Promise(resolve => { release = resolve; }) }), /timed out/);
    release(late);
    await new Promise(resolve => setImmediate(resolve));
    const client = await connect("http://localhost/mcp", { timeoutMs: 20, fetcher: async (_url, init) => {
      if (init.method === "DELETE") return new Promise(resolve => { release = resolve; });
      const body = JSON.parse(init.body);
      if (body.method === "initialize") {
        const response = initialized(body.id); response.headers.set("mcp-session-id", "test-session"); return response;
      }
      return new Response(null, { status: 202 });
    } });
    await client.close();
    release(late);
    await new Promise(resolve => setImmediate(resolve));
  }
});
