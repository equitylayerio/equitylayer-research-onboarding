import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { ResearchLedger } from "../client/local/ledger.mjs";
import { contentHash, createRunEnvelope } from "../client/local/run-contract.mjs";
import { createNativeResearchRuntime, buildNativeResearchPrompt } from "../client/local/native-runtime.mjs";
import { executeClaimedRun } from "../client/local/executor.mjs";
import { setup, scope, context, source, methodBundle, policy, estimate } from "./fixtures/local-research.mjs";
import { sourcePolicy } from "./fixtures/source-events.mjs";

function environment(t, largeBody = false) {
  const root = mkdtempSync(join(tmpdir(), "el-source-context-test-"));
  const now = Date.parse("2026-10-11T00:00:02Z");
  let ledger = new ResearchLedger(join(root, "workspace"), { clock: () => now });
  let envelope = setup(ledger);
  if (largeBody) {
    const retained = source(2); retained.bytes = Buffer.from('"'.repeat(1_100_000));
    retained.artifact = { ...retained.artifact, content_type: "text/plain", byte_length: retained.bytes.length,
      artifact_sha256: createHash("sha256").update(retained.bytes).digest("hex") };
    const reference = ledger.retainSource(retained.event, retained.artifact, retained.bytes);
    envelope = createRunEnvelope({ scope: envelope.scope, method: envelope.method, source_refs: [reference], baselines: [],
      evaluation_at: envelope.evaluation_at, local_context_sha256: envelope.local_context_sha256 });
  }
  ledger.configureSourcePolicy(scope().watch_id, sourcePolicy());
  ledger.enqueue(envelope, "test-window", policy());
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, now, envelope, get ledger() { return ledger; }, reopen() {
    ledger.close(); ledger = new ResearchLedger(join(root, "workspace"), { clock: () => now });
  } };
}
const input = record => ({ schema_version: 1, context_sha256: record.sha256, research_context: record.payload, agent_fields_contract: { response: "Seven fields." } });

test("new source context retains complete artifact text and exact pins across restart", t => {
  const env = environment(t), lease = env.ledger.claim("first");
  const record = env.ledger.executionContext(lease);
  assert.equal(record.payload.schema_version, 2);
  assert.equal(record.payload.sources[0].source_content.text, source().bytes.toString());
  assert.equal(record.payload.sources[0].source_content.artifact_sha256, env.envelope.source_refs[0].artifact_sha256);
  const prompt = buildNativeResearchPrompt(input(record));
  assert.match(prompt, /complete retained artifact/); assert.match(prompt, /not necessarily the publisher/);
  assert.doesNotMatch(prompt, /not complete source documents/);
  env.ledger.retryRun(lease, env.now); env.reopen();
  assert.deepEqual(env.ledger.executionContext(env.ledger.claim("second")), record);
  assert.equal(env.ledger.inbox().length, 0); assert.equal(env.ledger.reviews(scope().watch_id).length, 0);
});

test("legacy context remains byte-identical and does not acquire newly visible source text", t => {
  const env = environment(t), lease = env.ledger.claim("legacy"), original = source();
  const payload = { schema_version: 1, envelope: env.envelope, private_context: context(), method_bundle: methodBundle(),
    sources: [{ reference: env.envelope.source_refs[0], event: original.event, artifact: original.artifact, facts: [] }],
    baseline_context: [], created_at: new Date(env.now).toISOString() };
  const legacy = env.ledger.checkpoint(lease, "execution-context:v1", payload);
  assert.deepEqual(env.ledger.executionContext(lease), legacy);
  assert.match(buildNativeResearchPrompt(input(legacy)), /not complete source documents/);
  env.ledger.retryRun(lease, env.now); env.reopen();
  assert.deepEqual(env.ledger.executionContext(env.ledger.claim("reopen")), legacy);
  assert.equal(env.ledger.checkpoints(env.envelope.run_id).some(c => c.key === "execution-context:v2"), false);
});

test("a recomputed context hash cannot disguise changed source text or missing coverage", t => {
  const env = environment(t), record = env.ledger.executionContext(env.ledger.claim("caller"));
  for (const alter of [value => { value.sources[0].source_content.text = "Changed"; },
    value => { delete value.sources[0].source_content; }]) {
    const payload = structuredClone(record.payload); alter(payload);
    assert.throws(() => buildNativeResearchPrompt(input({ payload, sha256: contentHash(payload) })), { code: "NATIVE_SOURCE_CONTENT_INVALID" });
  }
  const payload = structuredClone(record.payload); payload.source_content_renderer_sha256 = "a".repeat(64);
  assert.throws(() => buildNativeResearchPrompt(input({ payload, sha256: contentHash(payload) })), { code: "NATIVE_SOURCE_CONTENT_CHANGED" });
});

test("native input limits fail before request reservation, process startup, or unknown billing", async t => {
  const env = environment(t), lease = env.ledger.claim("caller");
  const runtime = createNativeResearchRuntime({ allow_native_research: true, provider: "claude-code",
    executable: join(env.root, "not-created"), model: "caller-selected-model", cli_version: "2.1.150", env: { HOME: env.root }, max_prompt_bytes: 10 });
  const result = await executeClaimedRun(env.ledger, lease, runtime, { allow_private_context: true,
    allow_candidate_method: true, estimate: estimate(), timeout_ms: 1000, clock: () => env.now });
  assert.equal(result.code, "NATIVE_INPUT_LIMIT");
  assert.equal(env.ledger.requests(env.envelope.run_id).length, 0);
  assert.equal(env.ledger.budget(scope().watch_id, "test-window").spent.requests, 0);
  assert.equal(env.ledger.budget(scope().watch_id, "test-window").reserved.tokens, 0);
  assert.equal(env.ledger.budget(scope().watch_id, "test-window").gate_code, null);
  assert.equal(env.ledger.inbox().length, 0);
});

test("native preparation does not invoke an unbudgeted hook on generic runtimes", async t => {
  const env = environment(t), lease = env.ledger.claim("caller"); let hookCalls = 0;
  const runtime = { identity: "generic-synthetic", config_sha256: "b".repeat(64), prepare() { hookCalls++; }, async execute() {
    return { agent_fields: { result_state: "SOURCE_NEEDED", summary: "Synthetic evidence gap.", sources: [], drivers: [], falsifiers: [],
      unknowns: ["Synthetic only."], next_check_at: "2026-10-12T00:00:00Z" }, usage: { tokens: 1, cost_microusd: 1 } };
  } };
  const result = await executeClaimedRun(env.ledger, lease, runtime, { allow_private_context: true,
    allow_candidate_method: true, estimate: estimate(), timeout_ms: 1000, clock: () => env.now });
  assert.equal(result.status, "completed"); assert.equal(hookCalls, 0);
});

test("combined context size is gated without truncation, retry, or request reservation", async t => {
  const env = environment(t, true), lease = env.ledger.claim("caller"); let calls = 0;
  const runtime = { identity: "unused-synthetic", config_sha256: "c".repeat(64), async execute() { calls++; } };
  const result = await executeClaimedRun(env.ledger, lease, runtime, { allow_private_context: true,
    allow_candidate_method: true, estimate: estimate(), timeout_ms: 1000, retry_delay_ms: 0, clock: () => env.now });
  assert.equal(result.code, "SOURCE_CONTEXT_LIMIT"); assert.equal(calls, 0);
  assert.equal(env.ledger.requests(env.envelope.run_id).length, 0);
  assert.equal(env.ledger.run(env.envelope.run_id).status, "gated");
});
