# AI-assisted coding rubric

Score every dimension from **1–4** and cite concrete evidence from the interview, tests, and diffs: **1** harmful or absent, **2** inconsistent, **3** effective, **4** exemplary and adaptive.

## Dimensions

1. **Decomposition** — breaks each requirement into small, verifiable changes.
2. **AI steering** — gives the AI precise context and constraints, then redirects it when needed.
3. **Diff review** — explains and critically reviews every AI-produced diff before accepting it.
4. **Tests-first** — turns behavior and edge cases into tests before or alongside implementation.
5. **Correctness under change** — preserves prior behavior and adapts the design as stages change.
6. **Readable code** — leaves cohesive, appropriately named, maintainable code.
7. **Communication** — states assumptions, rationale, trade-offs, and uncertainty clearly while pairing.

For each dimension report `score: 1–4` and `evidence:`. End with strengths, improvements, and an overall recommendation.
