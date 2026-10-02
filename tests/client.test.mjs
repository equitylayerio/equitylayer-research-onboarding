import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { connect, endpointUrl, PROTOCOL, readRpc } from "../client/mcp.mjs";
import { parseArgs, run } from "../client/cli.mjs";
import { inspectCompatibility } from "../client/compatibility.mjs";

const researchTools = { tools: ["get_service_status", "begin_research", "resolve_company_tracker", "get_research_update", "finalize_research"].map(name => ({ name })) };

const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const message = (id, result) => ({ jsonrpc: "2.0", id, result });

test("endpoint accepts only the hosted service and explicit loopback MCP", () => {
  assert.equal(endpointUrl("https://equitylayer.io/mcp"), "https://equitylayer.io/mcp");
  assert.equal(endpointUrl("http://127.0.0.1:3100/mcp"), "http://127.0.0.1:3100/mcp");
  for (const url of ["http://equitylayer.io/mcp", "https://evil.test/mcp", "https://equitylayer.io:9000/mcp",
    "http://user:secret@localhost/mcp", "http://localhost/execute", "http://localhost/mcp?secret=x", "http://localhost/mcp#x"]) {
    assert.throws(() => endpointUrl(url));
  }
});

test("CLI rejects unknown commands, duplicate options, and missing public consent", () => {
  for (const args of [["buy"], ["constructor"], ["__proto__"], ["begin"], ["status", "--input", "x"],
    ["status", "--endpoint", "x", "--endpoint", "y"], ["status", "--wat"], ["status", "--out"],
    ["status", "--public-data"], ["finalize", "--input", "x", "--out", "y"]]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(parseArgs(["finalize", "--input", "x", "--out", "y", "--public-data"]).publicData, true);
});

test("help requires no network", async () => {
  let output = "";
  await run([], { connectClient: () => { throw new Error("Network forbidden"); }, stdout: value => { output += value; } });
  assert.match(output, /cannot pay, sign, trade/);
});

test("JSON response checks the request ID and remote errors", async () => {
  assert.deepEqual(await readRpc(json(message(2, { ok: true })), 2), { ok: true });
  await assert.rejects(readRpc(json(message(8, {})), 2), /does not match/);
  await assert.rejects(readRpc(json({ jsonrpc: "2.0", id: 2, error: { message: "private remote details" } }), 2), /request failed/);
  await assert.rejects(readRpc(new Response("html"), 2), /content type/);
  await assert.rejects(readRpc(new Response(null, { headers: { "content-type": "application/json" } }), 2), /empty/);
});

test("SSE handles split UTF-8, CRLF, notifications, and an open stream", async () => {
  const text = `: comment\r\n\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\r\n\r\ndata: ${JSON.stringify(message(2, { title: "研究" }))}\r\n\r\n`;
  const bytes = new TextEncoder().encode(text);
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); },
    cancel() { cancelled = true; },
  });
  assert.deepEqual(await readRpc(new Response(stream, { headers: { "content-type": "text/event-stream" } }), 2), { title: "研究" });
  assert.equal(cancelled, true);
});

test("response size and malformed response fail closed", async () => {
  await assert.rejects(readRpc(json({ value: "a".repeat(2_000_001) }), 1), /size limit/);
  await assert.rejects(readRpc(json({ jsonrpc: "2.0", id: 1 }), 1), /no result/);
  await assert.rejects(readRpc(new Response("data: not-json\n\n", { headers: { "content-type": "text/event-stream" } }), 1), SyntaxError);
});

function fakeServer(output = { harness_version: "1.1.0" }, options = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, ...init });
    assert.equal(init.redirect, "error");
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    const body = JSON.parse(init.body);
    if (body.method === "initialize") {
      const response = json(message(body.id, { protocolVersion: PROTOCOL, serverInfo: { name: "equitylayer" }, ...options.initialized }));
      response.headers.set("mcp-session-id", "test-session");
      return response;
    }
    assert.equal(init.headers["Mcp-Session-Id"], "test-session");
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return json(message(body.id, { tools: [{ name: "begin_research" }] }));
    return json(message(body.id, options.toolResponse ?? { structuredContent: output }));
  };
  return { calls, fetcher };
}

test("client initializes, lists tools, calls research, and closes its session", async () => {
  const server = fakeServer();
  const client = await connect("http://localhost:3100/mcp", server);
  assert.equal((await client.tools()).tools[0].name, "begin_research");
  assert.equal((await client.call("get_service_status")).harness_version, "1.1.0");
  await client.close();
  assert.equal(server.calls.at(-1).method, "DELETE");
  assert.equal(server.calls.some(call => "authorization" in call.headers), false);
});

test("client refuses payment and execution tools before transmission", async () => {
  const server = fakeServer();
  const client = await connect("http://localhost:3100/mcp", server);
  const initialCalls = server.calls.length;
  for (const name of ["buy_research", "get_trading_quote", "execute", "register_research_agent"]) {
    await assert.rejects(client.call(name), /does not permit/);
  }
  assert.equal(server.calls.length, initialCalls);
  await client.close();
});

test("client rejects another server or protocol", async () => {
  for (const initialized of [{ protocolVersion: "unsupported" }, { serverInfo: { name: "other" } }]) {
    await assert.rejects(connect("http://localhost/mcp", fakeServer({}, { initialized })), /compatible/);
  }
});

test("tool errors and failed validation do not become results", async () => {
  for (const toolResponse of [{ isError: true }, { structuredContent: { ok: false } }, { content: [] }]) {
    const client = await connect("http://localhost/mcp", fakeServer({}, { toolResponse }));
    await assert.rejects(client.call("finalize_research"), /rejected|invalid/);
    await client.close();
  }
});

test("connection and HTTP failures do not retry or expose the response body", async () => {
  let count = 0;
  await assert.rejects(connect("http://localhost/mcp", { fetcher: async () => { count++; throw new Error("secret"); } }), /connection failed/);
  assert.equal(count, 1);
  await assert.rejects(connect("http://localhost/mcp", { fetcher: async () => new Response("secret", { status: 402 }) }), /HTTP 402/);
});

test("finalize saves only the importable result and never accepts a baseline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "equitylayer-client-test-"));
  try {
    const input = join(dir, "input.json");
    const output = join(dir, "result.json");
    await writeFile(input, JSON.stringify({ handle: "public-test-handle" }));
    const result = { result_id: "test-id", result_state: "SOURCE_NEEDED" };
    let closed = 0;
    let summary;
    const connectClient = async () => ({
      tools: async () => researchTools,
      call: async (name, args) => { assert.equal(name, "finalize_research"); assert.equal(args.handle, "public-test-handle");
        return { ok: true, result_file: result, warnings: ["Source required"] }; },
      close: async () => { closed++; },
    });
    const args = ["finalize", "--input", input, "--public-data", "--out", output];
    await run(args, { connectClient, stdout: value => { summary = JSON.parse(value); } });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
    assert.equal(summary.accepted_baseline, false);
    assert.deepEqual(summary.warnings, ["Source required"]);
    assert.equal((await stat(output)).mode & 0o777, 0o600);
    await assert.rejects(run(args, { connectClient }), { code: "EEXIST" });
    const link = join(dir, "symlink.json");
    await symlink(output, link);
    await assert.rejects(run([...args.slice(0, -1), link], { connectClient }), { code: "EEXIST" });
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), result);
    assert.equal(closed, 3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid input is rejected before a connection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "equitylayer-client-test-"));
  try {
    const file = join(dir, "bad.json");
    for (const content of ["[]", "null", "broken", JSON.stringify({ large: "x".repeat(1_000_001) })]) {
      await writeFile(file, content);
      await assert.rejects(run(["begin", "--input", file], { connectClient: async () => assert.fail("No network expected") }));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a server without session IDs supports text-only tool responses", async () => {
  const client = await connect("http://localhost/mcp", { fetcher: async (_url, init) => {
    assert.equal(init.headers["Mcp-Session-Id"], undefined);
    const body = JSON.parse(init.body);
    if (body.method === "initialize") return json(message(body.id, { protocolVersion: PROTOCOL, serverInfo: { name: "equitylayer" } }));
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    return json(message(body.id, { content: [{ type: "text", text: JSON.stringify({ ok: true, source: "test" }) }] }));
  } });
  assert.equal((await client.call("get_service_status")).source, "test");
  await client.close();
});

test("invalid session IDs fail before a tool call", async () => {
  for (const session of ["has space", "x".repeat(1025)]) {
    await assert.rejects(connect("http://localhost/mcp", { fetcher: async () => {
      const response = json(message(1, { protocolVersion: PROTOCOL, serverInfo: { name: "equitylayer" } }));
      response.headers.set("mcp-session-id", session);
      return response;
    } }), /session identifier/);
  }
});

test("a body that stays open is aborted by the request deadline", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": waiting\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(connect(`http://127.0.0.1:${server.address().port}/mcp`, { timeoutMs: 100 }), /abort|timeout|timed out/i);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("a missing finalized file creates no output and closes the client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "equitylayer-client-test-"));
  try {
    const input = join(dir, "input.json");
    const output = join(dir, "result.json");
    await writeFile(input, "{}");
    let closed = false;
    await assert.rejects(run(["finalize", "--input", input, "--public-data", "--out", output], {
      connectClient: async () => ({ tools: async () => researchTools, call: async () => ({ ok: true }), close: async () => { closed = true; } }),
    }), /did not return/);
    assert.equal(closed, true);
    await assert.rejects(stat(output), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("doctor distinguishes tool discovery from verified research and payment", async () => {
  const report = inspectCompatibility("http://localhost/mcp", researchTools);
  assert.equal(report.research_tools_available, true);
  assert.equal(report.instrument_mapping_available, false);
  assert.equal(report.research_execution_verified, false);
  assert.equal(report.payment_verified, false);
  for (const tools of [null, {}, { tools: [null] }]) assert.throws(() => inspectCompatibility("x", tools));
  assert.equal(inspectCompatibility("x", { tools: [...researchTools.tools, { name: "resolve_trading_instrument" }] }).instrument_mapping_available, true);
});

test("doctor reports missing tools without a tool call and returns a nonzero status", async () => {
  for (const listing of [researchTools, { tools: [{ name: "get_service_status" }] }]) {
    let closed = false;
    let output;
    const result = await run(["doctor"], {
      connectClient: async () => ({ tools: async () => listing, call: () => assert.fail("Discovery must not run a tool"), close: async () => { closed = true; } }),
      stdout: value => { output = JSON.parse(value); },
    });
    assert.equal(result.exitCode, listing === researchTools ? 0 : 2);
    assert.equal(closed, true);
    assert.equal(output.check, "tool_discovery_only");
    if (listing !== researchTools) assert.ok(output.missing_research_tools.includes("finalize_research"));
  }
});

test("missing research tools block draft transmission and file creation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "equitylayer-preflight-test-"));
  try {
    const input = join(dir, "draft.json");
    const output = join(dir, "result.json");
    await writeFile(input, "{}");
    for (const command of ["begin", "finalize", "instrument"]) {
      let closed = false;
      await assert.rejects(run([command, "--input", input, "--out", output, ...(command === "finalize" ? ["--public-data"] : [])], {
        connectClient: async () => ({ tools: async () => ({ tools: [] }), call: () => assert.fail("Do not transmit input"), close: async () => { closed = true; } }),
      }), /lacks required tools/);
      assert.equal(closed, true);
      await assert.rejects(stat(output), { code: "ENOENT" });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("tool discovery follows pagination and preserves later tools", async () => {
  const server = fakeServer();
  const cursors = [];
  const client = await connect("http://localhost/mcp", { fetcher: async (url, init) => {
    const body = init.body && JSON.parse(init.body);
    if (body?.method === "tools/list") {
      cursors.push(body.params?.cursor);
      return json(message(body.id, body.params?.cursor ? { tools: [{ name: "finalize_research" }] }
        : { tools: [{ name: "begin_research" }], nextCursor: "second" }));
    }
    return server.fetcher(url, init);
  } });
  assert.deepEqual((await client.tools()).tools.map(tool => tool.name), ["begin_research", "finalize_research"]);
  assert.deepEqual(cursors, [undefined, "second"]);
  await client.close();
});

test("tool discovery rejects malformed, cyclic, and excessive pagination", async () => {
  for (const mode of ["malformed", "invalid-cursor", "cycle", "limit"]) {
    const server = fakeServer();
    let page = 0;
    const client = await connect("http://localhost/mcp", { fetcher: async (url, init) => {
      const body = init.body && JSON.parse(init.body);
      if (body?.method !== "tools/list") return server.fetcher(url, init);
      page++;
      return json(message(body.id, mode === "malformed" ? { tools: [null] } : { tools: [],
        nextCursor: mode === "invalid-cursor" ? 42 : mode === "cycle" ? "same" : `page-${page}` }));
    } });
    await assert.rejects(client.tools(), /invalid|page limit/);
    assert.ok(page <= 20);
    await client.close();
  }
});
