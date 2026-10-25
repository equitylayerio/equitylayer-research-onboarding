import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export const SOURCE_TEXT_PROJECTOR_SHA256 = hash(readFileSync(new URL(import.meta.url)));
const named = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", minus: "−", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥", cent: "¢", times: "×", divide: "÷",
  le: "≤", ge: "≥", ne: "≠", plusmn: "±", ensp: " ", emsp: " ", thinsp: " " });
const blocks = new Set(["p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer",
  "li", "ul", "ol", "dl", "dt", "dd", "blockquote", "caption", "hr", "br", "pre"]);
export class SourceProjectionError extends Error {
  constructor(code) { super(code); this.name = "SourceProjectionError"; this.code = code; }
}
const fail = () => { throw new SourceProjectionError("SESSION_READ_PROJECTION_UNAVAILABLE"); };

// This is a lexical HTML view, not browser rendering or financial table interpretation.
// Keep every text token except comments, scripts, and styles. Never fetch linked content.
export function projectSourceText(original, contentType) {
  if (contentType.toLowerCase().split(";")[0].trim() !== "text/html") return null;
  if (original.length > 2_000_000) fail();
  // Latin-1 retains one character per input byte for ASCII tag searches.
  const lexical = original.toString("latin1");
  const spans = [], parts = [], tables = [];
  const notes = { unknown_entities: 0, image_elements: 0, table_elements: 0, spanning_cells: 0,
    omitted_comments: 0, omitted_script_style_bytes: 0 };
  let length = 0, last = "", pre = false;
  function decode(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (whole, key) => {
      if (Object.hasOwn(named, key)) return named[key];
      if (key[0] === "#") {
        const n = key[1].toLowerCase() === "x" ? Number.parseInt(key.slice(2), 16) : Number(key.slice(1));
        if (Number.isSafeInteger(n) && n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) && n !== 127)
          return String.fromCodePoint(n);
      }
      notes.unknown_entities++; return whole;
    });
  }
  function emit(text, start, end) {
    if (!text) return;
    if (!pre && /^[ \t\n]$/.test(last) && text.startsWith(" ")) text = text.slice(1);
    if (!text || text === "\n" && last === "\n") return;
    const bytes = Buffer.from(text);
    if (length + bytes.length > 2_000_000 || spans.length >= 150000) fail();
    spans.push({ offset: length, end_offset: length + bytes.length, original_offset: start, original_end_offset: end });
    parts.push(bytes); length += bytes.length; last = text.at(-1);
  }
  function text(start, end) {
    const value = decode(original.toString("utf8", start, end));
    emit(pre ? value : value.replace(/[\t\n\r\f \u00a0]+/g, " "), start, end);
  }
  function tagEnd(start) {
    let quote = 0;
    for (let i = start + 1; i < original.length; i++) {
      const c = original[i];
      if (quote) { if (c === quote) quote = 0; }
      else if (c === 34 || c === 39) quote = c;
      else if (c === 62) return i + 1;
    }
    fail();
  }
  let cursor = 0;
  while (cursor < original.length) {
    const start = original.indexOf(60, cursor);
    if (start === -1) { text(cursor, original.length); break; }
    text(cursor, start);
    if (original.subarray(start, start + 4).toString() === "<!--") {
      const close = original.indexOf("-->", start + 4); if (close === -1) fail();
      notes.omitted_comments++; cursor = close + 3; continue;
    }
    const lead = original.subarray(start, Math.min(original.length, start + 80)).toString();
    if (!/^<\/?[a-z]/i.test(lead) && !/^<!doctype\b/i.test(lead)) { emit("<", start, start + 1); cursor = start + 1; continue; }
    const end = tagEnd(start), token = original.toString("utf8", start, end);
    cursor = end;
    if (/^<!doctype\b/i.test(token)) continue;
    const match = /^<(\/?)([a-z][a-z0-9:-]*)\b/i.exec(token); if (!match) fail();
    const closing = match[1] === "/", name = match[2].toLowerCase();
    if (["sup", "sub", "del", "ins", "s", "strike"].includes(name)) {
      emit(`[${closing ? "/" : ""}${name}]`, start, end); continue;
    }
    if (!closing && ["script", "style", "title", "textarea"].includes(name)) {
      const closingTag = new RegExp(`</${name}\\s*>`, "gi"); closingTag.lastIndex = end;
      const close = closingTag.exec(lexical);
      if (!close) fail();
      const closeStart = close.index;
      cursor = closingTag.lastIndex;
      if (name === "script" || name === "style") notes.omitted_script_style_bytes += cursor - start;
      else { text(end, closeStart); emit("\n", closeStart, cursor); }
      continue;
    }
    if (name === "img" && !closing) notes.image_elements++;
    if (name === "table") {
      if (closing) { if (!tables.length) fail(); tables.pop(); emit("\n[/table]\n", start, end); }
      else { tables.push({ cells: 0, inCell: false }); notes.table_elements++; emit("\n[table]\n", start, end); }
      continue;
    }
    if (["tr", "td", "th"].includes(name)) {
      const table = tables.at(-1); if (!table) fail();
      if (name === "tr") { table.inCell = false; table.cells = 0; emit("\n", start, end); }
      else if (closing) table.inCell = false;
      else {
        if (table.cells++) emit("\t", start, end);
        table.inCell = true;
        const attributes = [...token.slice(match[0].length, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)];
        const sizes = [];
        for (const key of ["colspan", "rowspan"]) {
          const entries = attributes.filter(entry => entry[1].toLowerCase() === key);
          if (entries.length > 1) fail();
          if (entries.length) {
            const value = decode(entries[0][2] ?? entries[0][3] ?? entries[0][4] ?? "").trim();
            if (!/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 1000) fail();
            if (Number(value) > 1) sizes.push(`${key}=${Number(value)}`);
          }
        }
        if (sizes.length) { notes.spanning_cells++; emit(`[${sizes.join(" ")}] `, start, end); }
      }
      continue;
    }
    if (name === "pre") pre = !closing;
    if (blocks.has(name)) emit(tables.at(-1)?.inCell ? " " : "\n", start, end);
  }
  if (tables.length) fail();
  const bytes = Buffer.concat(parts), text_sha256 = hash(bytes);
  const representation_sha256 = hash(JSON.stringify({ projector: SOURCE_TEXT_PROJECTOR_SHA256, text_sha256, spans, notes }));
  return { bytes, spans, descriptor: { status: "available_not_read", representation_sha256, text_sha256,
    projector_sha256: SOURCE_TEXT_PROJECTOR_SHA256, byte_length: bytes.length, format: "lexical_html_text_v1", notes,
    limitation: "Not browser rendering. CSS visibility and table alignment are not resolved. Unknown entities remain literal. Images and attributes are not transcribed. Inspect raw headers and footnotes for ambiguity." } };
}

export function sourceProjectionLocator(projection, original, start, end) {
  if (start === end) return null;
  const spans = projection.spans.filter(span => span.offset < end && span.end_offset > start);
  if (!spans.length) fail();
  const offset = spans[0].original_offset, end_offset = spans.at(-1).original_end_offset;
  return { coverage: "enclosing_raw_byte_range_not_quote_equivalence", offset, end_offset,
    sha256: hash(original.subarray(offset, end_offset)) };
}
