import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'demo' && drill === 'drill' }; });
import CourseShell from "./CourseShell";

const manifest = { id: "demo", title: "Demo Course", chapters: [{ id: "chapter-1", title: "Chapter One", drills: [{ contentType: "reading", id: "drill", title: "Drill", kind: "logic", estMinutes: 5, sourcePath: "drills/demo/drill.ts", outlinePath: "outlines/demo/drill.json", instructions: "Build it." }] }] };
const response = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/courses"
    ? response([{ id: "demo", title: "Demo Course", chapterCount: 1, drillCount: 1 }])
    : url === "/api/courses/demo" ? response(manifest) : response({})));
  document.documentElement.removeAttribute("data-mantine-color-scheme");
  localStorage.clear();
});

describe("theme persistence", () => {
  it("stores the choice under the key the pre-paint script reads", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<MantineProvider defaultColorScheme="auto"><CourseShell /></MantineProvider>);
    await user.click(await screen.findByRole("button", { name: "Sidebar and theme controls" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));

    // index.html reads this exact key before the bundle loads to avoid a light flash.
    // If Mantine's storage key ever changes, that script silently stops working, so
    // pin the contract here rather than trusting the two to stay in sync.
    expect(localStorage.getItem("mantine-color-scheme-value")).toBe("dark");

    unmount();
    render(<MantineProvider defaultColorScheme="auto"><CourseShell /></MantineProvider>);
    await screen.findByRole("button", { name: "Sidebar and theme controls" });
    expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "dark");
  });
});
