// Synthetic process fixture. It never invokes a model or a provider.
import { basename } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const mode = basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes("--version")) {
  if (mode.includes("check-hang")) await new Promise(resolve => setTimeout(resolve, 60000));
  const marker = process.env.HOME + "/management-version-checked";
  const drift = mode.includes("drift") && existsSync(marker);
  if (mode.includes("drift")) writeFileSync(marker, "synthetic management check");
  console.log(mode.includes("codex") ? "codex-cli 0.144.5" : mode.includes("version") || drift ? "0.0.1 (Claude Code)" : mode.includes("bounded") ? "2.1.217 (Claude Code)" : "2.1.150 (Claude Code)");
} else if (args[0] === "features") {
  if (!mode.includes("capability")) for (const feature of ["shell_tool", "unified_exec", "hooks", "plugins", "apps", "browser_use", "browser_use_external",
    "browser_use_full_cdp_access", "computer_use", "in_app_browser", "image_generation", "multi_agent", "code_mode_host"]) console.log(`${feature} stable true`);
} else if (args.includes("--help")) {
  console.log(mode.includes("no-cost-controls") ? "Usage: synthetic CLI" : mode.includes("near-cost-controls")
    ? "Usage: synthetic CLI --max-budget-usd-extra AMOUNT --max-turns-extra COUNT" : mode.includes("budget-only")
      ? "Usage: synthetic CLI --max-budget-usd AMOUNT" : "Usage: synthetic CLI --max-budget-usd AMOUNT --max-turns COUNT");
} else {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (mode.includes("hang")) await new Promise(resolve => setTimeout(resolve, 60000));
  else if (mode.includes("stderr")) { console.error("PRIVATE_SENTINEL".repeat(100)); process.exitCode = 1; }
  else if (mode.includes("oversize")) console.log("x".repeat(10000));
  else if (mode.includes("failure-")) {
    const subtype = { turn: "error_max_turns", budget: "error_max_budget_usd", execution: "error_during_execution",
      structured: "error_max_structured_output_retries" }[mode.split("failure-")[1]];
    console.log(JSON.stringify({ type: "result", subtype, is_error: true, num_turns: 1,
      errors: ["PRIVATE_SENTINEL provider detail"], total_cost_usd: 0, modelUsage: {} }));
    process.exitCode = 1;
  }
  else {
    if (mode.includes("success-tree")) {
      const child = spawn(process.execPath, ["--input-type=module", "-e",
        'import fs from "node:fs"; process.on("SIGTERM",()=>{}); fs.writeFileSync(process.env.HOME+"/native-child.pid",String(process.pid)); setInterval(()=>{},1000);'],
      { stdio: "ignore", env: { HOME: process.env.HOME } });
      child.unref();
      for (let i = 0; i < 100 && !existsSync(process.env.HOME + "/native-child.pid"); i++) await new Promise(resolve => setTimeout(resolve, 10));
    }
    const input = JSON.parse(prompt.slice(prompt.indexOf("\n{\"agent_fields_contract\"")));
    const context = input.research_context;
    const agent_fields = { result_state: "SOURCE_NEEDED", summary: "Synthetic native process, not real research.", sources: [],
      drivers: [], falsifiers: [], unknowns: ["Synthetic evidence gap."], next_check_at: new Date(Date.parse(context.created_at) + 86400000).toISOString() };
    if (mode.includes("advice")) agent_fields.summary = "Buy now.";
    if (!args.includes("--model") || !args.includes("--tools") && !args.includes("--sandbox") || !prompt.includes("higher-grade material")) process.exit(1);
    if (mode.includes("bounded") && (args[args.indexOf("--max-turns") + 1] !== "2" ||
        args[args.indexOf("--max-budget-usd") + 1] !== "0.15" || process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS !== "800" ||
        process.env.CLAUDE_CODE_MAX_RETRIES !== "0" || process.env.MAX_STRUCTURED_OUTPUT_RETRIES !== "0")) process.exit(1);
    if (mode.includes("codex")) {
      console.log(JSON.stringify({ type: "thread.started", thread_id: "synthetic" }));
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(agent_fields) } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 7, cached_input_tokens: 3, output_tokens: 5 } }));
    } else console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1,
      structured_output: agent_fields, permission_denials: [], total_cost_usd: 0.000004,
      modelUsage: { synthetic: { inputTokens: 7, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2 } } }));
  }
}
