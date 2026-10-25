import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseLegacyWorkspace, LEGACY_WORKSPACE_MAX_BYTES } from "../client/local/legacy-workspace.mjs";
import { scope, context, result } from "./fixtures/local-research.mjs";

const now = "2026-10-11T00:00:00Z";
const resultId = (number) => `${number.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
const watch = (revision = 1, count = 1) => ({ scope: { ...scope(revision), component: "Private component", ...context() },
  saved_at: now, results: Array.from({ length: count }, (_, i) => ({ ...result({ scope: scope(revision) }), result_id: resultId(i + 1) })),
  reviews: Array.from({ length: count }, (_, i) => ({ result_id: resultId(i + 1), decision: "keep", reviewed_at: now, reason: "Private review." })),
  ...(count ? { accepted_result_id: resultId(count) } : {}) });
const workspace = (revision = 1, count = 1) => ({ schema_version: 1, watches: [watch(revision, count)] });
const parse = (value) => parseLegacyWorkspace(Buffer.from(JSON.stringify(value)));
const rejects = (value) => assert.throws(() => parse(value), { code: "LEGACY_WORKSPACE_INVALID" });
const themeWatch = () => ({ schema_version: 1, theme_id: "ai_compute", question: "Private question", trigger: "Private trigger", component: "",
  companies: ["Company name"], baseline: { pack_id: "legacy-pack", version: "v1" }, saved_at: now,
  history: [{ kind: "view_edit", reason: "Scope changed", decision: "revisit", question: "Earlier question", trigger: "Earlier trigger",
    component: "Earlier component", companies: ["Earlier company"], from_version: "", to_version: "v1", reviewed_at: now }] });

test("legacy bytes, hash, original fields, and typed records remain detached", () => {
  const input = workspace();
  input.watches[0].scope.symbols = [...input.watches[0].scope.symbols].reverse().map((symbol) => symbol.toLowerCase());
  input.watches[0].scope.question = "  Private question  ";
  input.watches[0].results[0].result_id = input.watches[0].results[0].result_id.toUpperCase();
  input.watches[0].accepted_result_id = input.watches[0].results[0].result_id;
  const bytes = Buffer.from(` \n${JSON.stringify(input, null, 2)}\n`);
  const parsed = parseLegacyWorkspace(bytes);
  assert.deepEqual(parsed.raw_bytes, bytes);
  assert.equal(parsed.raw_sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(parsed.workspace, input);
  assert.equal(parsed.watches[0].private_context.question, "Private question");
  assert.deepEqual(parsed.watches[0].scope, scope());
  assert.deepEqual(parsed.watches[0].accepted_result, { status: "legacy-unclassified", result_id: input.watches[0].accepted_result_id });
  assert.equal(parsed.watches[0].accepted_result_id, input.watches[0].accepted_result_id);
  assert.equal(parsed.watches[0].results[0].result_id, resultId(1));
  for (const key of ["method", "source_refs", "run_id", "delivery_id"]) assert.equal(Object.hasOwn(parsed.watches[0], key), false);
  bytes.fill(0);
  assert.equal(parsed.raw_bytes[0], 32);
  parsed.workspace.watches[0].scope.question = "changed";
  parsed.watches[0].results[0].sources[0].claim = "changed";
  assert.equal(parsed.watches[0].private_context.question, "Private question");
  assert.equal(parsed.workspace.watches[0].results[0].sources[0].claim, "Synthetic claim.");
  assert.equal(input.watches[0].scope.question, "  Private question  ");
});

test("complete result and review histories exceed the old 30-result UI limit", () => {
  const parsed = parse(workspace(2, 80));
  assert.equal(parsed.workspace.watches[0].results.length, 80);
  assert.equal(parsed.watches[0].results.length, 80);
  assert.equal(parsed.watches[0].reviews.length, 80);
  assert.equal(parsed.watches[0].accepted_result_id, resultId(80));
});

test("older result revisions can retain earlier themes, stages, and symbols", () => {
  const input = workspace(3, 2);
  input.watches[0].results[0] = { ...input.watches[0].results[0], scope_revision: 1, theme_id: "ai_compute", stage_id: "chip", symbols: ["NVDA"] };
  input.watches[0].accepted_result_id = input.watches[0].results[0].result_id;
  const parsed = parse(input);
  assert.equal(parsed.watches[0].results[0].stage_id, "chip");
  assert.deepEqual(parsed.watches[0].results[0].symbols, ["NVDA"]);
  assert.equal(parsed.watches[0].accepted_result.status, "legacy-unclassified");
  assert.equal(parsed.watches[0].accepted_result_id, resultId(1));
  for (const patch of [{ scope_revision: 4 }, { symbols: ["NVDA"] }, { theme_id: "physical_ai" },
    { theme_id: "ai_compute", stage_id: "chip" }, { watch_id: "22222222-2222-4222-8222-222222222222", scope_revision: 1 }]) {
    const bad = workspace(3); Object.assign(bad.watches[0].results[0], patch); rejects(bad);
  }
});

test("duplicate watch, result, and review IDs fail even when UUID letter case differs", () => {
  const duplicateWatch = workspace(); duplicateWatch.watches.push(structuredClone(duplicateWatch.watches[0]));
  duplicateWatch.watches[1].scope.watch_id = duplicateWatch.watches[1].scope.watch_id.toUpperCase(); rejects(duplicateWatch);
  const duplicateResult = workspace(); duplicateResult.watches[0].results.push(structuredClone(duplicateResult.watches[0].results[0]));
  duplicateResult.watches[0].results[1].result_id = duplicateResult.watches[0].results[1].result_id.toUpperCase(); rejects(duplicateResult);
  const crossWatch = workspace(); const second = structuredClone(crossWatch.watches[0]);
  second.scope.watch_id = "22222222-2222-4222-8222-222222222222"; second.results[0].watch_id = second.scope.watch_id;
  crossWatch.watches.push(second); rejects(crossWatch);
  const duplicateReview = workspace(); duplicateReview.watches[0].reviews.push(structuredClone(duplicateReview.watches[0].reviews[0]));
  duplicateReview.watches[0].reviews[1].result_id = duplicateReview.watches[0].reviews[1].result_id.toUpperCase(); rejects(duplicateReview);
});

test("reviews and accepted result links must stay inside their watch", () => {
  const missingResult = workspace(); missingResult.watches[0].reviews[0].result_id = resultId(9); rejects(missingResult);
  const missingReview = workspace(); missingReview.watches[0].reviews = []; rejects(missingReview);
  const badAccepted = workspace(); badAccepted.watches[0].accepted_result_id = resultId(9); rejects(badAccepted);
  const revisit = workspace(); revisit.watches[0].reviews[0].decision = "revisit";
  assert.equal(parse(revisit).watches[0].accepted_result.status, "legacy-unclassified");
  const empty = parse(workspace(1, 0)); assert.equal(empty.watches[0].accepted_result_id, null);
  assert.equal(parse({ schema_version: 1, watches: [] }).watches.length, 0);
});

test("scope, private text, timestamps, results, and review shapes fail closed", () => {
  for (const patch of [{ revision: 0 }, { theme_id: "unsupported" }, { symbols: ["LITE", "lite"] },
    { stage_id: "chip" }, { question: " " }, { trigger: "a".repeat(601) }, { component: "a".repeat(101) }, { extra: true }]) {
    const input = workspace(); Object.assign(input.watches[0].scope, patch); rejects(input);
  }
  const optionalComponent = workspace(); delete optionalComponent.watches[0].scope.component;
  assert.equal(parse(optionalComponent).watches[0].private_context.component, "");
  for (const value of ["2026-02-30T00:00:00Z", "2026-10-11T24:00:00Z", "2026-10-11T00:00:00+00:00", 1]) {
    const input = workspace(); input.watches[0].saved_at = value; rejects(input);
    const review = workspace(); review.watches[0].reviews[0].reviewed_at = value; rejects(review);
  }
  for (const patch of [{ reason: " " }, { reason: "a".repeat(1201) }, { decision: "accept" }, { review_id: "invented" }]) {
    const input = workspace(); Object.assign(input.watches[0].reviews[0], patch); rejects(input);
  }
  for (const patch of [{ sources: [] }, { run_id: "invented" }, { created_at: "2026-02-30T00:00:00Z" }]) {
    const input = workspace(); Object.assign(input.watches[0].results[0], patch); rejects(input);
  }
  for (const patch of [{ schema_version: 2 }, { extra: true }, { watches: null }]) rejects({ ...workspace(), ...patch });
  const tooManyWatches = { schema_version: 1, watches: Array.from({ length: 31 }, () => watch()) }; rejects(tooManyWatches);
  const extraWatch = workspace(); extraWatch.watches[0].extra = true; rejects(extraWatch);
  for (const path of [[], ["watches", 0], ["watches", 0, "scope"], ["watches", 0, "reviews", 0]]) {
    const input = workspace(); let target = input; for (const key of path) target = target[key];
    for (const key of Object.keys(target)) {
      if (["component", "accepted_result_id"].includes(key)) continue;
      const missing = structuredClone(input); let entry = missing; for (const item of path) entry = entry[item];
      delete entry[key]; rejects(missing);
    }
  }
});

test("the optional theme watch retains its actual legacy shape and complete history", () => {
  const input = workspace(); input.watches[0].legacy_watch = themeWatch();
  input.watches[0].legacy_watch.history = Array.from({ length: 120 }, () => structuredClone(themeWatch().history[0]));
  assert.deepEqual(parse(input).watches[0].legacy_watch, input.watches[0].legacy_watch);
  for (const patch of [{ theme_id: "optical_cpo" }, { schema_version: 2 }, { question: " " }, { companies: ["a".repeat(31)] },
    { baseline: { pack_id: "p", version: "v", extra: true } }, { saved_at: "2026-02-30T00:00:00Z" }, { extra: true }]) {
    const bad = workspace(); bad.watches[0].legacy_watch = { ...themeWatch(), ...patch }; rejects(bad);
  }
  for (const patch of [{ kind: "import" }, { decision: "accept" }, { question: "a".repeat(601) },
    { reviewed_at: "2026-10-11T00:60:00Z" }, { from_version: null }, { extra: true }]) {
    const bad = workspace(); bad.watches[0].legacy_watch = themeWatch(); Object.assign(bad.watches[0].legacy_watch.history[0], patch); rejects(bad);
  }
});

test("raw input must be UTF-8 bytes within the 2 MB archive limit", () => {
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from([0xff]), Buffer.from("{"), new Uint8Array(), "{}", {}, null,
    Buffer.alloc(LEGACY_WORKSPACE_MAX_BYTES + 1)]) {
    assert.throws(() => parseLegacyWorkspace(bytes), { code: "LEGACY_WORKSPACE_INVALID" });
  }
  const valid = Buffer.from(JSON.stringify({ schema_version: 1, watches: [] }));
  const boundary = Buffer.concat([valid, Buffer.alloc(LEGACY_WORKSPACE_MAX_BYTES - valid.length, 32)]);
  assert.equal(parseLegacyWorkspace(boundary).raw_bytes.length, LEGACY_WORKSPACE_MAX_BYTES);
  const backing = Buffer.concat([Buffer.from("before"), valid, Buffer.from("after")]);
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 6, valid.length);
  assert.deepEqual(parseLegacyWorkspace(view).raw_bytes, valid);
});
