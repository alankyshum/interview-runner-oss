import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SandboxWorkspace from "./SandboxWorkspace";
import { attemptActionLabel } from "./CourseShell";

vi.mock("./SandboxWorkspaceShell", () => ({ default: ({ instructions, questionControls, sandbox }: any) => <div data-testid="workspace">{sandbox.healthWarning}<section aria-label="Question">{questionControls}<span>{instructions}</span></section><button disabled={sandbox.controlsDisabled}>Run tests</button><button disabled={sandbox.submitDisabled}>Submit</button></div> }));
const response = (body: unknown, status = 200, contentType = "application/json") => new Response(contentType === "application/json" ? JSON.stringify(body) : String(body), { status, headers: { "Content-Type": contentType } });
const base = { courseId: "ai", drillId: "pair", sourcePath: "drills/ai/pair/workspace/src/pair.ts", instructions: "Context\n\n## Milestone 1\nVisible requirement", estMinutes: 30, colorScheme: "light" as const, runnerCollapsed: false, onToggleRunner: vi.fn(), editorPercent: 65, onEditorPercentChange: vi.fn(), onSubmitPassed: vi.fn(), aiCoding: true, attempt: { attemptNumber: 1, startedAt: new Date().toISOString(), accumulatedActiveMs: 0, elapsedMs: 0, stage: 1, stageCount: 2 } };

describe("SandboxWorkspace AI coding controls", () => {
  const writeText = vi.fn(async () => {});
  beforeEach(() => { vi.restoreAllMocks(); writeText.mockClear(); Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } }); const held = new Map<string, { reject: (error: unknown) => void }>(); Object.defineProperty(navigator, "locks", { configurable: true, value: { request: (name: string, options: LockOptions, callback: (lock: Lock | null) => Promise<void>) => new Promise<void>((resolve, reject) => { const previous = held.get(name); if (previous && options.ifAvailable) { void callback(null).then(resolve, reject); return; } if (previous && options.steal) previous.reject(new DOMException("stolen", "AbortError")); const owner = { reject }; held.set(name, owner); void callback({ name, mode: "exclusive" }).then(() => { if (held.get(name) === owner) held.delete(name); resolve(); }, reject); }) } }); });

  it("blocks a second tab and never deletes the sandbox when its lock is stolen", async () => {
    let posts = 0; const deletes: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => { const url = String(input); if (url === "/api/sandboxes" && init?.method === "POST") { posts++; return response({ id: "shared", url: "/sandbox/shared/", stage: 1 }); } if (init?.method === "DELETE") deletes.push(url); return response({}); }) as typeof fetch;
    const first = render(<MantineProvider><SandboxWorkspace {...base} /></MantineProvider>); await screen.findByTestId("workspace");
    const second = render(<MantineProvider><SandboxWorkspace {...base} /></MantineProvider>); expect(await screen.findByText("Open in another tab")).toBeInTheDocument(); expect(posts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Use here" })); await waitFor(() => expect(posts).toBe(2)); await waitFor(() => expect(within(first.container).queryByTestId("workspace")).not.toBeInTheDocument()); expect(within(second.container).getByTestId("workspace")).toBeInTheDocument(); expect(deletes).not.toContain("/api/sandboxes/shared");
    first.unmount(); second.unmount();
  });
  it("does not delete an in-flight sandbox creation after takeover", async () => {
    let resolveFirst!: (value: Response) => void; let posts = 0; const deletes: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => { const url = String(input); if (url === "/api/sandboxes" && init?.method === "POST") { posts++; if (posts === 1) return new Promise<Response>((resolve) => { resolveFirst = resolve; }); return response({ id: "shared", url: "/sandbox/shared/" }); } if (init?.method === "DELETE") deletes.push(url); return response({}); }) as typeof fetch;
    const first = render(<MantineProvider><SandboxWorkspace {...base} /></MantineProvider>); await waitFor(() => expect(posts).toBe(1)); const second = render(<MantineProvider><SandboxWorkspace {...base} /></MantineProvider>); fireEvent.click(await screen.findByRole("button", { name: "Use here" })); await waitFor(() => expect(posts).toBe(2)); await act(async () => { resolveFirst(response({ id: "shared", url: "/sandbox/shared/" })); }); expect(deletes).not.toContain("/api/sandboxes/shared"); first.unmount(); second.unmount();
  });
  it("warns on a health counter increase and restarts only after deleting the old sandbox", async () => {
    let kills = 0; let posts = 0; let healthPoll: (() => void) | undefined; const order: string[] = []; const interval = window.setInterval;
    vi.spyOn(window, "setInterval").mockImplementation(((handler: TimerHandler, timeout?: number, ...args: unknown[]) => { if (timeout === 15_000 && typeof handler === 'function') healthPoll = handler as () => void; return interval(handler, timeout, ...args); }) as typeof window.setInterval);
    globalThis.fetch = vi.fn(async (input, init) => { const url = String(input); if (url === "/api/sandboxes" && init?.method === "POST") { order.push("post"); posts++; return response({ id: `s${posts}`, url: `/sandbox/s${posts}/`, stage: 1 }); } if (init?.method === "DELETE") { order.push("delete"); return response({}); } if (url === "/api/sandboxes/s1") return response({ health: { oomKills: kills, extHostCrashes: 0 } }); return response({}); }) as typeof fetch;
    render(<MantineProvider><SandboxWorkspace {...base} /></MantineProvider>); await screen.findByTestId("workspace"); await waitFor(() => expect(healthPoll).toBeDefined()); await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/api/sandboxes/s1")).toBe(true));
    kills = 1; await act(async () => { healthPoll?.(); }); expect(await screen.findByText("Workspace may have stopped working")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Dismiss workspace warning" })); expect(screen.queryByText("Workspace may have stopped working")).not.toBeInTheDocument(); kills = 2; await act(async () => { healthPoll?.(); }); expect(await screen.findByText("Workspace may have stopped working")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Restart workspace" })); await waitFor(() => expect(posts).toBe(2)); expect(order.slice(0, 3)).toEqual(["post", "delete", "post"]);
  });

  it("uses contextual start, resume, and pause labels", () => {
    expect(attemptActionLabel(true, undefined, false)).toBe("Start new attempt"); expect(attemptActionLabel(true, base.attempt, false)).toBe("Resume attempt"); expect(attemptActionLabel(true, base.attempt, true)).toBe("Pause"); expect(attemptActionLabel(true, { ...base.attempt, completedAt: new Date().toISOString() }, false)).toBe("Start new attempt");
  });

  it("shows an idle start action without creating a sandbox when no attempt exists", async () => {
    const onStartAttempt = vi.fn(); globalThis.fetch = vi.fn() as typeof fetch;
    render(<MantineProvider><SandboxWorkspace {...base} attempt={undefined} onStartAttempt={onStartAttempt} /></MantineProvider>);
    expect(screen.getByText("No attempt in progress")).toBeInTheDocument(); expect(screen.queryByText("Starting fresh workspace…")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start new attempt" })); expect(onStartAttempt).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });

  it("shows fresh-workspace loading when starting without an open attempt", async () => {
    globalThis.fetch = vi.fn(async () => response({})) as typeof fetch;
    const view = render(<MantineProvider><SandboxWorkspace {...base} attempt={undefined} starting /></MantineProvider>);
    expect(screen.getByText("Starting fresh workspace…")).toBeInTheDocument();
    view.rerender(<MantineProvider><SandboxWorkspace {...base} attempt={{ ...base.attempt, completedAt: new Date().toISOString() }} starting /></MantineProvider>);
    expect(screen.getByText("Starting fresh workspace…")).toBeInTheDocument();
    await act(async () => {});
  });

  it("bounds sandbox startup, announces timeout failures, and retries", async () => {
    const timeoutSignal = new AbortController().signal; vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    let starts = 0; globalThis.fetch = vi.fn(async (input, init) => { if (String(input) === "/api/sandboxes" && init?.method === "POST") { starts++; expect(init.signal).toBe(timeoutSignal); if (starts === 1) throw new DOMException("timed out", "TimeoutError"); return response({ id: "s1", url: "/sandbox/s1/", stage: 1 }, 201); } return response({}); }) as typeof fetch;
    render(<MantineProvider><SandboxWorkspace {...base} /></MantineProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Sandbox start timed out. Try again."); await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Sandbox start timed out. Try again."));
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); expect(await screen.findByTestId("workspace")).toBeInTheDocument(); expect(starts).toBe(2);
  });

  it("shows the server sandbox error message", async () => {
    globalThis.fetch = vi.fn(async () => response({ error: "Podman could not allocate a workspace" }, 503)) as typeof fetch;
    render(<MantineProvider><SandboxWorkspace {...base} /></MantineProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Podman could not allocate a workspace");
  });

  it("replaces the question and sandbox when the selected drill changes", async () => {
    let starts = 0; const deleted: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => { const url = String(input); if (url === "/api/sandboxes" && init?.method === "POST") { starts++; return response({ id: `s${starts}`, url: `/sandbox/s${starts}/` }, 201); } if (url.startsWith("/api/sandboxes/") && init?.method === "DELETE") { deleted.push(url); return response({ deleted: true }); } return response({}); }) as typeof fetch;
    const coding = { ...base, aiCoding: false, attempt: undefined };
    const view = render(<MantineProvider><SandboxWorkspace {...coding} instructions="First question" /></MantineProvider>);
    expect(await screen.findByTestId("workspace")).toHaveTextContent("First question");
    view.rerender(<MantineProvider><SandboxWorkspace {...coding} drillId="second" sourcePath="drills/ai/second/index.ts" instructions="Second question" /></MantineProvider>);
    await waitFor(() => expect(screen.getByTestId("workspace")).toHaveTextContent("Second question")); expect(screen.queryByText("First question")).not.toBeInTheDocument();
    await waitFor(() => expect(starts).toBe(2)); expect(deleted).toContain("/api/sandboxes/s1");
  });

  it("keeps a coding workspace open when a completed attempt is hydrated", async () => {
    let starts = 0; const deleted: string[] = [];
    globalThis.fetch = vi.fn(async (input, init) => { const url = String(input); if (url === "/api/sandboxes" && init?.method === "POST") { starts++; return response({ id: "coding", url: "/sandbox/coding/" }, 201); } if (init?.method === "DELETE") deleted.push(url); return response({}); }) as typeof fetch;
    const coding = { ...base, aiCoding: false, attempt: undefined };
    const view = render(<MantineProvider><SandboxWorkspace {...coding} /></MantineProvider>);
    await screen.findByTestId("workspace");
    view.rerender(<MantineProvider><SandboxWorkspace {...coding} attempt={{ ...base.attempt, completedAt: new Date().toISOString() }} /></MantineProvider>);
    await waitFor(() => expect(screen.getByRole("button", { name: "Run tests" })).toBeDisabled());
    expect(screen.getByTestId("workspace")).toBeInTheDocument(); expect(starts).toBe(1); expect(deleted).toEqual([]);
    view.unmount();
  });

  it("shows the submitted result and opens the selected completed attempt in read-only review", async () => {
    const first = { ...base.attempt, completedAt: '2026-10-28T01:00:00Z' }; const latest = { ...first, attemptNumber: 2 }; const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input, init) => { const url = String(input); requests.push({ url, init }); if (url.endsWith('/submissions')) return response({ submissions: [{ result: { status: 'passed', tests: [{ status: 'passed' }] } }] }); if (url === '/api/sandboxes' && init?.method === 'POST') return response({ id: 'review-one', url: '/sandbox/review-one/' }, 201); return response({}); }) as typeof fetch;
    render(<MantineProvider><SandboxWorkspace {...base} attempt={latest} attempts={[first, latest]} /></MantineProvider>);
    expect(await screen.findByText('Latest result: passed · 1 passed / 1 tests')).toBeVisible(); expect(screen.queryByTestId('workspace')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('textbox', { name: 'Submitted attempt' })); fireEvent.click(screen.getByRole('option', { name: 'Attempt 1' })); fireEvent.click(screen.getByRole('button', { name: 'Review submitted work (read-only)' }));
    await screen.findByTestId('workspace'); const question = screen.getByRole('region', { name: 'Question' }); expect(within(question).getByText('Read-only · Attempt 1')).toBeVisible(); const reviewClose = within(question).getByRole('button', { name: 'Close submitted workspace' }); expect(reviewClose).toBeVisible(); expect(reviewClose.closest('.requirement-controls')).toContainElement(within(question).getByRole('img', { name: 'Read-only · Attempt 1' })); expect(screen.getByRole('button', { name: 'Run tests' })).toBeDisabled(); expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
    expect(requests.find((entry) => entry.url === '/api/sandboxes')?.init?.body).toBe(JSON.stringify({ courseId: 'ai', drillId: 'pair', review: true, attemptNumber: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Close submitted workspace' })); expect(await screen.findByText('Attempt submitted')).toBeVisible(); await waitFor(() => expect(screen.getByRole('button', { name: 'Review submitted work (read-only)' })).toHaveFocus()); await waitFor(() => expect(requests.some((entry) => entry.url === '/api/sandboxes/review-one' && entry.init?.method === 'DELETE')).toBe(true));
  });
  it("clears the stale editor when an active attempt becomes submitted", async () => {
    globalThis.fetch = vi.fn(async (input, init) => { const url = String(input); if (url === '/api/sandboxes' && init?.method === 'POST') return response({ id: 'old', url: '/sandbox/old/' }); if (url === '/api/sandboxes/old' && init?.method === 'DELETE') return response({}, 404); if (url.endsWith('/submissions')) return response({ submissions: [] }); return response({}); }) as typeof fetch;
    const view = render(<MantineProvider><SandboxWorkspace {...base} /></MantineProvider>); await screen.findByTestId('workspace'); const completed = { ...base.attempt, completedAt: '2026-10-28T01:00:00Z' }; view.rerender(<MantineProvider><SandboxWorkspace {...base} attempt={completed} attempts={[completed]} /></MantineProvider>);
    expect(await screen.findByText('Attempt submitted')).toBeVisible(); expect(screen.queryByTestId('workspace')).not.toBeInTheDocument(); expect(await screen.findByText('No submitted result is available.')).toBeVisible(); await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/sandboxes/old', expect.objectContaining({ method: 'DELETE' })));
  });
  it("can return to the submitted attempt after review startup fails", async () => {
    const completed = { ...base.attempt, completedAt: '2026-10-28T01:00:00Z' }; globalThis.fetch = vi.fn(async (input, init) => { if (String(input) === '/api/sandboxes' && init?.method === 'POST') return response({ error: 'Review unavailable' }, 503); if (String(input).endsWith('/submissions')) return response({ submissions: [] }); return response({}); }) as typeof fetch;
    render(<MantineProvider><SandboxWorkspace {...base} attempt={completed} attempts={[completed]} /></MantineProvider>); fireEvent.click(await screen.findByRole('button', { name: 'Review submitted work (read-only)' })); expect(await screen.findByText('Review unavailable')).toBeVisible(); fireEvent.click(screen.getByRole('button', { name: 'Back to attempt' })); expect(await screen.findByText('Attempt submitted')).toBeVisible();
  });

  it("never creates locked requirement DOM, confirms manual reveal, and copies only server-filtered payloads", async () => {
    let advanced = false;
    globalThis.fetch = vi.fn(async (input, init) => { const url = String(input); if (url === "/api/sandboxes" && init?.method === "POST") return response({ id: "s1", url: "/sandbox/s1/", stage: 1 }, 201); if (url.includes("/handoff")) return response({ prompt: "rubric and visible requirement" }); if (url.endsWith("/export.md")) return response("## src/pair.ts\n\n```\ncode\n```", 200, "text/markdown"); if (url.includes("/api/attempts/ai/pair")) { advanced = true; return response({ attempts: [base.attempt], stage: 2, stageCount: 2 }); } if (url === "/api/courses/ai") return response({ id: "ai", title: "AI", chapters: [{ id: "c", title: "C", drills: [{ id: "pair", instructions: "Context\n\n## Milestone 1\nVisible requirement\n\n## Milestone 2\nNow visible" }] }] }); if (url === "/api/attempts/ai") return response({ attempts: { pair: [base.attempt] } }); return response({}); }) as typeof fetch;
    render(<MantineProvider><SandboxWorkspace {...base} /></MantineProvider>); await screen.findByTestId("workspace"); expect(screen.queryByText("Locked requirement")).not.toBeInTheDocument(); const question = screen.getByRole("region", { name: "Question" }); const prompt = within(question).getByRole("button", { name: "Copy interviewer prompt" }); const workspace = within(question).getByRole("button", { name: "Copy workspace as text" }); const stage = within(question).getByRole("button", { name: "Mark stage done and reveal next" }); const indicator = within(question).getByRole('img', { name: 'Requirement 1 of 2' }); const row = stage.closest('.requirement-controls')!; expect(prompt).toBeVisible(); expect(workspace).toBeVisible(); expect(stage).toBeVisible(); expect(Array.from(row.children)).toEqual([indicator, stage, prompt, workspace]); expect(stage.querySelector('.stage-short')).toHaveTextContent('Next stage');
    const live = document.querySelector('[aria-live="polite"]')!; const mutations: string[] = []; const observer = new MutationObserver(() => mutations.push(live.textContent ?? "")); observer.observe(live, { childList: true, subtree: true, characterData: true });
    fireEvent.click(screen.getByRole("button", { name: "Copy interviewer prompt" })); await waitFor(() => expect(writeText).toHaveBeenCalledWith("rubric and visible requirement")); await waitFor(() => expect(live).toHaveTextContent("Interviewer prompt copied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy interviewer prompt" })); await waitFor(() => expect(mutations.filter((value) => value === "Interviewer prompt copied").length).toBeGreaterThanOrEqual(2));
    fireEvent.click(screen.getByRole("button", { name: "Copy workspace as text" })); await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("src/pair.ts"))); await waitFor(() => expect(live).toHaveTextContent("Workspace copied")); observer.disconnect();
    fireEvent.click(screen.getByRole("button", { name: "Mark stage done and reveal next" })); const dialog = await screen.findByRole("dialog", { name: "Reveal requirement 2?" }); expect(within(dialog).getByRole("button", { name: "Close requirement dialog" })).toBeInTheDocument(); expect(within(dialog).getByText("This commits the workspace and cannot be undone.")).toBeInTheDocument(); expect(advanced).toBe(false); fireEvent.click(within(dialog).getByRole("button", { name: "Keep working" })); expect(advanced).toBe(false); await waitFor(() => expect(screen.getByRole("button", { name: "Mark stage done and reveal next" })).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Mark stage done and reveal next" })); fireEvent.click(await screen.findByRole("button", { name: "Reveal requirement 2" })); await waitFor(() => expect(advanced).toBe(true)); expect(fetch).toHaveBeenCalledWith('/api/attempts/ai/pair', expect.objectContaining({ body: JSON.stringify({ action: 'advance', reason: 'manual', timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }) })); await waitFor(() => expect(screen.getByTestId("workspace")).toHaveTextContent("Now visible"));
  });

  it("announces timer reveals and disables Submit before the final requirement", async () => {
    let polls = 0;
    globalThis.fetch = vi.fn(async (input, init) => { const url = String(input); if (url === "/api/sandboxes" && init?.method === "POST") return response({ id: "s1", url: "/sandbox/s1/", stage: 1 }, 201); if (url === "/api/attempts/ai") { polls++; return response({ attempts: { pair: [{ ...base.attempt, stage: polls > 1 ? 2 : 1, lastStageReason: polls > 1 ? "timer" : "start" }] } }); } if (url === "/api/courses/ai") return response({ id: "ai", title: "AI", chapters: [{ id: "c", title: "C", drills: [{ id: "pair", instructions: "## Milestone 1\nOne\n## Milestone 2\nTwo" }] }] }); return response({}); }) as typeof fetch;
    render(<MantineProvider><SandboxWorkspace {...base} /></MantineProvider>); await screen.findByTestId("workspace"); expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled(); const notice = await screen.findByText("Requirement 2 revealed by the interview timer.", {}, { timeout: 3000 }); expect(notice.closest('[role="alert"], [role="status"], [aria-live]')).toBeNull(); await waitFor(() => expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent("Requirement 2 revealed by the interview timer.")); expect(document.querySelectorAll('[role="alert"], [role="status"], [aria-live]').length).toBe(1);
  });
});
