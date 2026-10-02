import { describe, expect, it } from "vitest";
import { deliveryOutputHash, hasMatchingDeliveryIntegrity } from "./delivery-integrity.js";

function payload() {
  return { capability_id: "test", capability_version: "v1", input_scope: { symbols: ["TEST"] },
    research_pack: { value: 1, missing: null, verified: false, name: "測試" } };
}

describe("delivery integrity", () => {
  it("ignores object key order and receipt metadata, but preserves array order", () => {
    const original = payload();
    const reordered = { ...original, research_pack: { name: "測試", verified: false, missing: null, value: 1 }, task_id: "task" };
    expect(deliveryOutputHash(reordered)).toBe(deliveryOutputHash(original));
    expect(deliveryOutputHash({ ...original, input_scope: { symbols: ["A", "B"] } }))
      .not.toBe(deliveryOutputHash({ ...original, input_scope: { symbols: ["B", "A"] } }));
    expect(deliveryOutputHash({ ...original, research_pack: { value: -0 } }))
      .toBe(deliveryOutputHash({ ...original, research_pack: { value: 0 } }));
  });

  it.each([undefined, NaN, Infinity, BigInt(1)])("rejects values that JSON cannot represent: %s", (value) => {
    const result = { ...payload(), research_pack: { value } };
    expect(() => deliveryOutputHash(result)).toThrow();
    expect(hasMatchingDeliveryIntegrity(result, "tx")).toBe(false);
  });

  it("requires a matching hash, transaction, and settlement date", () => {
    const result = { ...payload(), output_hash: deliveryOutputHash(payload()),
      receipt: { transaction_reference: "tx", settled_at: "2026-10-01T00:00:00Z" } };
    expect(hasMatchingDeliveryIntegrity(result, "tx")).toBe(true);
    expect(hasMatchingDeliveryIntegrity(result, "other")).toBe(false);
    expect(hasMatchingDeliveryIntegrity({ ...result, receipt: undefined }, "tx")).toBe(false);
    expect(hasMatchingDeliveryIntegrity({ ...result, receipt: { transaction_reference: "tx", settled_at: 1 } }, "tx")).toBe(false);
    expect(hasMatchingDeliveryIntegrity({ ...result, output_hash: "0".repeat(64) }, "tx")).toBe(false);
  });
});
