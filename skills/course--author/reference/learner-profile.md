# Learner profile for authored material

Adapt explanations to the learner's goals. To build intuition, take ideas apart, explain why, and mentally move through the mechanics rather than relying on memorized formulas, offsets, or snippets. Apply this to course explanations, notes, lessons, study guides, and cheatsheets when useful.

## Authoring rules

- For each taught pattern or lesson, state the invariant (or the core principle that remains true for a non-algorithmic concept) and a concrete cause → effect **why it works** chain before explanatory pseudo-logic. Derive formulas and decisions from their assumptions; show what breaks if a key assumption changes.
- Justify every index offset and boundary in context, including `i-1`, `m+1`, and half-open ranges: say what positions or counts represent and why the endpoint or extra slot is needed. Never leave an offset as a rule to memorize.
- For each DP, grid, or pointer technique, give a physical walk-through: where the cursor stands, which direction it moves, what it inspects, and how information changes. Trace a concrete example step by step, including a relevant boundary. For other mechanisms, use a physical or spatial analogy when it clarifies the flow. Diagrams and images should show movement and data flow when applicable.
- In explanations use intent-named, Python-style pseudo-logic blocks highlighted as `python`, not language-specific code snippets. Keep runnable drill solutions, seeds, tests, and required signatures in their required language; preserve verbatim source when explicitly required. Do not solve an exercise in its prompt or hints: use a distinct illustrative example when needed, and keep hints non-revealing.

## Acceptance checks

Before delivery, check each taught pattern or lesson for its invariant/principle and causal why-chain; check each offset and boundary has a concrete justification; and check every DP/grid/pointer technique has a stepwise physical trace with a boundary. Check visual flows show movement/data where relevant and explanatory blocks are Python-highlighted pseudo-logic, while runnable contracts and non-revealing hints remain intact. Fix any missing applicable item.
