# Executable research client

This client uses the existing EquityLayer research harness. It is not a separate agent or model.
It requires Node.js 22 or later. It has no package dependencies.

## Start

1. Run `npm test`.
2. Run `npm run research -- status`.
3. Run `npm run research -- tools` to read the server's tool schemas.
4. Run `npm run research -- begin --input examples/ai-compute-scope.json --out plan.local.json`.
5. Give `plan.local.json` to your existing AI. Ask it to apply the research plan and fill the returned `agent_fields_schema`.

Use `discover` to inspect the server's public research entry points.
Use `company --input request.json` for each returned company check.
Use `update --input request.json` only when the plan supplies that request for covered companies.
Copy the returned tool arguments into each request file. Do not invent coverage or call a paid endpoint automatically.

The example covers a cross-market research scope, not verified coverage of all four companies.
Its retained day is fixed for reproducibility. Do not present it as current research.
Use your dashboard's exported scope to associate later results with that dashboard's watch ID and revision.
The example watch ID is illustrative. It does not identify your dashboard watch.

For a local EquityLayer server, append `--endpoint http://127.0.0.1:3100/mcp` to each command.
The public server can run an older release. Missing tools require a server update, not a payment or account.

## Return a result to the local dashboard

Copy the handle, scope, and retained day from the plan into `public-draft.local.json`.
Add the public `agent_fields` that your AI produced. Use the exact returned schema.
Review this file before transmission. Remove private notes, positions, credentials, and account details.

Run:

```sh
npm run research -- finalize --input public-draft.local.json --public-data --out result.local.json
```

The command sends the file to the selected server. The `--public-data` flag records your explicit choice to send public research.
It does not detect confidential content for you.
Successful validation saves the `result_file`, not the MCP wrapper. Import it through your dashboard's research-result control.
Review the sources before you accept the result. Validation does not prove that the evidence supports a conclusion.
The client cannot accept a baseline or schedule monitoring. Existing output files are never overwritten.

## Research, payment, and trading

The client can read a company-to-token mapping with `instrument` and an input such as `{"symbol":"NVDA"}`.
It cannot submit a quote, payment, signature, or order. It has no wallet or authorization-header options.
It does not install tools or execute instructions contained in server responses.

Solana x402 research purchase uses the separate [buyer bridge](../tools/x402-mcp-bridge/README.md). A real payment proof remains an unfinished release gate.
An instrument mapping is not a purchase receipt.
This repository does not yet contain the complete self-hosted dashboard or seller backend.
It is a runnable public client for those services, not a claim that the hackathon release is complete.

## Transport boundary

The client supports EquityLayer's JSON and SSE responses over Streamable HTTP.
It initializes the session, limits response size, blocks redirects, and enforces timeouts.
It does not implement generic MCP server requests, batch responses, event replay, sampling, OAuth, or arbitrary tools.
It does not retry expired sessions automatically. Repeat the command to create a new session after a connection failure.
The server validates the result schema. The dashboard checks it again during import. This client does not independently validate every research field.
Use a full MCP client for those features.

Reference: [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports).
