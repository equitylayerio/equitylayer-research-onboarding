import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, contentHash, createRunEnvelope, validateRunEnvelope, publicBeginArguments, legacyResultProvenance } from "../client/local/run-contract.mjs";

const fixture = () => ({
  scope: { watch_id: "8713bba6-e91e-4c1a-b756-2b18d2b7c775", revision: 1, theme_id: "ai_compute", stage_id: "memory",
    symbols: ["3711.TW", "NVDA", "6857.T", "000660.KS"] },
  method: { bundle_version: "2026-10-11.1", bundle_sha256: "a".repeat(64), profile_ids: ["ai-compute-memory", "ai-compute-packaging-test"] },
  source_refs: [{ source_event_id: "event-1", source_event_sha256: "b".repeat(64), source_artifact_id: "artifact-1", artifact_sha256: "c".repeat(64) }],
  baselines: [{ owner: "caller_local", pack_id: "revenue", pack_version: "2026-07:r1", output_sha256: "d".repeat(64), recorded_at: "2026-08-01T00:00:00Z" }],
  evaluation_at: "2026-10-11T00:00:00Z", local_context_sha256: contentHash({ question: "Private question stays local." }),
});
const invalid = (fn) => assert.throws(fn, { code: "INVALID_RUN_CONTRACT" });

test("run identity pins all inputs and does not use the shared MCP handle", () => {
  const input = fixture();
  const run = createRunEnvelope(input);
  assert.deepEqual(validateRunEnvelope(run), run);
  assert.match(run.run_id, /^el-run-[a-f0-9]{64}$/);
  assert.match(run.delivery_id, /^el-delivery-[a-f0-9]{64}$/);
  assert.ok(!Object.hasOwn(run, "handle"));
  assert.deepEqual(createRunEnvelope(fixture()), run);
});

for (const change of ["watch", "revision", "theme", "stage", "symbols", "method", "source-event", "source-artifact", "baseline", "time", "private-context"]) {
  test(`changing ${change} changes the run and delivery IDs`, () => {
    const input = fixture();
    const prior = createRunEnvelope(input);
    if (change === "watch") input.scope.watch_id = "9713bba6-e91e-4c1a-b756-2b18d2b7c775";
    if (change === "revision") input.scope.revision++;
    if (change === "theme") { input.scope.theme_id = "optical_cpo"; delete input.scope.stage_id; }
    if (change === "stage") input.scope.stage_id = "network";
    if (change === "symbols") input.scope.symbols.push("LITE");
    if (change === "method") input.method.bundle_sha256 = "e".repeat(64);
    if (change === "source-event") input.source_refs[0].source_event_sha256 = "e".repeat(64);
    if (change === "source-artifact") input.source_refs[0].artifact_sha256 = "e".repeat(64);
    if (change === "baseline") input.baselines[0].output_sha256 = "e".repeat(64);
    if (change === "time") input.evaluation_at = "2026-10-12T00:00:00Z";
    if (change === "private-context") input.local_context_sha256 = "e".repeat(64);
    const changed = createRunEnvelope(input);
    assert.notEqual(prior.run_id, changed.run_id);
    assert.notEqual(prior.delivery_id, changed.delivery_id);
  });
}

test("ordering and canonical timestamps do not create another run", () => {
  const a = fixture();
  a.source_refs.push({ ...a.source_refs[0], source_event_id: "event-2" });
  const b = structuredClone(a);
  b.scope.symbols.reverse(); b.method.profile_ids.reverse(); b.source_refs.reverse();
  b.evaluation_at = "2026-10-11T00:00:00.000Z";
  assert.deepEqual(createRunEnvelope(a), createRunEnvelope(b));
});

test("unknown fields cannot send private context to a public begin call", () => {
  const input = fixture();
  const run = createRunEnvelope(input);
  assert.deepEqual(publicBeginArguments(run), {
    ...input.scope, symbols: [...input.scope.symbols].sort(),
  });
  for (const field of ["question", "thesis", "holdings", "available_mcp_names", "wallet", "api_key"]) {
    invalid(() => createRunEnvelope({ ...input, [field]: "private" }));
    invalid(() => createRunEnvelope({ ...input, scope: { ...input.scope, [field]: "private" } }));
  }
  const wire = JSON.stringify(publicBeginArguments(run));
  for (const value of [input.local_context_sha256, input.baselines[0].pack_id, run.run_id, input.source_refs[0].source_event_id]) {
    assert.ok(!wire.includes(value));
  }
});

test("tampered envelopes fail before reuse", () => {
  const run = createRunEnvelope(fixture());
  assert.throws(() => validateRunEnvelope({ ...run, run_id: `el-run-${"f".repeat(64)}` }), { code: "RUN_IDENTITY_CONFLICT" });
  assert.throws(() => validateRunEnvelope({ ...run, delivery_id: "other" }), { code: "RUN_IDENTITY_CONFLICT" });
  invalid(() => validateRunEnvelope({ ...run, contract_version: "2" }));
  invalid(() => validateRunEnvelope({ ...run, handle: "not-a-local-run" }));
});

test("duplicate or conflicting references and invalid scopes require correction", () => {
  const input = fixture();
  invalid(() => createRunEnvelope({ ...input, source_refs: [...input.source_refs, { ...input.source_refs[0], artifact_sha256: "e".repeat(64) }] }));
  invalid(() => createRunEnvelope({ ...input, baselines: [...input.baselines, { ...input.baselines[0], pack_version: "other" }] }));
  for (const scope of [{ ...input.scope, revision: 0 }, { ...input.scope, revision: 1.5 }, { ...input.scope, watch_id: "wrong" },
    { ...input.scope, symbols: ["NVDA", "nvda"] }, { ...input.scope, symbols: [] }, { ...input.scope, symbols: ["../secrets"] },
    { ...input.scope, theme_id: "optical_cpo" }, { ...input.scope, theme_id: "unknown" }, { ...input.scope, stage_id: "unknown" }]) {
    invalid(() => createRunEnvelope({ ...input, scope }));
  }
  invalid(() => createRunEnvelope({ ...input, method: { ...input.method, profile_ids: [] } }));
  invalid(() => createRunEnvelope({ ...input, local_context_sha256: "unknown" }));
  invalid(() => createRunEnvelope({ ...input, evaluation_at: "2026-02-30T00:00:00Z" }));
});

test("input changes cannot mutate a pinned method or scope", () => {
  const input = fixture();
  const run = createRunEnvelope(input);
  input.method.profile_ids.push("other"); input.scope.symbols.push("LITE");
  assert.equal(run.scope.symbols.length, 4);
  assert.equal(run.method.profile_ids.length, 2);
  assert.throws(() => { run.method.bundle_sha256 = "e".repeat(64); }, TypeError);
  assert.throws(() => run.source_refs.push({}), TypeError);
});

test("legacy import records unknown provenance without inventing a run or method", () => {
  const legacy = { result_id: "old", schema_version: 1, summary: "Retained historical text." };
  const provenance = legacyResultProvenance(legacy);
  assert.equal(provenance.status, "unknown");
  assert.equal(provenance.original_result_sha256, contentHash(legacy));
  assert.equal(provenance.run_id, null); assert.equal(provenance.method, null); assert.equal(provenance.source_refs, null);
});

test("identifiers reject control characters, line separators, and direction controls", () => {
  const input = fixture();
  for (const control of ["\n", "\r", "\t", "\0", "\u007f", "\u0085", "\u2028", "\u2029", "\u202e", "\u2066"]) {
    const identifier = `event${control}next`;
    invalid(() => createRunEnvelope({ ...input, source_refs: [{ ...input.source_refs[0], source_event_id: identifier }] }));
    invalid(() => createRunEnvelope({ ...input, method: { ...input.method, bundle_version: identifier } }));
    invalid(() => createRunEnvelope({ ...input, baselines: [{ ...input.baselines[0], pack_id: identifier }] }));
  }
});

test("canonical JSON matches the existing research contract format", () => {
  assert.equal(canonicalJson({ z: -0, a: [true, null, { b: 2, a: "x" }] }), '{"a":[true,null,{"a":"x","b":2}],"z":0}');
  for (const value of [NaN, Infinity, undefined, 1n, () => {}, new Date(), Object.create(null)]) invalid(() => canonicalJson(value));
  const cyclic = {}; cyclic.self = cyclic;
  invalid(() => canonicalJson(cyclic));
  invalid(() => canonicalJson(new Array(2)));
  const extra = [1]; extra.private = "not-json";
  invalid(() => canonicalJson(extra));
  const sparseExtra = new Array(1); sparseExtra.private = "not-json";
  invalid(() => canonicalJson(sparseExtra));
});
