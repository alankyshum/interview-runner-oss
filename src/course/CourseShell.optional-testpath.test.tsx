import { MantineProvider } from "@mantine/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'sprint' && ['project-preview-card', 'signal-hub-deep-dive'].includes(drill) }; });
import CourseShell from "./CourseShell";

vi.mock("./SandboxWorkspace", () => ({
  default: ({ instructions, watcherResult, preview }: any) => { const url = String(instructions).match(/https?:\/\/\S+/)?.[0]; return <section role="region" aria-label="Code practice workspace" data-testid="coding-workspace-columns"><div data-testid="instruction-pane">{url ? <a href={url} target="_blank" rel="noreferrer noopener">{url}</a> : instructions}</div>{preview}<button aria-label="Toggle Test results" /><div role="region" aria-label="Results">{watcherResult?.stale && <span>Tests have not run since this drill changed.</span>}{watcherResult?.tests?.map((test: any) => <span key={test.name}>{test.name}</span>)}</div></section>; },
}));

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });

// Outline-backed reading has no testPath; coding requires deterministic tests.
const courses = [{ id: "sprint", title: "Sprint", chapterCount: 1, drillCount: 3 }];
const manifest = {
  id: "sprint",
  title: "Sprint",
  chapters: [{
    id: "day-1",
    title: "Day 1",
    drills: [
      { contentType: "reading", id: "project-preview-card", title: "Full cold mock", kind: "scratch", estMinutes: 60, sourcePath: "reading/sprint/project-preview-card.md", outlinePath: "outlines/sprint/project-preview-card.json", instructions: "Cold mock." },
      { contentType: "reading", id: "signal-hub-deep-dive", title: "Day 1 vocabulary", kind: "scratch", estMinutes: 20, sourcePath: "drills/sprint/signal-hub-deep-dive/signal-hub-deep-dive.ts", outlinePath: "outlines/sprint/signal-hub-deep-dive.json", instructions: "Recall." },
      { contentType: "coding", id: "token-sse-partials", title: "Typed drill", kind: "logic", estMinutes: 20, sourcePath: "drills/hooli-growth-loop/token-sse-partials/token-sse-partials.ts", testPath: "drills/hooli-growth-loop/token-sse-partials/token-sse-partials.test.ts", instructions: "Typed instructions." },
    ],
  }],
};
function response(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState({}, "", "/?course=sprint");
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/courses") return response(courses);
    if (/^\/api\/courses\/[^/]+$/.test(url)) return response(manifest);
    if (url.startsWith("/api/progress/")) return response({});
    if (url === "/api/test-results") return response({ available: false });
    if (url.startsWith("/api/outlines/")) { const drillId = url.split('/').pop(); return response({ courseId: 'sprint', drillId, title: drillId === 'project-preview-card' ? 'Full cold mock' : 'Day 1 vocabulary', nodes: [{ id: 'claim', type: 'claim', text: 'Reading content remains available.' }] }); }
    return response({});
  }));
});
afterEach(() => { window.history.replaceState({}, "", "/"); vi.restoreAllMocks(); });

async function selectDrill(name: string) {
  render(<MantineProvider><CourseShell /></MantineProvider>);
  await screen.findByText("Day 1");
  const nav = document.querySelector("nav") as HTMLElement;
  await userEvent.click(await within(nav).findByText(name));
}

describe("drills without a testPath", () => {
  it.each(["Full cold mock", "Day 1 vocabulary"])(
    "omits the Tests path for %s",
    async (name) => {
      await selectDrill(name);
      expect(await screen.findByRole("heading", { name })).toBeInTheDocument();
      expect(await screen.findByTestId("outline-reader")).toBeInTheDocument();
      expect(screen.queryByText(/Tests:/)).not.toBeInTheDocument();
      expect(screen.queryByText("undefined")).not.toBeInTheDocument();
    },
  );

  it("does not offer OpenCode evaluation for an outline lesson", async () => {
    await selectDrill("Full cold mock");
    expect(await screen.findByRole("heading", { name: "Full cold mock" })).toBeInTheDocument();
    expect(await screen.findByText("Reading content remains available.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /evaluate|critique/i })).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("/api/evaluations/"))).toBe(false);
  });

  it("does not offer critique for another outline lesson", async () => {
    await selectDrill("Day 1 vocabulary");
    expect(await screen.findByRole("heading", { name: "Day 1 vocabulary" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /evaluate|critique/i })).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).startsWith("/api/evaluations/"))).toBe(false);
  });

  it("shows the code workspace for a drill that has a test file", async () => {
    await selectDrill("Typed drill");
    expect(await screen.findByRole("region", { name: "Code practice workspace" })).toBeInTheDocument();
    expect(screen.getByTestId("instruction-pane")).toBeInTheDocument();
  });

  it("keeps deterministic test drills on the test-results path", async () => {
    await selectDrill("Typed drill");
    expect(screen.queryByRole("button", { name: "Evaluate with OpenCode" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Toggle Test results" })).toBeInTheDocument();
  });
});
