export const TWSE_MONTHLY_SOURCE_ID = "twse_listed_monthly_revenue_v1";
export const TWSE_MONTHLY_API = "https://openapi.twse.com.tw/v1/opendata/t187ap05_L";
export const TWSE_LOCAL_VERSION = "twse-local-monthly-1.0.0";

export function twseExpectedReportingPeriod(evaluationTime) {
  const taipei = new Date(evaluationTime + 8 * 3600000);
  return new Date(Date.UTC(taipei.getUTCFullYear(), taipei.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

// The local monitor requires the previous completed Taipei calendar month.
// This rule does not assert a release deadline or prove the latest source release.
export function twseReportingPeriodGate(event, artifact, evaluationTime) {
  if (artifact.source_id !== TWSE_MONTHLY_SOURCE_ID || artifact.canonical_url !== TWSE_MONTHLY_API ||
      event.adapter_version !== TWSE_LOCAL_VERSION || event.parser_version !== TWSE_LOCAL_VERSION) return null;
  const expected = twseExpectedReportingPeriod(evaluationTime);
  if (artifact.source_period === null || artifact.source_period < expected) return "STALE_REPORTING_PERIOD";
  if (artifact.source_period > expected) return "SOURCE_TIME_CONFLICT";
  return null;
}
