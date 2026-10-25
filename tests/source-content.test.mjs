import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildRetainedSourceContent, verifyRetainedSourceContent, SOURCE_CONTENT_LIMIT } from "../client/local/source-content.mjs";
import { verifySourceReference } from "../client/local/reference-bridge.mjs";
import { source } from "./fixtures/local-research.mjs";

function retained(body = '{"value":1}', type = "application/json", overrides = {}) {
  const record = source(); const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  record.bytes = bytes;
  record.artifact = { ...record.artifact, content_type: type, byte_length: bytes.length,
    artifact_sha256: createHash("sha256").update(bytes).digest("hex"), ...overrides };
  record.reference = verifySourceReference(record.event, record.artifact, bytes);
  return record;
}

for (const [body, type] of [['{"營收":12}', "application/json; charset=utf-8"], ["Evidence", "text/plain; charset = utf-8"], ["\ufeff{\"value\":1}", "application/json"],
  ["<html><script>Do not execute this data.</script><p>Revenue 12.</p></html>", "text/html"],
  ["company,revenue\r\nsynthetic,12\r\n", "text/csv"], ["Evidence\nCounterevidence\tUnknown", "text/plain; charset=\"UTF-8\""]]) {
  test(`${type} preserves every retained UTF-8 byte without rendering or truncation`, () => {
    const record = retained(body, type); const content = buildRetainedSourceContent(record);
    assert.equal(content.status, "included"); assert.equal(content.coverage, "complete_retained_artifact");
    assert.deepEqual(Buffer.from(content.text), record.bytes);
    assert.deepEqual(verifyRetainedSourceContent({ ...record, source_content: content }), content);
  });
}

for (const [body, type, overrides, reason] of [
  ["", "text/plain", {}, "EMPTY_SOURCE"], ["Not found", "text/plain", { http_status: 404 }, "HTTP_STATUS_UNSUPPORTED"],
  ["%PDF-1.7", "application/pdf", {}, "UNSUPPORTED_MEDIA_TYPE"],
  [Buffer.from([0xc3, 0x28]), "text/plain", {}, "INVALID_UTF8"],
  [Buffer.from([0, 1, 2]), "text/plain", {}, "BINARY_CONTENT"],
  ["text", "text/plain; charset=big5", {}, "UNSUPPORTED_CHARSET"],
  ["text", "text/plain; charset = big5", {}, "UNSUPPORTED_CHARSET"],
  ["text", "text/plain; charset*=big5", {}, "UNSUPPORTED_CHARSET"],
  ["text", "text/plain; charset", {}, "UNSUPPORTED_CHARSET"],
  ["%PDF-1.7", "text/plain", {}, "UNSUPPORTED_MEDIA_TYPE"],
  ["中文", "text/plain; charset=us-ascii", {}, "UNSUPPORTED_CHARSET"],
  ["{}", "application/json; charset=utf-8; charset=utf-8", {}, "UNSUPPORTED_CHARSET"],
  ["not json", "application/json", {}, "INVALID_JSON"],
  [Buffer.alloc(SOURCE_CONTENT_LIMIT + 1, 65), "text/plain", {}, "SOURCE_CONTENT_LIMIT"],
]) test(`unreadable source records ${reason} without supplying partial text`, () => {
  const record = retained(body, type, overrides); const content = buildRetainedSourceContent(record);
  assert.equal(content.status, "unavailable"); assert.equal(content.reason, reason);
  assert.equal(content.coverage, "none"); assert.equal(Object.hasOwn(content, "text"), false);
  assert.deepEqual(verifyRetainedSourceContent({ ...record, source_content: content }), content);
});

test("changed raw bytes, text, coverage, extra fields, and hashes cannot claim retained content", () => {
  const record = retained(); const content = buildRetainedSourceContent(record);
  assert.throws(() => buildRetainedSourceContent({ ...record, bytes: Buffer.from("different") }));
  for (const patch of [{ text: "Different" }, { coverage: "excerpt" }, { extra: "unbound" }, { artifact_sha256: "a".repeat(64) }]) {
    assert.throws(() => verifyRetainedSourceContent({ ...record, source_content: { ...content, ...patch } }));
  }
  const unavailable = buildRetainedSourceContent(retained("%PDF-1.7", "application/pdf"));
  assert.throws(() => verifyRetainedSourceContent({ ...retained("%PDF-1.7", "application/pdf"), source_content: { ...unavailable, text: "Invented" } }));
});

test("unavailable coverage still validates the source metadata and pinned reference", () => {
  const record = retained("%PDF-1.7", "application/pdf");
  const source_content = buildRetainedSourceContent(record);
  for (const changed of [
    { ...record, source_content, reference: undefined },
    { ...record, source_content, reference: { ...record.reference, source_event_sha256: "f".repeat(64) } },
    { ...record, source_content, event: { ...record.event, source_artifact_id: "different" } },
    { ...record, source_content, artifact: { ...record.artifact, content_type: null } },
    { ...record, artifact: { ...record.artifact, byte_length: -1 }, source_content: { ...source_content, byte_length: -1 } },
  ]) assert.throws(() => verifyRetainedSourceContent(changed), { code: "SOURCE_CONTENT_INVALID" });
});
