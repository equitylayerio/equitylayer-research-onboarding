import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson, contentHash } from "./run-contract.mjs";
import { verifySourceReference, verifySourceMetadataReference } from "./reference-bridge.mjs";

export const SOURCE_CONTENT_LIMIT = 2_000_000;
export const SOURCE_CONTENT_RENDERER_SHA256 = contentHash(readFileSync(new URL(import.meta.url), "utf8"));
const supported = new Set(["application/json", "application/ld+json", "application/xml", "text/plain", "text/csv", "text/html", "text/xml"]);
const reasons = new Set(["HTTP_STATUS_UNSUPPORTED", "EMPTY_SOURCE", "SOURCE_CONTENT_LIMIT", "UNSUPPORTED_MEDIA_TYPE",
  "UNSUPPORTED_CHARSET", "INVALID_UTF8", "BINARY_CONTENT", "INVALID_JSON"]);
export class SourceContentError extends Error {
  constructor() { super("The retained source content does not match its declared coverage."); this.name = "SourceContentError"; this.code = "SOURCE_CONTENT_INVALID"; }
}
const fail = () => { throw new SourceContentError(); };

// Preserve exact retained text. Do not render HTML, fetch links, or invent missing content.
export function buildRetainedSourceContent(source) {
  verifySourceReference(source.event, source.artifact, source.bytes, source.reference);
  const artifact = source.artifact, bytes = Buffer.from(source.bytes);
  const base = { schema_version: 1, artifact_sha256: artifact.artifact_sha256, byte_length: artifact.byte_length };
  const unavailable = reason => ({ ...base, status: "unavailable", coverage: "none", reason });
  if (artifact.http_status < 200 || artifact.http_status > 299) return unavailable("HTTP_STATUS_UNSUPPORTED");
  if (!bytes.length) return unavailable("EMPTY_SOURCE");
  if (bytes.length > SOURCE_CONTENT_LIMIT) return unavailable("SOURCE_CONTENT_LIMIT");
  const parts = artifact.content_type.toLowerCase().split(";").map(part => part.trim());
  if (!supported.has(parts[0])) return unavailable("UNSUPPORTED_MEDIA_TYPE");
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return unavailable("UNSUPPORTED_MEDIA_TYPE");
  const declarations = parts.slice(1).filter(part => /^charset(?:\s|\*|=|$)/.test(part));
  const charsets = declarations.map(part => /^charset\s*=\s*(?:"([^"]+)"|([^\s";]+))$/.exec(part)).map(match => match?.[1] ?? match?.[2] ?? null);
  if (charsets.length > 1 || charsets.some(value => !["utf-8", "utf8", "us-ascii"].includes(value)) ||
      charsets.includes("us-ascii") && bytes.some(value => value > 127)) return unavailable("UNSUPPORTED_CHARSET");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return unavailable("INVALID_UTF8"); }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) return unavailable("BINARY_CONTENT");
  if (["application/json", "application/ld+json"].includes(parts[0])) {
    try { JSON.parse(text.replace(/^\ufeff/u, "")); } catch { return unavailable("INVALID_JSON"); }
  }
  return { ...base, status: "included", coverage: "complete_retained_artifact", encoding: "utf-8", text };
}

export function verifyRetainedSourceContent(source) {
  try {
    if (!source?.reference) fail();
    verifySourceMetadataReference(source.event, source.artifact, source.reference);
  } catch { fail(); }
  const content = source?.source_content;
  if (!content || content.schema_version !== 1 || content.artifact_sha256 !== source.artifact?.artifact_sha256 ||
      content.byte_length !== source.artifact.byte_length) fail();
  if (content.status === "unavailable") {
    if (Object.keys(content).sort().join() !== "artifact_sha256,byte_length,coverage,reason,schema_version,status" ||
        content.coverage !== "none" || !reasons.has(content.reason)) fail();
    return content;
  }
  if (typeof content.text !== "string" || Buffer.byteLength(content.text) > SOURCE_CONTENT_LIMIT) fail();
  const bytes = Buffer.from(content.text, "utf8");
  if (createHash("sha256").update(bytes).digest("hex") !== content.artifact_sha256) fail();
  const expected = buildRetainedSourceContent({ ...source, bytes });
  if (canonicalJson(expected) !== canonicalJson(content) || expected.status !== "included") fail();
  return content;
}
