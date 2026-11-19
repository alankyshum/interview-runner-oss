import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'demo' && drill === 'drill' }; });
import CourseShell from "./CourseShell";

const manifest = { id: "demo", title: "Demo Course", chapters: [{ id: "chapter-1", title: "Chapter One", drills: [{ contentType: "reading", id: "drill", title: "Drill", kind: "logic", estMinutes: 5, sourcePath: "drills/demo/drill.tsx", outlinePath: "outlines/demo/drill.json", instructions: "Build it." }] }] };
const response = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/api/courses" ? response([{ id: "demo", title: "Demo Course", chapterCount: 1, drillCount: 1 }]) : url === "/api/courses/demo" ? response(manifest) : response({})));
  document.documentElement.removeAttribute("data-mantine-color-scheme");
  localStorage.clear();
});

describe("CourseShell theme control", () => {
  it("shows accessible System, Light, and Dark choices", async () => {
    const user = userEvent.setup();
    render(<MantineProvider defaultColorScheme="auto"><CourseShell /></MantineProvider>);
    await user.click(await screen.findByRole("button", { name: "Sidebar and theme controls" }));
    const system = await screen.findByRole("menuitemradio", { name: "System" });
    expect(system).toHaveAttribute("data-testid", "theme-persistent");
    expect(system).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Light" })).toHaveAttribute("aria-checked", "false");
    const library = screen.getByRole("menuitemcheckbox", { name: /Hide library/ });
    library.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toHaveAttribute("role", "menuitemcheckbox");
    await user.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "light");
    expect(screen.getByRole("menuitemradio", { name: "Light" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: "Dark" }));
    expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "dark");
    await user.click(screen.getByRole("menuitemradio", { name: "System" }));
    expect(document.documentElement.getAttribute("data-mantine-color-scheme")).toMatch(/light|dark/);
  });

  it("switches the document between dark and light", async () => {
    const user = userEvent.setup();
    render(<MantineProvider defaultColorScheme="auto"><CourseShell /></MantineProvider>);
    await user.click(await screen.findByRole("button", { name: "Sidebar and theme controls" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
    expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "dark");
    await user.click(screen.getByRole("menuitemradio", { name: "Light" }));
    expect(document.documentElement).toHaveAttribute("data-mantine-color-scheme", "light");
  });
});
