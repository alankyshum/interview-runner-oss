import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import CourseShell from "./CourseShell";

vi.mock("./SandboxWorkspace", () => ({
  default: ({ sourcePath, instructions }: { sourcePath: string; instructions: string }) => <section aria-label="Code practice workspace"><div role="region" aria-label="Question">{instructions}</div><div role="region" aria-label="Results">Runner</div><div role="region" aria-label="TypeScript editor">{sourcePath}</div></section>,
}));

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
const manifest = { id: "demo", title: "Demo", chapters: [{ id: "chapter", title: "Coding", drills: [{ contentType: "coding", id: "sum", title: "Two sum", kind: "logic", estMinutes: 15, sourcePath: "drills/demo/sum.ts", testPath: "drills/demo/sum.test.ts", instructions: "Implement two sum." }, { contentType: "coding", id: "other", title: "Other drill", kind: "logic", estMinutes: 10, sourcePath: "drills/demo/other.ts", testPath: "drills/demo/other.test.ts", instructions: "Implement another drill." }] }] };
const response = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }));

describe("CourseShell TypeScript workspace", () => {
  beforeEach(() => {
    localStorage.clear(); history.replaceState({}, "", "/?course=demo&drill=sum");
    let attempts: Array<{ attemptNumber: number; startedAt: string; accumulatedActiveMs: number; elapsedMs: number; activeSince?: string; completedAt?: string }> = [];
    vi.stubGlobal("fetch", vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/courses") return response([{ id: "demo", title: "Demo", chapterCount: 1, drillCount: 2 }]);
      if (url === "/api/courses/demo") return response(manifest);
      if (url === "/api/progress/demo" || url === "/api/book-chapter-rank/demo") return response({});
      if (url === "/api/attempts/demo") return response({ courseId: "demo", attempts: attempts.length ? { sum: attempts } : {} });
      if (url === "/api/attempts/demo/sum" && init?.method === "POST") {
        const action = JSON.parse(String(init.body)).action;
        if (action === "start") attempts = [{ attemptNumber: 1, startedAt: "2026-10-25T10:00:00.000Z", accumulatedActiveMs: 0, elapsedMs: 0, activeSince: new Date().toISOString() }];
        if (action === "pause") attempts = attempts.map((attempt) => ({ ...attempt, accumulatedActiveMs: 1_000, elapsedMs: 1_000, activeSince: undefined }));
        if (action === "complete") attempts = attempts.map((attempt) => ({ ...attempt, accumulatedActiveMs: 1_000, elapsedMs: 1_000, activeSince: undefined, completedAt: new Date().toISOString() }));
        return response({ attempts });
      }
      if (url === "/api/library") return response({ categories: [], items: [] });
      if (url === "/api/cheatsheets") return response([]);
      if (url === "/api/test-results") return response({ available: false, reason: "no-runs-recorded" });
      if (url.startsWith("/api/outlines/")) return response({ error: `No outline for ${url.split("/").pop()}` }, 404);
      if (url === "/api/progress/demo/sum" && init?.method === "PUT") { const status = JSON.parse(String(init.body)).status; return response({ status, updatedAt: "2026-10-21T00:00:00.000Z" }); }
      return response({});
    }));
  });

  it("keeps the instructions and renders one editor/runner workspace without an empty preview", async () => {
    const user = userEvent.setup(); render(<MantineProvider><CourseShell /></MantineProvider>);
    expect(await screen.findByRole("region", { name: "TypeScript editor" })).toHaveTextContent("drills/demo/sum.ts");
    expect(screen.getByRole("region", { name: "Results" })).toHaveTextContent("Runner");
    expect(screen.getByRole("region", { name: "Question" })).toHaveTextContent("Implement two sum.");
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: "Results" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Toggle course navigation" })).toHaveClass('ir-icon-button');
    expect(readFileSync('src/ui/components.css', 'utf8')).toContain('.ir-icon-button { min-width: 44px; width: 44px; height: 44px;');
    expect(screen.queryByRole("button", { name: /Files \(/ })).not.toBeInTheDocument();
    const header = screen.getByTestId("drill-header");
    expect(within(header).queryByText("drills/demo/sum.ts")).not.toBeInTheDocument();
    expect(header).toHaveClass("drill-header-grid");
    expect(getComputedStyle(header).paddingInline).toBe("");
    expect(header.firstElementChild).toHaveClass("drill-header-main");
    expect(header.firstElementChild).toContainElement(screen.getByRole("heading", { name: "Two sum" }));
    expect(header.lastElementChild).toHaveClass("drill-header-actions");
    expect(header.querySelector(".drill-timer")?.nextElementSibling).toHaveClass("drill-status");
    expect(within(header).getByText("15:00")).toBeInTheDocument();
    const statusLabel = screen.getByText("Not started", { selector: "span" });
    expect(getComputedStyle(statusLabel).minHeight).toBe("44px"); expect(getComputedStyle(statusLabel).paddingInline).toBe("var(--mantine-spacing-sm)");
    const headerCss = Array.from(document.querySelectorAll("style")).map((style) => style.textContent).join("\n");
    expect(headerCss).toContain(".drill-header-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center");
    expect(headerCss).toContain('data-status="in-progress"'); expect(headerCss).toContain("var(--mantine-color-yellow-light)"); expect(headerCss).toContain("var(--mantine-color-red-light)"); expect(headerCss).toContain("var(--mantine-color-green-light)");
    expect(screen.getByTestId("drill-sticky-header")).toHaveClass("drill-sticky-header"); expect(headerCss).toContain("@container drill-header (min-width:48.001rem) and (max-width:56rem){.drill-header-grid{grid-template-columns:minmax(15rem,1fr) minmax(0,auto)}"); expect(headerCss).toContain(".drill-sticky-header{container:drill-header/inline-size}"); expect(headerCss).toContain("@container drill-header (max-width:48rem)"); expect(headerCss).not.toContain("max-width:64rem"); expect(headerCss).not.toContain("padding-inline:var(--mantine-spacing-md)");
    expect(headerCss).toContain('@media(max-width:24rem){.drill-timer{width:100%;flex-wrap:wrap}.drill-timer>*{flex-shrink:0;max-width:100%}.drill-status{width:100%;max-width:100%}.drill-status-control{width:100%;box-sizing:border-box;grid-template-columns:repeat(2,minmax(0,1fr))}');
    expect(within(header).getByLabelText("Attempt not started, estimate 15 minutes")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" })); expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument(); expect(within(header).getByLabelText(/Attempt 1, elapsed/)).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Pause" })); await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled()); fireEvent.click(screen.getByRole("button", { name: "Restart timer" })); expect(await screen.findByRole("button", { name: "Pause" })).toBeInTheDocument(); expect(within(header).getByText(/^(15:00|14:59)$/)).toBeInTheDocument();
    await user.click(screen.getByLabelText(/Other drill 10m, coding, not started/)); await screen.findByRole("heading", { name: "Other drill" }); expect(screen.getByText("10:00")).toBeInTheDocument(); expect(screen.queryByRole("button", { name: /Files \(/ })).not.toBeInTheDocument();
  });

  it("sets blocked explicitly and surfaces it on the drill and chapter", async () => {
    const user = userEvent.setup(); render(<MantineProvider><CourseShell /></MantineProvider>); await screen.findByRole("region", { name: "TypeScript editor" });
    await user.click(screen.getByRole("radio", { name: "Blocked" })); await waitFor(() => expect(screen.getByRole("radio", { name: "Blocked" })).toBeChecked());
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) => url === "/api/progress/demo/sum" && init?.method === "PUT" && JSON.parse(String(init.body)).status === "blocked")).toBe(true);
    expect(within(screen.getByLabelText(/Two sum .*coding, blocked/)).getByRole("img", { name: "Blocked" })).toHaveTextContent("🚫");
    expect(screen.getByLabelText("1 blocked drill")).toHaveTextContent("🚫 1");
  });

  it("keeps sidebar controls floating when Library is hidden", async () => {
    localStorage.setItem('interview-runner-ui-state', JSON.stringify({ sidebarCollapsed: true, outlineCollapsed: true })); const user = userEvent.setup(); render(<MantineProvider><CourseShell /></MantineProvider>);
    await screen.findByRole('region', { name: 'TypeScript editor' }); const header = screen.getByTestId('drill-header'); const controls = screen.getByRole('button', { name: 'Sidebar and theme controls' }); expect(header).not.toContainElement(controls); expect(controls.closest('[data-testid="sidebar-controls"]')).toHaveAttribute('data-floating', 'true');
    await user.click(controls); expect(await screen.findByRole('menuitemcheckbox', { name: /Show library/ })).toBeInTheDocument(); controls.focus(); await user.keyboard('{Escape}'); await waitFor(() => expect(controls).toHaveFocus()); expect(controls).toHaveAttribute('aria-expanded', 'false');
  });

});
