import { readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { connect, endpointUrl } from "./mcp.mjs";
import { inspectCompatibility } from "./compatibility.mjs";

const TOOLS = { status: "get_service_status", discover: "discover_theses", begin: "begin_research", finalize: "finalize_research",
  company: "resolve_company_tracker", update: "get_research_update", instrument: "resolve_trading_instrument", evidence: "get_instrument_evidence" };
const HELP = `EquityLayer research client (Node.js 22+)
  node client/cli.mjs doctor|status|tools|discover [--endpoint URL]
  node client/cli.mjs begin --input scope.json [--out plan.json] [--endpoint URL]
  node client/cli.mjs finalize --input public-draft.json --public-data --out result.json [--endpoint URL]
  node client/cli.mjs instrument --input symbol.json [--endpoint URL]
  node client/cli.mjs evidence --input examples/robinhood-evidence.json [--endpoint URL]
  node client/cli.mjs company|update --input request.json [--endpoint URL]

Default endpoint: https://equitylayer.io/mcp
Use --endpoint http://127.0.0.1:3100/mcp for a local server.
Input goes to that endpoint. Send public research only.
This client cannot pay, sign, trade, or accept a research baseline.
`;

export function parseArgs(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) return { help: true };
  const [command, ...rest] = args;
  if (!Object.hasOwn(TOOLS, command) && !["tools", "doctor"].includes(command)) throw new Error("Read the supported commands with --help.");
  const result = { command, endpoint: "https://equitylayer.io/mcp", publicData: false };
  const seen = new Set();
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    if (seen.has(key)) throw new Error("Remove duplicate options.");
    seen.add(key);
    if (key === "--public-data") { result.publicData = true; continue; }
    if (!["--endpoint", "--input", "--out"].includes(key) || !rest[index + 1] || rest[index + 1].startsWith("--")) {
      throw new Error("Check the command options with --help.");
    }
    result[key.slice(2)] = rest[++index];
  }
  endpointUrl(result.endpoint);
  const needsInput = ["begin", "finalize", "instrument", "evidence", "company", "update"].includes(command);
  if (needsInput !== Boolean(result.input)) throw new Error("Begin, finalize, instrument, evidence, company, and update require --input. Other commands do not accept input.");
  if (command === "finalize" && (!result.publicData || !result.out)) throw new Error("Finalize requires --public-data and --out. Do not send private research.");
  if (result.publicData && command !== "finalize") throw new Error("Use --public-data only with finalize.");
  return result;
}

export async function run(args, { connectClient = connect, stdout = value => process.stdout.write(value) } = {}) {
  const options = parseArgs(args);
  if (options.help) { stdout(HELP); return; }
  let input = {};
  if (options.input) {
    const info = await stat(options.input);
    if (!info.isFile() || info.size > 1_000_000) throw new Error("Use a JSON file smaller than 1 MB.");
    input = JSON.parse(await readFile(options.input, "utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("The input must be a JSON object.");
  }
  if (options.command === "evidence") {
    const keys = Object.keys(input);
    if (keys.length !== 2 || !keys.includes("symbol") || !keys.includes("network")
      || typeof input.symbol !== "string" || !input.symbol.trim() || input.symbol.length > 32
      || !["solana-mainnet", "robinhood-mainnet"].includes(input.network)) {
      throw new Error("Use a company symbol and a supported network only. Do not supply wallet or order data.");
    }
  }
  const client = await connectClient(options.endpoint, { timeoutMs: 25_000 });
  try {
    let output;
    if (options.command === "doctor") {
      output = inspectCompatibility(options.endpoint, await client.tools());
    } else if (options.command === "tools") {
      output = await client.tools();
    } else {
      if (["begin", "finalize", "instrument", "evidence"].includes(options.command)) {
        const listing = await client.tools();
        const report = inspectCompatibility(options.endpoint, listing);
        const available = options.command === "evidence" ? report.chain_evidence_available
          : options.command === "instrument" ? report.instrument_mapping_available : report.research_tools_available;
        if (!available) throw new Error("This server lacks required tools. Run doctor. Do not send the research draft to this server.");
      }
      output = await client.call(TOOLS[options.command], input);
    }
    const result = options.command === "finalize" ? output.result_file : output;
    if (options.command === "finalize" && (output.ok !== true || !result?.result_id || !result?.result_state)) {
      throw new Error("Finalize did not return a result file.");
    }
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (options.out) {
      // Refuse overwrite, including existing symlinks. Keep the local file private.
      await writeFile(options.out, json, { flag: "wx", mode: 0o600 });
      stdout(`${JSON.stringify({ saved: options.out, command: options.command, accepted_baseline: false,
        ...(options.command === "finalize" ? { warnings: output.warnings ?? [], delivery: output.delivery } : {}) })}\n`);
    } else { stdout(json); }
    return { exitCode: (options.command === "doctor" && !output.research_tools_available)
      || (options.command === "evidence" && !["checked", "available"].includes(output.status)) ? 2 : 0 };
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(result => { process.exitCode = result?.exitCode ?? 0; }).catch(error => {
    const message = error?.code === "EEXIST" ? "The output exists. Choose a new file name."
      : error instanceof SyntaxError ? "The input or server response is not valid JSON."
      : error?.code ? "The local file could not be read or saved. Check its path and permissions."
      : error.message;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
