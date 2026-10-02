import { createHash } from "node:crypto";

function stableValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, stableValue(object[key])]));
  }
  throw new Error("The delivery contains a value that JSON cannot represent.");
}

// Match the seller's hash contract. Receipt and task IDs are not part of the research payload.
export function deliveryOutputHash(result: Record<string, unknown>): string {
  const payload = { capability_id: result.capability_id, capability_version: result.capability_version,
    input_scope: result.input_scope, research_pack: result.research_pack };
  return createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex");
}

export function hasMatchingDeliveryIntegrity(result: Record<string, unknown>, transaction: string): boolean {
  try {
    const receipt = result.receipt as Record<string, unknown> | undefined;
    return result.output_hash === deliveryOutputHash(result)
      && receipt?.transaction_reference === transaction
      && typeof receipt.settled_at === "string"
      && Number.isFinite(Date.parse(receipt.settled_at));
  } catch { return false; }
}
