export const secFeed = () => ({ kind: "sec_submissions_api", cik: "0000000001", symbol: "LITE", user_agent: "SyntheticFixture tests@example.test" });
export const secAt = "2026-10-12T00:00:00.000Z";
export function secData() {
  return { cik: "0000000001", tickers: ["LITE"], name: "Synthetic issuer, not a real SEC mapping", filings: { recent: {
    accessionNumber: ["0000000001-26-000001"], form: ["10-Q"], filingDate: ["2026-10-10"], reportDate: ["2026-09-30"],
    acceptanceDateTime: ["2026-10-10T18:00:00.000Z"], primaryDocument: ["synthetic-q3.htm"] } } };
}
export const secBytes = data => Buffer.from(JSON.stringify(data ?? secData()));
export function secResponse(bytes = secBytes(), overrides = {}) {
  const body = new Response(bytes, { headers: { "content-type": "application/json" } });
  return { ok: true, status: 200, url: "https://data.sec.gov/submissions/CIK0000000001.json", body: body.body, headers: body.headers, ...overrides };
}
