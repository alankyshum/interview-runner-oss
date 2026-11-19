import { MantineProvider } from "@mantine/core";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'book' && drill === 'd1' }; });
import CourseShell from "./CourseShell";

const courses = [{ id: "book", title: "Systems Book", chapterCount: 1, drillCount: 1 }];
const manifest = { id: "book", title: "Systems Book", chapters: [{ id: "c1", title: "Chapter One", drills: [{ contentType: "reading", outlinePath: "outlines/book/d1.json", id: "d1", title: "Read chapter", kind: "logic", estMinutes: 20, sourcePath: "reading/book/book.ts", instructions: "Read it." }] }] };
const outline = { courseId: "book", drillId: "d1", title: "Chapter One", nodes: [{ id: "overview", type: "claim", text: "Overview" }] };
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

describe("CourseShell book reader integration", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, "", "/?course=book");
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/courses") return response(courses);
      if (url === "/api/courses/book") return response(manifest);
      if (url === "/api/books") return response([{ id: "book", title: "Systems Book", status: "reading" }]);
      if (url === "/api/progress/book") return response({});
      if (url === "/api/outlines/book/d1") return response(outline);
      if (url === "/api/outline-state/book/d1") return response({});
      if (url === "/api/book-chapter-rank/book") return response({});
      if (url === "/api/test-results") return response({ available: false });
      if (init?.method === "PUT") return response({ status: "in-progress", updatedAt: "2026-01-01T00:00:00.000Z" });
      return response({});
    }));
  });

  it("writes progress at most once when a chapter reader mounts", async () => {
    render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByTestId("outline-reader")).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const writes = vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/progress/book/d1" && init?.method === "PUT");
    expect(writes.length).toBeLessThanOrEqual(1);
  });

  it("does not automatically overwrite blocked reader progress", async () => {
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/courses") return response(courses);
      if (url === "/api/courses/book") return response(manifest);
      if (url === "/api/books") return response([{ id: "book", title: "Systems Book", status: "reading" }]);
      if (url === "/api/progress/book") return response({ d1: { status: "blocked", updatedAt: "2026-10-21T00:00:00.000Z" } });
      if (url === "/api/outlines/book/d1") return response(outline);
      if (url === "/api/outline-state/book/d1" || url === "/api/book-chapter-rank/book") return response({});
      if (url === "/api/test-results") return response({ available: false });
      if (init?.method === "PUT") return response({ status: "in-progress", updatedAt: "2026-10-21T00:00:01.000Z" });
      return response({});
    }));
    render(<MantineProvider><CourseShell /></MantineProvider>); expect(await screen.findByTestId("outline-reader")).toBeInTheDocument(); await new Promise((resolve) => setTimeout(resolve, 50));
    expect(vi.mocked(fetch).mock.calls.filter(([url, init]) => url === "/api/progress/book/d1" && init?.method === "PUT")).toHaveLength(0);
    expect(screen.getByRole("img", { name: "Blocked" })).toBeInTheDocument();
  });
});
