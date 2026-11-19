import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'book' && ['d1', 'd2'].includes(drill) }; });
import CourseShell from "./CourseShell";

const manifest = { id: "book", title: "Book", chapters: [
  { id: "authored-first", title: "Authored First", drills: [{ contentType: "reading", id: "d1", title: "First drill", kind: "logic", estMinutes: 5, sourcePath: "drills/book/a.ts", outlinePath: "outlines/book/d1.json", instructions: "A" }] },
  { id: "ranked-first", title: "Ranked First", drills: [{ contentType: "reading", id: "d2", title: "Second drill", kind: "logic", estMinutes: 5, sourcePath: "drills/book/b.ts", outlinePath: "outlines/book/d2.json", instructions: "B" }] },
] };
const response = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe("CourseShell chapter ranking", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/courses") return response([{ id: "book", title: "Book", chapterCount: 2, drillCount: 2 }]);
      if (url === "/api/courses/book") return response(manifest);
      if (url === "/api/progress/book") return response({});
      if (url === "/api/book-chapter-rank/book") return response({ "ranked-first": 0 });
      if (url === "/api/books") return response([]);
      if (url === "/api/test-results") return response({ available: false });
      return response({});
    }));
  });

  it("places ranked chapters ahead of authored order", async () => {
    render(<MantineProvider><CourseShell /></MantineProvider>);
    await screen.findByText("Ranked First");
    const papers = Array.from(document.querySelectorAll("nav [data-with-border]"));
    expect(papers.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Ranked First").compareDocumentPosition(screen.getByText("Authored First")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
