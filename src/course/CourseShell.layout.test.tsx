import { MantineProvider } from "@mantine/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CourseShell from "./CourseShell";

const courses = [
  { id: "example-course", title: "Example Course", chapterCount: 1, drillCount: 1 },
];

const longTitleDrill = { contentType: "coding",
  id: "long-drill",
  title: "KV store with nested transactions and extremely long title that would wrap or displace badges",
  kind: "logic" as const,
  estMinutes: 45,
  sourcePath: "drills/x/long/long.ts",
  testPath: "drills/x/long/long.test.ts",
  instructions: "Do it.",
};

const longChapterTitle = "Chapter 1 — Very Long Chapter Title That Must Also Truncate Cleanly Without Pushing Badges Down";

const manifests: Record<string, unknown> = {
  "example-course": {
    id: "example-course",
    title: "Example Course",
    chapters: [
      {
        id: "c1",
        title: longChapterTitle,
        drills: [longTitleDrill],
      },
    ],
  },
};

function response(body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

// The matchMedia stub in setupTests.ts resolves breakpoints against innerWidth,
// so tests pick a viewport by setting it before render.
function setViewport(width: number) {
  Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: width });
}

beforeEach(() => {
  setViewport(1280);
  localStorage.clear();
  window.history.replaceState({}, "", "/?course=example-course");
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/api/courses") return response(courses);
      const match = url.match(/^\/api\/courses\/([^/]+)$/);
      if (match) return response(manifests[decodeURIComponent(match[1])]);
      if (url.startsWith("/api/progress/")) return response({});
      if (url === "/api/test-results") return response({ available: false });
      if (url.startsWith("/api/outlines/")) return Promise.resolve(new Response(JSON.stringify({ error: `No outline for ${url.split("/").pop()}` }), { status: 404, headers: { "Content-Type": "application/json" } }));
      return response({});
    })
  );
});

afterEach(() => {
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("CourseShell layout contract", () => {
  it("renders drill title with truncation styling and badge in rightSection sibling", async () => {
    render(
      <MantineProvider>
        <CourseShell />
      </MantineProvider>
    );

    // Wait for chapter title to load
    const navBar = document.querySelector("nav") as HTMLElement;
    const chapterTitleElement = await within(navBar).findByText(longChapterTitle);

    // Ensure chapter is expanded (it defaults open in state, but let's click if drill isn't visible)
    if (!within(navBar).queryByText(longTitleDrill.title)) {
      await userEvent.click(chapterTitleElement);
    }

    const titleElement = await within(navBar).findByText(longTitleDrill.title);

    // Check title element styling and data attribute
    expect(titleElement).toHaveClass("mantine-Text-root");
    expect(titleElement.dataset.truncate).toBe("end");

    // Assert structural siblinghood via NavLink sections:
    // titleElement is inside .mantine-NavLink-body (or label slot).
    // Its parent/wrapper .mantine-NavLink-body's nextSibling should be .mantine-NavLink-section containing the rightSection badge.
    const navLinkBody = titleElement.closest(".mantine-NavLink-body");
    expect(navLinkBody).not.toBeNull();
    const rightSection = navLinkBody?.nextElementSibling;
    expect(rightSection).not.toBeNull();
    expect(within(rightSection as HTMLElement).getByText("45m")).toBeInTheDocument();
  });

  it("renders chapter title with truncation styling and badge in rightSection sibling", async () => {
    render(
      <MantineProvider>
        <CourseShell />
      </MantineProvider>
    );

    const navBar = document.querySelector("nav") as HTMLElement;
    const chapterTitleElement = await within(navBar).findByText(longChapterTitle);

    expect(chapterTitleElement.closest("button")).toHaveAttribute("aria-expanded");
    expect(chapterTitleElement).toHaveClass("mantine-Text-root");
    expect(chapterTitleElement.dataset.truncate).toBe("end");

    const chapterNavLinkBody = chapterTitleElement.closest(".mantine-NavLink-body");
    expect(chapterNavLinkBody).not.toBeNull();
    const rightSection = chapterNavLinkBody?.nextElementSibling;
    expect(rightSection).not.toBeNull();
    expect(within(rightSection as HTMLElement).getByText("0/1")).toBeInTheDocument();
  });

  it("lays the header out as a row on wide viewports", async () => {
    setViewport(1280);
    render(
      <MantineProvider>
        <CourseShell />
      </MantineProvider>
    );

    const header = await screen.findByTestId("drill-header");
    expect(header).toHaveStyle({ flexDirection: "row" });
    expect(within(header).getByRole("heading", { name: longTitleDrill.title })).toHaveStyle({ minWidth: "0px" });
  });

  it("keeps the drill title and timer sticky above the coding workspace", async () => {
    render(
      <MantineProvider>
        <CourseShell />
      </MantineProvider>
    );

    const sticky = await screen.findByTestId("drill-sticky-header");
    expect(sticky).toHaveStyle({ position: "sticky", top: "0px" }); expect(sticky.style.zIndex).toBe('var(--ir-z-sticky)');
    expect(sticky.style.paddingBlock).toBe('var(--mantine-spacing-xs)');
    expect(sticky.style.background).toBe('light-dark(var(--ir-color-canvas), var(--ir-color-surface))');
    expect(within(sticky).getByTestId("drill-header")).toBeInTheDocument();
    expect(within(sticky).getByRole("heading", { name: longTitleDrill.title })).toBeInTheDocument();
    expect(within(sticky).getByText("45:00")).toBeInTheDocument();
  });

  it("stacks the header so a narrow viewport does not starve the title", async () => {
    setViewport(360);
    render(
      <MantineProvider>
        <CourseShell />
      </MantineProvider>
    );

    const header = await screen.findByTestId("drill-header");
    expect(header).toHaveClass("drill-header-grid");
    expect(header.firstElementChild).toHaveClass("drill-header-main");
    expect(header.lastElementChild).toHaveClass("drill-header-actions");
    expect(within(header.lastElementChild as HTMLElement).getByRole("radiogroup", { name: "Drill status" })).toBeInTheDocument();
  });

  it("stacks the header at tablet width, where the sidebar leaves the header ~470px", async () => {
    setViewport(768);
    render(
      <MantineProvider>
        <CourseShell />
      </MantineProvider>
    );

    const header = await screen.findByTestId("drill-header");
    expect(header).toHaveClass("drill-header-grid");
    expect(within(header.firstElementChild as HTMLElement).getByRole("heading", { name: longTitleDrill.title })).toBeInTheDocument();
    expect(header.lastElementChild).toHaveClass("drill-header-actions");
    expect(within(header.lastElementChild as HTMLElement).getByRole("radiogroup", { name: "Drill status" })).toBeInTheDocument();
  });

  it("does not add a duplicate main offset at 1024px", async () => {
    setViewport(1024);
    render(
      <MantineProvider>
        <CourseShell />
      </MantineProvider>
    );

    await screen.findByTestId("drill-header");
    expect(document.querySelector("main")?.style.paddingInlineStart).toBe("");
  });

  it("keeps the sidebar reachable on narrow viewports via the burger", async () => {
    setViewport(360);
    render(
      <MantineProvider>
        <CourseShell />
      </MantineProvider>
    );

    await screen.findByTestId("drill-header");
    const burger = screen.getByRole("button", { name: "Toggle course navigation" });
    const navBar = document.querySelector("nav") as HTMLElement;

    // Mantine drives the collapse itself via CSS variables and media queries, which
    // jsdom cannot evaluate. What is testable here is the controlled state the
    // collapse reads from: it starts closed, the burger opens it, and picking a
    // drill closes it again so the full-width overlay does not cover the pane.
    expect(burger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(burger);
    expect(burger).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(within(navBar).getByText(longTitleDrill.title));
    expect(burger).toHaveAttribute("aria-expanded", "false");
  });
});
