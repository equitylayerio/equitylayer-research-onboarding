const RESEARCH_TOOLS = ["get_service_status", "begin_research", "resolve_company_tracker", "get_research_update", "finalize_research"];

// Tool discovery does not prove source coverage, result quality, or execution.
export function inspectCompatibility(endpoint, listing) {
  if (!Array.isArray(listing?.tools) || listing.tools.some(tool => typeof tool?.name !== "string")) {
    throw new Error("The server returned an invalid tool list.");
  }
  const available = new Set(listing.tools.map(tool => tool.name));
  const missing = RESEARCH_TOOLS.filter(name => !available.has(name));
  return {
    endpoint,
    check: "tool_discovery_only",
    research_tools_available: missing.length === 0,
    missing_research_tools: missing,
    instrument_mapping_available: available.has("resolve_trading_instrument"),
    research_execution_verified: false,
    payment_verified: false,
    next_step: missing.length
      ? "Stop. Use an updated EquityLayer server. Payment or sign-in will not add missing tools."
      : "Read the tool schemas. Run the research workflow and review its evidence before you accept a result.",
  };
}
