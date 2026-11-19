import { describe, expect, it } from "vitest";
import { questionCards } from "./questionCards";

describe("question cards", () => {
  it("groups consecutive leading context sections separately from the full spec", () => {
    const cards = questionCards("## Practice rules\nRules.\n\n## Why this is here\nContext.\n\n## Scenario\nSpec.\n\n### Build\nDetails.\n\n## Milestone 1\nDo it.");
    expect(cards.map((card) => card.kind)).toEqual(["context", "spec"]); expect(cards[0].markdown).toContain("Why this is here"); expect(cards[0].markdown).not.toContain("Scenario"); expect(cards[1].markdown).toContain("Scenario"); expect(cards[1].markdown).toContain("Milestone 1");
  });

  it("uses one spec card when context is absent or headings are absent", () => {
    expect(questionCards("## Scenario\nBuild it.")).toMatchObject([{ kind: "spec", heading: "Scenario" }]);
    expect(questionCards("Plain instructions without headings.")).toEqual([{ kind: "spec", markdown: "Plain instructions without headings." }]);
  });

  it("ignores heading-looking text inside fenced code", () => {
    const cards = questionCards("```md\n## Practice rules\n```\n\n## Scenario\nReal heading.");
    expect(cards).toHaveLength(1); expect(cards[0]).toMatchObject({ kind: "spec", heading: "Scenario", headingLine: 5 });
  });
});
