import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { contentHash, createRunEnvelope } from "../client/local/run-contract.mjs";
import { verifySourceReference, verifyMethodBundle } from "../client/local/reference-bridge.mjs";

const clone = value => JSON.parse(JSON.stringify(value));
const invalidSource = fn => assert.throws(fn, { code: "INVALID_SOURCE_REFERENCE" });
const invalidMethod = fn => assert.throws(fn, { code: "INVALID_METHOD_BUNDLE" });
const sourceFixture = () => {
  // Synthetic dataset bytes use the retained source artifact/event wire fields.
  const bytes = Buffer.from('[{"issuer":"3037.TW","revenue":100},{"issuer":"3711.TW","revenue":200}]');
  const artifact = {
    source_artifact_id: "dataset:2026-09:original", source_id: "example-exchange", source_class: "exchange_dataset",
    canonical_url: "https://example.test/monthly-revenue", published_at: "2026-10-11T09:30:00+08:00",
    retrieved_at: "2026-10-11T02:00:00.123Z", source_period: "2026-09", content_type: "application/json",
    http_status: 200, byte_length: bytes.length, artifact_sha256: createHash("sha256").update(bytes).digest("hex"),
    immutable_storage_key: "raw/monthly-revenue/2026-09.json",
  };
  const event = {
    source_event_id: "dataset-event:2026-09:1", event_kind: "NEW_PERIOD", source_artifact_id: artifact.source_artifact_id,
    adapter_version: "exchange-monthly-revenue:1.0.0", parser_version: "monthly-revenue:1.0.0",
    observed_at: "2026-10-11T02:00:01Z", supersedes_source_event_id: null,
    affected_fact_keys: [contentHash({ issuer: "3037.TW", metric: "issuer_total_revenue" }), contentHash({ issuer: "3711.TW", metric: "issuer_total_revenue" })],
  };
  return { bytes, artifact: clone(artifact), event: clone(event) };
};

// This serialized fixture matches evidenceProfileBundle("optical_cpo") from the private producer.
const methodFixture = () => ({
  version: "2026-10-11.1", release_status: "candidate",
  execution_policy: "Use profiles for local candidate trials only. Human curation and independent evaluation are required before method promotion.",
  profiles: [{
    profile_id: "ai-compute-optical-cpo", stage_id: "network", title: "Optical networking and CPO",
    checks: [
      "Classify demonstrations, sampling, qualification, shipments, and product revenue separately.",
      "Check the issuer's product role, measured performance, deployment scope, and named commercial evidence.",
      "Compare product-specific revenue and shipments with a preserved, comparable prior disclosure.",
    ],
    counterevidence_checks: ["Check qualification delays, competing architectures, limited deployment, and missing commercial follow-through."],
    inference_limits: [
      "A demonstration, partnership, or capacity plan does not prove commercial shipment or revenue.",
      "Issuer total revenue does not establish CPO revenue or a named customer relationship.",
    ],
    version: "0.1.0", parent_theme_id: "ai_compute", market_scope: ["US", "TW", "JP", "KR"],
    required_evidence: [
      "Retain the original primary artifact, hash, source date, reporting period, and exact locator.",
      "Match each metric to the issuer, product, unit, accounting basis, and comparable prior period.",
      "Separate reported facts, management claims, inference, and missing evidence.",
    ],
    trigger_types: ["relevant issuer disclosure", "quarterly earnings", "source correction", "caller-approved review trigger"],
    curation_status: "founder_review_required", verified_company_evidence: false,
    selection_policy: "Keep the selected companies. Confirm profile applicability and issuer roles with the user. Keep private thesis text local.",
    content_sha256: "430f3742268a9215cc7ff11540546ad12435259e8239fb52c91161ad33400c8b",
  }],
  content_sha256: "48fb5cbaea2496b1248ebae9165f8306b1c9611b1c0080bdf1ebd021f27374bb",
});
const rehashBundle = bundle => {
  for (const profile of bundle.profiles) {
    const { content_sha256, ...content } = profile;
    profile.content_sha256 = contentHash(content);
  }
  const { content_sha256, ...content } = bundle;
  bundle.content_sha256 = contentHash(content);
  return bundle;
};

test("source bridge preserves the four-field reference for a multi-issuer dataset", () => {
  const { event, artifact, bytes } = sourceFixture();
  const expected = { source_event_id: event.source_event_id, source_event_sha256: contentHash(event), source_artifact_id: artifact.source_artifact_id, artifact_sha256: artifact.artifact_sha256 };
  assert.deepEqual(verifySourceReference(event, artifact, bytes), expected);
  assert.deepEqual(verifySourceReference(event, artifact, bytes, expected), expected);
  assert.equal(event.affected_fact_keys.length, 2);
  assert.ok(!Object.hasOwn(expected, "source_rights"));
  assert.ok(!Object.hasOwn(expected, "lineage_verified"));
});

test("source bridge requires retained bytes, their hash, and their exact length", () => {
  const { event, artifact, bytes } = sourceFixture();
  invalidSource(() => verifySourceReference(event, artifact, Buffer.from("different")));
  const changed = Buffer.from(bytes); changed[0] ^= 1;
  invalidSource(() => verifySourceReference(event, artifact, changed));
  invalidSource(() => verifySourceReference(event, { ...artifact, byte_length: bytes.length + 1 }, bytes));
  invalidSource(() => verifySourceReference(event, { ...artifact, artifact_sha256: "a".repeat(64) }, bytes));
  invalidSource(() => verifySourceReference(event, artifact, bytes.toString()));
  assert.deepEqual(verifySourceReference(event, artifact, new Uint8Array(bytes)), verifySourceReference(event, artifact, bytes));
});

test("source byte checks use the detached validated length", () => {
  const { event, artifact, bytes } = sourceFixture(); let reads = 0;
  Object.defineProperty(artifact, "byte_length", { enumerable: true,
    get() { reads++; return reads === 1 ? bytes.length + 1 : bytes.length; } });
  invalidSource(() => verifySourceReference(event, artifact, bytes));
  assert.equal(reads, 1);
});

test("source bridge rejects missing and unsupported fields without inventing metadata", () => {
  const { event, artifact, bytes } = sourceFixture();
  for (const field of Object.keys(event)) {
    const changed = clone(event); delete changed[field];
    invalidSource(() => verifySourceReference(changed, artifact, bytes));
  }
  for (const field of Object.keys(artifact)) {
    const changed = clone(artifact); delete changed[field];
    invalidSource(() => verifySourceReference(event, changed, bytes));
  }
  invalidSource(() => verifySourceReference({ ...event, source_event_sha256: contentHash(event) }, artifact, bytes));
  invalidSource(() => verifySourceReference(event, { ...artifact, rights: "APPROVED" }, bytes));
});

test("source IDs, event hashes, and expected refs cannot conflict", () => {
  const { event, artifact, bytes } = sourceFixture();
  const ref = verifySourceReference(event, artifact, bytes);
  invalidSource(() => verifySourceReference({ ...event, source_artifact_id: "other" }, artifact, bytes));
  for (const field of Object.keys(ref)) {
    const expected = { ...ref, [field]: field.endsWith("sha256") ? "a".repeat(64) : "other" };
    assert.throws(() => verifySourceReference(event, artifact, bytes, expected), { code: "SOURCE_REFERENCE_CONFLICT" });
  }
  const changed = { ...event, parser_version: "monthly-revenue:2.0.0" };
  assert.throws(() => verifySourceReference(changed, artifact, bytes, ref), { code: "SOURCE_REFERENCE_CONFLICT" });
  invalidSource(() => verifySourceReference(event, artifact, bytes, { ...ref, private_thesis: "private" }));
});

test("parser and adapter fields use producer string IDs, not objects or empty values", () => {
  const { event, artifact, bytes } = sourceFixture();
  for (const field of ["adapter_version", "parser_version"]) {
    for (const value of ["", " ", { name: "parser", version: "1" }, 1, "a".repeat(161), "parser\n1"]) {
      invalidSource(() => verifySourceReference({ ...event, [field]: value }, artifact, bytes));
    }
  }
});

test("source metadata rejects invalid dates, URLs, classes, statuses, and lengths", () => {
  const { event, artifact, bytes } = sourceFixture();
  for (const change of [{ published_at: "2026-02-30T00:00:00Z" }, { retrieved_at: "2026-10-11" }, { canonical_url: "relative/path" },
    { source_class: "blog" }, { http_status: 99 }, { http_status: 600 }, { http_status: 200.5 }, { byte_length: -1 }, { byte_length: 0.5 }, { source_period: "" }]) {
    invalidSource(() => verifySourceReference(event, { ...artifact, ...change }, bytes));
  }
  invalidSource(() => verifySourceReference({ ...event, observed_at: "2026-10-11T24:00:00Z" }, artifact, bytes));
  invalidSource(() => verifySourceReference({ ...event, event_kind: "unknown" }, artifact, bytes));
  assert.ok(verifySourceReference(event, { ...artifact, published_at: null, source_period: null }, bytes));
});

test("affected keys require bounded, unique SHA-256 values", () => {
  const { event, artifact, bytes } = sourceFixture();
  for (const keys of [["not-a-fact-hash"], ["A".repeat(64)], [event.affected_fact_keys[0], event.affected_fact_keys[0]], new Array(10001).fill("a".repeat(64))]) {
    invalidSource(() => verifySourceReference({ ...event, affected_fact_keys: keys }, artifact, bytes));
  }
  assert.ok(verifySourceReference({ ...event, event_kind: "NO_DATA", affected_fact_keys: [] }, artifact, bytes));
});

test("supersession shape is checked without claiming context-bound lineage", () => {
  const { event, artifact, bytes } = sourceFixture();
  invalidSource(() => verifySourceReference({ ...event, event_kind: "CORRECTED_PERIOD" }, artifact, bytes));
  invalidSource(() => verifySourceReference({ ...event, supersedes_source_event_id: event.source_event_id }, artifact, bytes));
  const corrected = { ...event, event_kind: "CORRECTED_PERIOD", supersedes_source_event_id: "retained-event-not-supplied-here" };
  assert.ok(verifySourceReference(corrected, artifact, bytes));
});

test("actual candidate CPO serialization produces the exact pinned method shape", () => {
  const bundle = clone(methodFixture());
  const expected = { bundle_version: bundle.version, bundle_sha256: bundle.content_sha256, profile_ids: ["ai-compute-optical-cpo"] };
  assert.deepEqual(verifyMethodBundle(bundle), expected);
  assert.deepEqual(verifyMethodBundle(bundle, expected), expected);
  assert.equal(bundle.release_status, "candidate");
  assert.equal(bundle.profiles[0].curation_status, "founder_review_required");
  assert.equal(bundle.profiles[0].verified_company_evidence, false);
});

test("profile corruption and bundle corruption fail independent hash checks", () => {
  const profileChanged = methodFixture(); profileChanged.profiles[0].checks[0] = "Changed check.";
  invalidMethod(() => verifyMethodBundle(profileChanged));
  const bundleChanged = methodFixture(); bundleChanged.execution_policy = "Changed execution policy.";
  invalidMethod(() => verifyMethodBundle(bundleChanged));
  const profileHashChanged = methodFixture(); profileHashChanged.profiles[0].content_sha256 = "a".repeat(64);
  invalidMethod(() => verifyMethodBundle(profileHashChanged));
  invalidMethod(() => verifyMethodBundle({ ...methodFixture(), content_sha256: "a".repeat(64) }));
});

test("method metadata stays strict and cannot promote or claim verified evidence", () => {
  for (const change of [{ release_status: "approved" }, { profiles: [] }, { profiles: new Array(21).fill(methodFixture().profiles[0]) }, { extra: "unsupported" }]) {
    invalidMethod(() => verifyMethodBundle(rehashBundle({ ...methodFixture(), ...change })));
  }
  for (const change of [{ version: "not-a-version" }, { parent_theme_id: "physical_ai" }, { stage_id: "unknown" },
    { curation_status: "approved" }, { verified_company_evidence: true }, { market_scope: ["US", "TW"] }, { checks: [] }, { required_evidence: "text" }, { extra: "unsupported" }]) {
    const bundle = methodFixture(); Object.assign(bundle.profiles[0], change);
    invalidMethod(() => verifyMethodBundle(rehashBundle(bundle)));
  }
  const b = methodFixture(); delete b.profiles[0].selection_policy;
  invalidMethod(() => verifyMethodBundle(rehashBundle(b)));
});

test("duplicate and conflicting profile IDs fail even when hashes match each record", () => {
  for (const changed of [false, true]) {
    const bundle = methodFixture(); const profile = clone(bundle.profiles[0]);
    if (changed) profile.title = "Conflicting profile.";
    bundle.profiles.push(profile);
    invalidMethod(() => verifyMethodBundle(rehashBundle(bundle)));
  }
});

test("expected methods reject conflicts and allow profile-ID order only", () => {
  const bundle = methodFixture(); const second = clone(bundle.profiles[0]);
  second.profile_id = "ai-compute-network"; bundle.profiles.push(second); rehashBundle(bundle);
  const method = verifyMethodBundle(bundle);
  assert.deepEqual(method.profile_ids, ["ai-compute-network", "ai-compute-optical-cpo"]);
  assert.deepEqual(verifyMethodBundle(bundle, { ...method, profile_ids: [...method.profile_ids].reverse() }), method);
  for (const change of [{ bundle_version: "other" }, { bundle_sha256: "a".repeat(64) }, { profile_ids: ["other"] }]) {
    assert.throws(() => verifyMethodBundle(bundle, { ...method, ...change }), { code: "METHOD_REFERENCE_CONFLICT" });
  }
  invalidMethod(() => verifyMethodBundle(bundle, { ...method, profile_ids: [method.profile_ids[0], method.profile_ids[0]] }));
  invalidMethod(() => verifyMethodBundle(bundle, { ...method, private_thesis: "private" }));
});

test("validated references are detached and frozen without freezing caller objects", () => {
  const { event, artifact, bytes } = sourceFixture(); const bundle = methodFixture();
  const source = verifySourceReference(event, artifact, bytes); const method = verifyMethodBundle(bundle);
  assert.equal(Object.isFrozen(event), false); assert.equal(Object.isFrozen(artifact), false);
  assert.equal(Object.isFrozen(bundle), false); assert.equal(Object.isFrozen(bundle.profiles), false);
  event.source_event_id = "changed"; artifact.source_artifact_id = "changed"; bundle.profiles[0].profile_id = "changed";
  assert.notEqual(source.source_event_id, "changed"); assert.notEqual(source.source_artifact_id, "changed");
  assert.notEqual(method.profile_ids[0], "changed");
  assert.throws(() => { source.artifact_sha256 = "a".repeat(64); }, TypeError);
  assert.throws(() => method.profile_ids.push("other"), TypeError);
});

test("verified wire references integrate with the existing run envelope without extra fields", () => {
  const { event, artifact, bytes } = sourceFixture();
  const run = createRunEnvelope({
    scope: { watch_id: "8713bba6-e91e-4c1a-b756-2b18d2b7c775", revision: 1, theme_id: "optical_cpo", symbols: ["LITE", "2345.TW"] },
    method: verifyMethodBundle(methodFixture()), source_refs: [verifySourceReference(event, artifact, bytes)], baselines: [],
    evaluation_at: "2026-10-11T02:00:02Z", local_context_sha256: contentHash({ private_question: "Stays local." }),
  });
  assert.equal(run.source_refs.length, 1);
  assert.equal(run.method.profile_ids[0], "ai-compute-optical-cpo");
  assert.equal(Object.keys(run.source_refs[0]).length, 4);
});
