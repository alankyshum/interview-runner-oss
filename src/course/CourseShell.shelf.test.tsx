import { MantineProvider } from "@mantine/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'book' && drill === 'd1' || course === 'practice' && drill === 'd2' }; });
import CourseShell from "./CourseShell";

const courses = [
  { id: "book", title: "Systems Book", chapterCount: 1, drillCount: 1 },
  { id: "practice", title: "Practice Course", chapterCount: 1, drillCount: 1 },
];
const manifests = {
  book: { id: "book", title: "Systems Book", chapters: [{ id: "c1", title: "Book Chapter", drills: [{ contentType: "reading", id: "d1", title: "Reading", kind: "logic", estMinutes: 10, sourcePath: "reading/book/book.ts", outlinePath: "outlines/book/d1.json", instructions: "Read." }] }] },
  practice: { id: "practice", title: "Practice Course", chapters: [{ id: "p1", title: "Practice Chapter", drills: [{ contentType: "reading", id: "d2", title: "Practice", kind: "logic", estMinutes: 10, sourcePath: "drills/practice/practice.ts", outlinePath: "outlines/practice/d2.json", instructions: "Practice." }] }] },
};
const response = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));

describe("CourseShell shelf", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/?course=book");
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/courses") return response(courses);
      const match = url.match(/^\/api\/courses\/([^/]+)$/);
      if (match) return response(manifests[decodeURIComponent(match[1]) as keyof typeof manifests]);
      if (url === "/api/books") return response([{ id: "book", title: "Systems Book", status: "reading" }]);
      if (url.startsWith("/api/progress/")) return response({});
      if (url === "/api/book-chapter-rank/book" || url === "/api/book-chapter-rank/practice") return response({});
      if (url === "/api/test-results") return response({ available: false });
      if (init?.method === "PUT") return response({ status: "archived", updatedAt: "2026-01-01T00:00:00.000Z" });
      return response({});
    }));
  });

  it("keeps a non-book course selectable when a book exists", async () => {
    render(<MantineProvider><CourseShell /></MantineProvider>);
    await screen.findByText("Book Chapter");
    const library = await screen.findByRole("navigation", { name: "Library" });
    await userEvent.click(within(library).getByRole("button", { name: /^Practice Course .*drills complete/ }));
    expect(await screen.findByText("Practice Chapter")).toBeInTheDocument();
  });

  it("does not render legacy archive controls in the main pane", async () => {
    render(<MantineProvider><CourseShell /></MantineProvider>);
    await screen.findByText("Book Chapter");
    expect(screen.queryByRole("button", { name: /archive book/i })).not.toBeInTheDocument();
  });
});
