import { constants, openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "./run-contract.mjs";
import { verifySourceReference } from "./reference-bridge.mjs";
import { verifyEventFacts } from "./source-event-plan.mjs";
import { ScheduleError } from "./schedule-contract.mjs";

const fail = (code, message) => { throw new ScheduleError(code, message); };
const privateFile = (info) => info.isFile() && info.uid === process.getuid() && info.nlink === 1 && (info.mode & 0o077) === 0;

// The caller's connector supplies immutable records. This reader grants no source rights.
export function readRetainedFeed(config) {
  const directory = config.feed.directory;
  let info;
  try { info = lstatSync(directory); }
  catch { fail("FEED_DIRECTORY_MISSING", "Create the private retained feed directory."); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0 || realpathSync(directory) !== directory) {
    fail("FEED_PATH_UNSAFE", "Use a private owned feed directory without links.");
  }
  const names = readdirSync(directory);
  if (names.some(name => !/^[a-f0-9]{64}\.json$/.test(name)) || names.length > config.max_events) {
    fail("FEED_BATCH_LIMIT", "Use a bounded batch of immutable hash-named feed files.");
  }
  const records = []; let totalBytes = 0;
  for (const name of names.sort()) {
    const path = join(directory, name); let descriptor;
    try {
      const before = lstatSync(path);
      totalBytes += before.size;
      if (totalBytes > 16_000_000) fail("FEED_BATCH_LIMIT", "Use at most sixteen million bytes per retained feed batch.");
      if (!privateFile(before) || before.isSymbolicLink() || before.size > 4_000_000) fail("FEED_FILE_UNSAFE", "Use bounded owned feed files with private permissions.");
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(descriptor);
      if (!privateFile(opened) || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mode !== before.mode) {
        fail("FEED_FILE_UNSAFE", "The feed file changed before reading.");
      }
      const buffer = Buffer.alloc(4_000_001); let length = 0;
      while (length < buffer.length) {
        const amount = readSync(descriptor, buffer, length, buffer.length - length, length);
        if (!amount) break; length += amount;
      }
      if (length > 4_000_000) fail("FEED_FILE_UNSAFE", "The feed file exceeds its size limit.");
      let record;
      try { record = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))); }
      catch { fail("FEED_RECORD_INVALID", "Use a valid UTF-8 JSON feed record."); }
      if (!record || Array.isArray(record) || Object.keys(record).sort().join() !== "artifact,event,facts,raw_base64,schema_version" || record.schema_version !== 1 ||
          typeof record.raw_base64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.raw_base64)) {
        fail("FEED_RECORD_INVALID", "Use the required source fields and canonical base64 bytes.");
      }
      const bytes = Buffer.from(record.raw_base64, "base64");
      if (bytes.length > 2_000_000 || bytes.toString("base64") !== record.raw_base64 || record.artifact?.source_id !== config.source_id) {
        fail("FEED_RECORD_INVALID", "Match the configured source and bounded retained bytes.");
      }
      verifySourceReference(record.event, record.artifact, bytes); verifyEventFacts(record.event, record.artifact, record.facts);
      if (name !== `${contentHash(record)}.json`) fail("FEED_HASH_CONFLICT", "The feed record does not match its immutable filename.");
      records.push({ event: record.event, artifact: record.artifact, facts: record.facts, bytes });
    } catch (error) {
      if (error instanceof ScheduleError) throw error;
      fail("FEED_RECORD_INVALID", "Preserve the invalid feed record before recovery.");
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  // Event intake uses period and lineage context, not directory traversal order.
  return records.sort((a, b) => Date.parse(a.event.observed_at) - Date.parse(b.event.observed_at) || a.event.source_event_id.localeCompare(b.event.source_event_id));
}
