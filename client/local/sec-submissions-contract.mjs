export const SEC_SUBMISSIONS_VERSION = "sec-local-submissions-1.0.0";
export const SEC_SUBMISSIONS_METRIC = "sec.submissions.recent_financial_filings";
export const SEC_SUBMISSIONS_FORMS = Object.freeze(["10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "8-K/A", "20-F", "20-F/A", "6-K", "6-K/A", "40-F", "40-F/A"]);

export class SecSourceError extends Error {
  constructor(code, message) { super(message); this.name = "SecSourceError"; this.code = code; }
}
export const secFail = (code, message) => { throw new SecSourceError(code, message); };
export function secSourceId(cik) {
  if (typeof cik !== "string" || !/^\d{10}$/.test(cik) || /^0+$/.test(cik))
    secFail("SOURCE_CONFIG_INVALID", "Use the issuer's ten-digit CIK, including leading zeros.");
  return `sec_submissions_local_${cik}_v1`;
}
export function secSubmissionsUrl(cik) {
  secSourceId(cik);
  return `https://data.sec.gov/submissions/CIK${cik}.json`;
}
export function validateSecFeed(feed) {
  if (!feed || Object.keys(feed).sort().join() !== ["kind", "cik", "symbol", "user_agent"].sort().join() || feed.kind !== "sec_submissions_api")
    secFail("SOURCE_CONFIG_INVALID", "Use the fixed SEC feed fields only.");
  secSourceId(feed.cik);
  if (typeof feed.symbol !== "string" || !/^[A-Z][A-Z0-9.-]{0,29}$/.test(feed.symbol) || /\.(?:TW|TWO|T|KS)$/.test(feed.symbol))
    secFail("SOURCE_CONFIG_INVALID", "Select a canonical US-listed symbol for this SEC source.");
  if (typeof feed.user_agent !== "string" || feed.user_agent.length > 250 || !/^[A-Za-z][\x20-\x7e]{2,249}$/.test(feed.user_agent) ||
      !/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(feed.user_agent))
    secFail("SOURCE_CONFIG_INVALID", "Supply your application name and contact email for SEC requests. Do not include credentials.");
  return feed;
}

export const isSecSubmissionsEvent = (event, artifact) => event.parser_version === SEC_SUBMISSIONS_VERSION &&
  /^sec_submissions_local_\d{10}_v1$/.test(artifact.source_id);

// The intake transaction supplies its current retained head. A parser's earlier view is not authoritative.
export function secSubmissionsIndexGate(event, artifact, facts, previous) {
  if (!isSecSubmissionsEvent(event, artifact)) return null;
  const latest = values => {
    const selected = values?.filter(fact => fact.identity.metric_definition_id === SEC_SUBMISSIONS_METRIC);
    if (selected?.length !== 1 || selected[0].value_type !== "string") throw new Error("Invalid detector facts.");
    const filings = JSON.parse(selected[0].value);
    if (!Array.isArray(filings) || !filings.length || filings.length > 20) throw new Error("Invalid detector rows.");
    const dates = filings.map(row => row.accepted_at);
    if (dates.some(value => typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(value).toISOString() !== value))
      throw new Error("Invalid detector time.");
    return dates.sort().at(-1);
  };
  try {
    const current = latest(facts);
    if (Date.parse(current) > Date.parse(artifact.retrieved_at)) return "SOURCE_TIME_CONFLICT";
    if (previous?.artifact.source_id === artifact.source_id && previous.event.parser_version === SEC_SUBMISSIONS_VERSION && current < latest(previous.facts))
      return "SOURCE_SCHEMA_CHANGED";
    return null;
  } catch { return "SOURCE_SCHEMA_CHANGED"; }
}
