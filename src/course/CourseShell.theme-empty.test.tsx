import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CourseShell from "./CourseShell";

// A course whose only chapter has no drills, so nothing can be selected.
const manifest = { id: "demo", title: "Demo Course", chapters: [{ id: "chapter-1", title: "Chapter One", drills: [] }] };
const response = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/courses"
    ? response([{ id: "demo", title: "Demo Course", chapterCount: 1, drillCount: 0 }])
    : url === "/api/courses/demo" ? response(manifest) : response({})));
  document.documentElement.removeAttribute("data-mantine-color-scheme");
  localStorage.clear();
});

describe("theme control availability", () => {
  it("keeps a theme control outside the drill header, which only renders once a drill is selected", async () => {
    render(<MantineProvider defaultColorScheme="auto"><CourseShell /></MantineProvider>);
    await screen.findByRole("button", { name: "Sidebar and theme controls" });

    // jsdom applies no CSS, so `hiddenFrom`/`visibleFrom` markup renders at every
    // width and cannot be distinguished by visibility here. What IS assertable is
    // placement: a control that lives only inside the drill header disappears on a
    // course with nothing selected, which is the state every new course opens in.
    expect(screen.queryByTestId("drill-header")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sidebar and theme controls" })).toBeInTheDocument();
  });
});
