// Generated from EquityLayer lib/research-advice-core.ts. Do not edit the generated rules.
// Advice-shaped language only. Word boundaries keep ordinary research
// vocabulary (buyback, sell-side, sellers, reduced guidance) out of the net;
// the "-side" exclusion covers the sell-side / buy-side compounds.
export const PROHIBITED = new RegExp([
    String.raw `\b(?:target price|price target|position size|strong buy|strong sell|buy rating|sell rating)\b`,
    String.raw `\b(?:buy|sell)\b(?!-side)`,
    String.raw `\b(?:reduce|accumulate|trim|add to)\s+(?:the |your |my |a )?(?:position|exposure|stake|holding)s?\b`,
    String.raw `加碼|減碼|買進|賣出|目標價`,
].join("|"), "i");
/** Check advice phrases after the caller validates the field types. */
export function checkResearchAdviceFields(result) {
    const errors = [];
    for (const field of ["summary", "drivers", "falsifiers", "unknowns"]) {
        const value = result[field];
        const entries = typeof value === "string" ? [[field, value]] : value.map((text, index) => [`${field}[${index}]`, text]);
        for (const [path, text] of entries) {
            const match = text.match(PROHIBITED);
            if (match)
                errors.push({ path, message: `Remove the prohibited phrase: ${match[0]}.` });
        }
    }
    return errors;
}
