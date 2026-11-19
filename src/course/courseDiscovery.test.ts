import { describe, expect, it } from "vitest";
import { discoverCourses, readCourseSort } from "./courseDiscovery";

const courses = [
  { id: "z", title: "Zulu", company: "Acme", role: "Designer", createdAt: "2025-01-01", updatedAt: "2025-02-01" },
  { id: "a", title: "alpha", company: "Beta", role: "Engineer", createdAt: "2025-02-01", updatedAt: "2025-01-01" },
  { id: "legacy", title: "Legacy" },
];

describe("course discovery", () => {
  it("restores a valid saved sort and defaults invalid storage to updated", () => {
    expect(readCourseSort(() => "alphabetical")).toBe("alphabetical");
    expect(readCourseSort(() => "created")).toBe("created");
    expect(readCourseSort(() => "unsupported")).toBe("updated");
    expect(readCourseSort(() => null)).toBe("updated");
  });
  it("filters trimmed, case-insensitive title, company, and role", () => {
    expect(discoverCourses(courses, "  aCmE ", "updated").map(({ id }) => id)).toEqual(["z"]);
    expect(discoverCourses(courses, "ENGINEER", "updated").map(({ id }) => id)).toEqual(["a"]);
    expect(discoverCourses(courses, " missing ", "updated")).toEqual([]);
  });
  it("matches full multiword tags case-insensitively without regressing title search", () => {
    const tagged = [{ id: "book", title: "Distributed Systems", tags: ["System Design", "Interview Prep"] }];
    expect(discoverCourses(tagged, "system design", "updated").map(({ id }) => id)).toEqual(["book"]);
    expect(discoverCourses(tagged, "INTERVIEW PREP", "updated").map(({ id }) => id)).toEqual(["book"]);
    expect(discoverCourses(tagged, "distributed", "updated").map(({ id }) => id)).toEqual(["book"]);
  });
  it("matches every normalized search word in any order across fields", () => {
    const atlas = [{ id: "atlas", title: "System Design Interview Atlas", company: "Initrode", tags: ["Architecture"] }];
    for (const query of ["system design atlas", "SYSTEM atlas", "atlas system", "initrode system design", "ＡＴＬＡＳ architecture"]) {
      expect(discoverCourses(atlas, query, "updated").map(({ id }) => id)).toEqual(["atlas"]);
    }
    expect(discoverCourses(atlas, "system atlas missing", "updated")).toEqual([]);
  });
  it("sorts timestamps newest first and alphabetically with stable ties", () => {
    expect(discoverCourses(courses, "", "created").map(({ id }) => id)).toEqual(["a", "z", "legacy"]);
    expect(discoverCourses(courses, "", "updated").map(({ id }) => id)).toEqual(["z", "a", "legacy"]);
    expect(discoverCourses([{ id: "b", title: "Same" }, { id: "a", title: "same" }], "", "alphabetical").map(({ id }) => id)).toEqual(["a", "b"]);
  });
});
