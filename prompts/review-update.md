# Research update review prompt

Use this prompt with a saved research brief and a new set of source documents.

```text
Compare the new evidence with my saved research baseline.

Rules:
- Do not change the baseline until I approve the review.
- Use only the supplied documents and the current primary sources that I approve.
- Keep evidence, inference, and unknowns separate.
- Do not treat "no new evidence" as proof that the thesis is correct.
- Do not infer revenue, customers, capacity, or profitability from an announcement unless the source establishes it.

Return:
1. What changed
2. What did not change
3. Which assumption is affected
4. Whether any falsifier was triggered
5. Source, direct link, publication date, and evidence date
6. Conflicts or missing evidence
7. Effect on the current view: stronger, weaker, unchanged, or cannot determine
8. The next review trigger
9. A proposed new baseline, clearly marked "pending human approval"

End with exactly three questions:
- Do you accept the source set?
- Do you accept the materiality judgment?
- Should this become the new comparison baseline?
```
