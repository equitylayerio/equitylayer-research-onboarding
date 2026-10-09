import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, run } from "../client/cli.mjs";
import { inspectCompatibility } from "../client/compatibility.mjs";

test("evidence requires an input and advertises separate read-only capability", () => {
  assert.throws(() => parseArgs(["evidence"]));
  assert.equal(parseArgs(["evidence", "--input", "x.json"]).command, "evidence");
  assert.equal(inspectCompatibility("local", { tools: [] }).chain_evidence_available, false);
  assert.equal(inspectCompatibility("local", { tools: [{ name: "get_instrument_evidence" }] }).chain_evidence_available, true);
});

test("evidence refuses wallet and order fields before connecting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "equitylayer-evidence-"));
  try {
    for (const input of [{ symbol: "NVDA", network: "robinhood-mainnet", wallet: "wallet" },
      { symbol: "NVDA", network: "robinhood-mainnet", submit: true }, { symbol: "NVDA", network: "other" },
      { network: "robinhood-mainnet" }, { symbol: "", network: "robinhood-mainnet" }]) {
      await writeFile(join(dir, "input.json"), JSON.stringify(input));
      await assert.rejects(run(["evidence", "--input", join(dir, "input.json")], { connectClient: async () => { assert.fail("No connection permitted"); } }), /symbol and a supported network/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("evidence discovers the tool, closes sessions, and returns nonzero for unavailable reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "equitylayer-evidence-"));
  try {
    await writeFile(join(dir, "input.json"), JSON.stringify({ symbol: "NVDA", network: "robinhood-mainnet" }));
    for (const status of ["checked", "unavailable"]) {
      let closed = 0, called = 0;
      const result = await run(["evidence", "--input", join(dir, "input.json")], { stdout: () => {}, connectClient: async () => ({
        tools: async () => ({ tools: [{ name: "get_instrument_evidence" }] }),
        call: async (name, args) => { called++; assert.equal(name, "get_instrument_evidence"); assert.equal(args.network, "robinhood-mainnet"); return { status, execution_supported: false }; },
        close: async () => { closed++; },
      }) });
      assert.equal(result.exitCode, status === "checked" ? 0 : 2); assert.equal(closed, 1); assert.equal(called, 1);
    }
    let closed = false;
    await assert.rejects(run(["evidence", "--input", join(dir, "input.json")], { stdout: () => {}, connectClient: async () => ({
      tools: async () => ({ tools: [] }), call: async () => assert.fail("Missing tool"), close: async () => { closed = true; },
    }) }), /lacks required tools/);
    assert.equal(closed, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
