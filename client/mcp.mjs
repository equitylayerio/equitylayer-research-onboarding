// This client supports EquityLayer's bounded Streamable HTTP request flow.
export const PROTOCOL = "2025-03-26";
const MAX_BYTES = 2_000_000;
const TOOL_NAMES = new Set([
  "get_service_status", "begin_research", "finalize_research", "resolve_trading_instrument", "get_instrument_evidence",
  "resolve_company_tracker", "get_research_update", "discover_theses",
]);

export function endpointUrl(value) {
  const url = new URL(value);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const hosted = url.protocol === "https:" && url.hostname === "equitylayer.io" && !url.port;
  if ((!local && !hosted) || url.pathname !== "/mcp" || url.username || url.password || url.search || url.hash) {
    throw new Error("Use https://equitylayer.io/mcp or a loopback HTTP /mcp endpoint.");
  }
  return url.href;
}

function rpcResult(message, id) {
  if (message?.jsonrpc !== "2.0" || message.id !== id) return undefined;
  if (message.error) throw new Error("The MCP request failed. Check the endpoint and input schema.");
  if (!("result" in message)) throw new Error("The MCP response has no result.");
  return { value: message.result };
}

export async function readRpc(response, id) {
  if (!response.body) throw new Error("The MCP response is empty.");
  const contentType = response.headers.get("content-type") ?? "";
  const sse = contentType.includes("text/event-stream");
  if (!sse && !contentType.includes("application/json")) throw new Error("The MCP content type is not supported.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) throw new Error("The MCP response exceeds the size limit.");
      buffer += decoder.decode(value, { stream: true });
      if (!sse) continue;
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = event.split(/\r?\n/).filter(line => line.startsWith("data:"))
          .map(line => line.slice(5).replace(/^ /, "")).join("\n");
        if (!data) continue;
        const result = rpcResult(JSON.parse(data), id);
        if (result) return result.value;
      }
    }
    buffer += decoder.decode();
    const result = !sse && rpcResult(JSON.parse(buffer), id);
    if (!result) throw new Error("The MCP response does not match the request.");
    return result.value;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function connect(endpoint, { fetcher = fetch, timeoutMs = 15_000 } = {}) {
  const url = endpointUrl(endpoint);
  let requestId = 0;
  let session;
  let protocol = PROTOCOL;
  async function request(method, params, notification = false) {
    const id = notification ? undefined : ++requestId;
    let response;
    try {
      response = await fetcher(url, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "application/json, text/event-stream", "content-type": "application/json",
          "MCP-Protocol-Version": protocol,
          ...(session ? { "Mcp-Session-Id": session } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) }),
      });
    } catch { throw new Error("The MCP connection failed or timed out. No payment or order was sent."); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`The MCP endpoint returned HTTP ${response.status}. No retry was sent.`);
    }
    if (method === "initialize") {
      session = response.headers.get("mcp-session-id") ?? undefined;
      if (session && (!/^[\x21-\x7e]+$/.test(session) || session.length > 1024)) throw new Error("The MCP session identifier is invalid.");
    }
    if (notification) { await response.body?.cancel(); return; }
    return readRpc(response, id);
  }
  const initialized = await request("initialize", {
    protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "equitylayer-research-client", version: "0.1.0" },
  });
  if (initialized?.protocolVersion !== PROTOCOL || initialized?.serverInfo?.name !== "equitylayer") {
    throw new Error("The endpoint is not a compatible EquityLayer server.");
  }
  protocol = initialized.protocolVersion;
  await request("notifications/initialized", undefined, true);
  return {
    async tools() {
      const tools = [];
      const cursors = new Set();
      let cursor;
      for (let page = 0; page < 20; page++) {
        const result = await request("tools/list", cursor ? { cursor } : undefined);
        if (!Array.isArray(result?.tools) || result.tools.some(tool => typeof tool?.name !== "string")) {
          throw new Error("The server returned an invalid tool list.");
        }
        tools.push(...result.tools);
        if (result.nextCursor === undefined) return { tools };
        cursor = result.nextCursor;
        if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) {
          throw new Error("The server returned an invalid pagination cursor.");
        }
        cursors.add(cursor);
      }
      throw new Error("The tool list exceeds the page limit.");
    },
    async call(name, args = {}) {
      if (!TOOL_NAMES.has(name)) throw new Error("This client does not permit that tool.");
      const response = await request("tools/call", { name, arguments: args });
      if (response?.isError) throw new Error("The research tool rejected the request. Check its schema and coverage.");
      const output = response?.structuredContent ?? JSON.parse(response?.content?.find(item => item.type === "text")?.text ?? "null");
      if (!output || typeof output !== "object" || output.ok === false) throw new Error("The research result is invalid. No result file was accepted.");
      return output;
    },
    async close() {
      if (!session) return;
      try {
        const response = await fetcher(url, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
          headers: { "Mcp-Session-Id": session, "MCP-Protocol-Version": protocol } });
        await response.body?.cancel();
      } catch { /* Session cleanup must not replace the research result. */ }
    },
  };
}
