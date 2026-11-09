import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type ApprovalDetails = {
  toolName: string;
  endpoint: string;
  priceAtomic: string;
  asset: string;
  network: string;
  payTo: string;
  capabilityVersion: string;
  sessionSpendAtomic: string;
};

export type ApprovalRequest = {
  url: string;
  waitForDecision(): Promise<boolean>;
  close(): Promise<void>;
};

function html(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    "\"": "&quot;",
  })[character] ?? character);
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function renderApprovalPage(details: ApprovalDetails): string {
  const rows = [
    ["Tool", details.toolName],
    ["Endpoint", details.endpoint],
    ["Price", `${details.priceAtomic} atomic units`],
    ["Asset", details.asset],
    ["Network", details.network],
    ["Payee", details.payTo],
    ["Capability version", details.capabilityVersion],
    ["Session spend", `${details.sessionSpendAtomic} atomic units`],
  ].map(([label, value]) => `<dt>${html(label)}</dt><dd>${html(value)}</dd>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Approve local Devnet payment</title></head><body><main><h1>Approve one local Devnet payment</h1><p>This action signs one fixed P1a research request. No investment action is included.</p><dl>${rows}</dl><form method="post"><button type="submit" name="decision" value="approve">Approve one payment</button><button type="submit" name="decision" value="reject">Reject</button></form></main></body></html>`;
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > 1_024) throw new Error("approval_body_too_large");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Start a one-time approval page. It always binds to IPv4 loopback on a random port. */
export async function createApprovalRequest(
  details: ApprovalDetails,
  options: { timeoutMs?: number } = {},
): Promise<ApprovalRequest> {
  const token = randomBytes(32).toString("hex");
  const path = `/approval/${token}`;
  let decide: (approved: boolean) => void = () => undefined;
  let closed = false;
  const decision = new Promise<boolean>((resolve) => {
    decide = resolve;
  });
  const finish = async (approved: boolean) => {
    if (closed) return;
    closed = true;
    decide(approved);
    await closeServer(server);
  };
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    if (!isLoopbackRequest(request) || request.url !== path) {
      response.writeHead(404, { "cache-control": "no-store" }).end();
      return;
    }
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(renderApprovalPage(details));
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { "cache-control": "no-store" }).end();
      return;
    }
    try {
      const body = await requestBody(request);
      const approved = new URLSearchParams(body).get("decision") === "approve";
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end(approved ? "Approved. You can return to the agent." : "Rejected. You can return to the agent.");
      await finish(approved);
    } catch {
      response.writeHead(400, { "cache-control": "no-store" }).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("approval_listener_unavailable");
  }
  const timer = setTimeout(() => void finish(false), options.timeoutMs ?? 60_000);
  if (typeof timer === "object" && "unref" in timer) timer.unref();

  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    async waitForDecision() {
      try {
        return await decision;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      clearTimeout(timer);
      await finish(false);
    },
  };
}
