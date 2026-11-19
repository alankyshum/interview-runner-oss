import { Alert, Anchor, Collapse, Group, SegmentedControl, Stack, Switch, Text } from "@mantine/core";
import { IconCheck, IconPlayerPlay, IconRefresh } from "@tabler/icons-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, IconButton, Panel, PanelHeader, SplitPane, StatusBadge, type StatusTone } from "../ui";
import { useAppHotkeys, useHotkey } from "@tanstack/react-hotkeys";
import CodeOutput from "./CodeOutput";
import { useSandboxForwardedHotkey } from "./appHotkeys";
import { HoldForHint, type MilestoneHintContent } from "./MilestoneHint";
import { normalizeQuestionHeading, questionCards } from "./questionCards";
import SandboxFrame from "./SandboxFrame";
import { learnerTimeZone } from "./timeZone";

type Test = { name: string; status: string; message?: string };
type ConsoleOutput = { entries: Array<{ stream: "stdout" | "stderr"; text: string; testName?: string }>; truncated?: boolean };
type WatcherResult = { status: string; tests: Test[]; output?: ConsoleOutput; updatedAt: string; stale?: boolean };
type Diagnostic = { file?: string; line?: number; col?: number; message: string };
type RunResult = { status: "passed" | "tests-failed" | "type-errors" | "incomplete" | "error"; diagnostics: Diagnostic[]; tests: Test[]; output?: ConsoleOutput; updatedAt?: string };
type RunnerView = { status: "idle" | "unsaved" | "saving" | "running" | "passed" | "tests-failed" | "type-errors" | "incomplete" | "error" | "runner-error"; diagnostics: Diagnostic[]; tests: Test[]; output?: ConsoleOutput; message?: string; stale?: boolean };
type Submission = { id: number; submittedAt: string; result: RunResult; name?: string; commitSha?: string | null };
type Action = "run" | "submit";
const statusLabel: Record<RunnerView["status"], string> = { idle: "Idle", unsaved: "Unsaved", saving: "Saving", running: "Running", passed: "Passed", "tests-failed": "Tests failed", "type-errors": "Type errors", incomplete: "Incomplete", error: "Test error", "runner-error": "Runner error" };
const statusColor: Record<RunnerView["status"], StatusTone> = { idle: "neutral", unsaved: "warning", saving: "info", running: "info", passed: "success", "tests-failed": "danger", "type-errors": "warning", incomplete: "warning", error: "danger", "runner-error": "danger" };

export default function SandboxWorkspaceShell({ courseId, drillId, sourcePath, instructions, colorScheme, watcherResult, runnerCollapsed, onToggleRunner, editorPercent, onEditorPercentChange, onSubmitPassed, hintResetVersion = 0, questionControls, sandbox }: {
  courseId: string; drillId: string; sourcePath: string; instructions: string; estMinutes: number; colorScheme: "light" | "dark"; watcherResult?: WatcherResult;
  runnerCollapsed: boolean; onToggleRunner: () => void; editorPercent: number; onEditorPercentChange: (value: number) => void; onSubmitPassed: () => Promise<void> | void; hintResetVersion?: number;
  questionControls?: ReactNode; sandbox: { id: string; url: string; onRetry: () => void; aiCoding?: boolean; completed?: boolean; review?: boolean; controlsDisabled?: boolean; submitDisabled?: boolean; healthWarning?: ReactNode };
}) {
  const workspaceRef = useRef<HTMLElement | null>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const compact = workspaceWidth < 1152;
  const smallWorkspace = workspaceWidth > 0 && workspaceWidth < 500;
  const resultsContentId = useId();
  const questionCardId = useId();
  const [compactPane, setCompactPane] = useState<"question" | "editor" | "results">("editor");
  const filename = sourcePath.split("/").pop() ?? sourcePath;
  const [currentView, setCurrentView] = useState<RunnerView>({ status: "idle", diagnostics: [], tests: [] });
  const [selectedSubmission, setSelectedSubmission] = useState<Submission>();
  const [submissionError, setSubmissionError] = useState<string>();
  const [activeAction, setActiveAction] = useState<Action | null>(null);
  const [elapsed, setElapsed] = useState(0); const [announcement, setAnnouncement] = useState("Idle");
  const [interviewMode, setInterviewMode] = useState(() => localStorage.getItem('interview-runner:interview-mode') === 'true');
  const [courseHints, setCourseHints] = useState<Record<string, MilestoneHintContent[]>>({});
  const [unlockedHints, setUnlockedHints] = useState<Record<string, boolean>>({}); const [visibleHints, setVisibleHints] = useState<Record<string, boolean>>({});
  const [hintError, setHintError] = useState<string>();
  const hotkeys = useAppHotkeys();
  const directResult = useRef<{ signature: string; at: number } | undefined>(undefined);
  const hintEndpoint = `/api/progress/${encodeURIComponent(courseId)}/${encodeURIComponent(drillId)}/hints`;
  const submissionEndpoint = `/api/progress/${encodeURIComponent(courseId)}/${encodeURIComponent(drillId)}/submissions`;
  const viewResult = selectedSubmission?.result;
  const view: RunnerView = viewResult ? { status: viewResult.status, diagnostics: viewResult.diagnostics, tests: viewResult.tests, output: viewResult.output } : currentView;

  useEffect(() => {
    const element = workspaceRef.current;
    if (!element) return;
    const update = () => setWorkspaceWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setSelectedSubmission(undefined); setSubmissionError(undefined); setCurrentView({ status: "idle", diagnostics: [], tests: [] });
  }, [courseId, drillId, sourcePath, sandbox?.aiCoding]);
  useEffect(() => { let current = true; setCourseHints({}); void fetch(`/api/course-hints/${encodeURIComponent(courseId)}`).then(async (response) => response.ok ? response.json() : null).then((payload: { courseId?: unknown; drills?: unknown } | null) => { if (current && payload?.courseId === courseId && payload.drills && typeof payload.drills === "object" && !Array.isArray(payload.drills)) setCourseHints(payload.drills as Record<string, MilestoneHintContent[]>); }).catch(() => { /* courses without authored hints keep ordinary milestone headings */ }); return () => { current = false; }; }, [courseId]);
  useEffect(() => {
    let current = true; setUnlockedHints({}); setVisibleHints({}); setHintError(undefined);
    void fetch(hintEndpoint).then(async (response) => { const payload = await response.json() as { revealed?: unknown; error?: string }; if (!response.ok || !Array.isArray(payload.revealed) || payload.revealed.some((title) => typeof title !== "string")) throw new Error(payload.error ?? `Hint progress could not be loaded (${response.status}).`); if (current) { const state = Object.fromEntries((payload.revealed as string[]).map((title) => [`${drillId}:${title}`, true])); setUnlockedHints(state); setVisibleHints(state); } }).catch((error: unknown) => { if (current) setHintError(error instanceof Error ? error.message : "Hint progress could not be loaded."); });
    return () => { current = false; };
  }, [courseId, drillId, hintEndpoint, hintResetVersion]);
  useEffect(() => {
    let current = true; setSubmissionError(undefined); setSelectedSubmission(undefined);
    if (!sandbox.completed) return () => { current = false; };
    void fetch(submissionEndpoint).then(async (response) => { const payload = await response.json() as { submissions?: unknown; error?: string }; if (!response.ok || !Array.isArray(payload.submissions)) throw new Error(payload.error ?? `Submission result could not be loaded (${response.status}).`); if (current) setSelectedSubmission((payload.submissions as Submission[]).at(-1)); }).catch((error: unknown) => { if (current) setSubmissionError(error instanceof Error ? error.message : "Submission result could not be loaded."); });
    return () => { current = false; };
  }, [submissionEndpoint, hintResetVersion, sandbox.completed]);
  useEffect(() => {
    if (!watcherResult || currentView.status === "running" || currentView.status === "saving") return;
    const status = watcherResult.stale ? "unsaved" : watcherResult.status === "error" ? "error" : watcherResult.status === "failed" ? "tests-failed" : watcherResult.status === "passed" ? "passed" : watcherResult.status === "incomplete" || watcherResult.status === "skipped" ? "incomplete" : "idle";
    setCurrentView({ status, diagnostics: [], tests: watcherResult.tests, output: watcherResult.output, stale: watcherResult.stale });
    const signature = JSON.stringify([status, watcherResult.tests.map((test) => [test.name, test.status])]);
    if (directResult.current?.signature === signature && Date.now() - directResult.current.at < 5_000) return;
    const passed = watcherResult.tests.filter((test) => test.status === "passed").length; const failed = watcherResult.tests.filter((test) => test.status === "failed").length;
    setAnnouncement(`Tests updated: ${statusLabel[status]}${watcherResult.tests.length ? `. ${passed} passed${failed ? `, ${failed} failed` : ""}.` : "."}`);
  }, [watcherResult, drillId]);
  useEffect(() => { if (currentView.status !== "running") return; const started = Date.now(); setElapsed(0); const interval = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 250); return () => window.clearInterval(interval); }, [currentView.status]);

  const execute = async (action: Action) => {
    if (activeAction || sandbox.controlsDisabled || (action === "submit" && sandbox.submitDisabled)) return; setSelectedSubmission(undefined); setActiveAction(action); setCurrentView({ status: "running", diagnostics: [], tests: [] }); setAnnouncement(action === "submit" ? "Submitting" : "Running tests");
    try {
      const response = await fetch(`/api/sandboxes/${encodeURIComponent(sandbox.id)}/${action}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timeZone: learnerTimeZone() }) }); const payload = await response.json() as RunResult & { error?: string };
      if ((!response.ok && response.status !== 409) || !["passed", "tests-failed", "type-errors", "incomplete", "error"].includes(payload.status)) throw new Error(payload.error ?? `Runner failed (${response.status}).`);
      const result: RunResult = { status: payload.status, diagnostics: payload.diagnostics ?? [], tests: payload.tests ?? [], output: payload.output };
      const next: RunnerView = { status: result.status, diagnostics: result.diagnostics, tests: result.tests, output: result.output }; directResult.current = { signature: JSON.stringify([next.status, next.tests.map((test) => [test.name, test.status])]), at: Date.now() }; setCurrentView(next);
      const allPassed = payload.status === "passed" && payload.tests.length > 0 && payload.tests.every((test) => test.status === "passed");
      if (action === "submit" && allPassed) { await onSubmitPassed(); setAnnouncement("Submitted. All tests passed and the drill is done."); }
      else setAnnouncement(next.status === "error" ? next.tests.find((test) => test.message)?.message ?? statusLabel[next.status] : statusLabel[next.status]);
    } catch (error) { const message = error instanceof Error ? error.message : "Code runner failed."; setCurrentView({ status: "runner-error", diagnostics: [], tests: [], message }); setAnnouncement(`Runner error: ${message}`); }
    finally { setActiveAction(null); }
  };
  const reveal = (diagnostic: Diagnostic) => { setAnnouncement(diagnostic.line ? `${diagnostic.file ?? filename}:${diagnostic.line}:${diagnostic.col ?? 1}` : diagnostic.message); };
  const toggleInterviewMode = (checked: boolean) => { setInterviewMode(checked); localStorage.setItem('interview-runner:interview-mode', String(checked)); setAnnouncement(checked ? 'Interview mode on. Code suggestions and live type help are off.' : 'Interview mode off. Code suggestions and live type help are on.'); if (sandbox) void fetch(`/api/sandboxes/${encodeURIComponent(sandbox.id)}/settings`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: checked }) }).then(async (response) => { if (!response.ok) { const payload = await response.json() as { error?: string }; throw new Error(payload.error ?? `Sandbox settings could not be saved (${response.status}).`); } }).catch((cause: unknown) => { const message = cause instanceof Error ? cause.message : "Sandbox settings could not be saved."; setCurrentView({ status: "runner-error", diagnostics: [], tests: [], message }); setAnnouncement(`Runner error: ${message}`); }); };
  const hintHoldTransition = useCallback((title: string, state: "started" | "cancelled") => setAnnouncement(`${state === "started" ? "Hold started" : "Hold cancelled"} for ${title}`), []);
  const hintUnlocked = useCallback((title: string) => { const key = `${drillId}:${title}`; setUnlockedHints((current) => ({ ...current, [key]: true })); setVisibleHints((current) => ({ ...current, [key]: true })); setAnnouncement(`Hint unlocked for ${title}`); setHintError(undefined); void fetch(hintEndpoint, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hint: title }) }).then(async (response) => { const payload = await response.json() as { error?: string }; if (!response.ok) throw new Error(payload.error ?? `Hint progress could not be saved (${response.status}).`); }).catch((error: unknown) => setHintError(error instanceof Error ? error.message : "Hint progress could not be saved.")); }, [drillId, hintEndpoint]);
  const hintVisibility = useCallback((title: string, visible: boolean) => setVisibleHints((current) => ({ ...current, [`${drillId}:${title}`]: visible })), [drillId]);
  useHotkey(hotkeys["runner.runTests"], () => { void execute("run"); });
  useHotkey(hotkeys["runner.submit"], () => { void execute("submit"); });
  useSandboxForwardedHotkey("runner.runTests", () => { void execute("run"); }, true);
  useSandboxForwardedHotkey("runner.submit", () => { void execute("submit"); }, true);
  const editorPane = <Panel label="Sandbox editor workspace" padding="none" style={{ minWidth: 0, minHeight: 0, height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
    <Group className="workspace-toolbar" justify="space-between" px="sm" mih={44} gap="xs" wrap="wrap"><Text fw={600}>{sandbox.review ? "Read-only workspace" : sandbox.completed ? "Completed workspace" : "VS Code"}</Text><Group gap="xs" wrap="wrap" style={{ minWidth: 0 }}><Switch label="Interview mode" checked={interviewMode} disabled={sandbox.controlsDisabled} onChange={(event) => toggleInterviewMode(event.currentTarget.checked)} styles={{ root: { minHeight: 44, display: "flex", alignItems: "center" }, body: { minHeight: 44, alignItems: "center" } }} />{smallWorkspace ? <><IconButton label="Run tests" tooltipPosition="bottom" tooltipWithinPortal={false} icon={<IconPlayerPlay size={18} aria-hidden="true" />} loading={activeAction === "run"} disabled={sandbox.controlsDisabled || activeAction === "submit"} onMouseDown={(event) => event.preventDefault()} onClick={() => void execute("run")} /><IconButton label="Submit" tooltipPosition="bottom" tooltipWithinPortal={false} variant="primary" icon={<IconCheck size={18} aria-hidden="true" />} loading={activeAction === "submit"} disabled={sandbox.controlsDisabled || sandbox.submitDisabled || activeAction === "run"} onMouseDown={(event) => event.preventDefault()} onClick={() => void execute("submit")} /></> : <><Button variant="secondary" loading={activeAction === "run"} disabled={sandbox.controlsDisabled || activeAction === "submit"} onMouseDown={(event) => event.preventDefault()} onClick={() => void execute("run")}>Run tests</Button><Button loading={activeAction === "submit"} disabled={sandbox.controlsDisabled || sandbox.submitDisabled || activeAction === "run"} onMouseDown={(event) => event.preventDefault()} onClick={() => void execute("submit")}>Submit</Button></>}</Group></Group>
    {sandbox.healthWarning}
    {submissionError && <Alert color="red" mx="sm">{submissionError}</Alert>}
    {sandbox.completed && <Alert mx="sm" my="xs" color={view.status === "passed" ? "green" : "gray"} title="Attempt submitted" styles={{ title: { color: "var(--mantine-color-text)" } }}>{view.status === "passed" ? "All tests passed. Review the submitted result and Git history." : "Review the submitted result and Git history."}</Alert>}
    <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}><SandboxFrame url={sandbox.url} onRetry={sandbox.onRetry} /></div>
  </Panel>;
  const hintsByTitle = useMemo(() => new Map((courseHints[drillId] ?? []).map((hint) => [hint.title, hint])), [courseHints, drillId]);
  const cards = useMemo(() => questionCards(instructions), [instructions]);
  const cardComponents = useMemo(() => cards.map((card, index) => {
    const headingId = `${questionCardId}-${index}`; const headingText = (children: ReactNode) => Array.isArray(children) ? children.join("") : String(children);
    const heading = (level: number) => ({ children, node }: { children?: ReactNode; node?: { position?: { start: { line: number } } } }) => {
      const title = headingText(children); const id = card.headingDepth === level && card.headingLine === node?.position?.start.line && normalizeQuestionHeading(title) === normalizeQuestionHeading(card.heading ?? "") ? headingId : undefined;
      const normalizedLevel = Math.min(6, 3 + level - (card.headingDepth ?? level)) as 3 | 4 | 5 | 6; const component = `h${normalizedLevel}` as "h3" | "h4" | "h5" | "h6"; const size = normalizedLevel === 3 ? compact ? "lg" : "xl" : normalizedLevel === 4 ? "md" : "sm";
      if (level === 2) { const hint = hintsByTitle.get(title); const hintKey = `${drillId}:${title}`; if (hint) return <HoldForHint title={title} headingId={id} headingLevel={normalizedLevel} headingSize={size} hint={hint} initiallyUnlocked={Boolean(unlockedHints[hintKey])} initiallyVisible={Boolean(visibleHints[hintKey])} onHoldTransition={hintHoldTransition} onUnlock={hintUnlocked} onVisibilityChange={hintVisibility} />; }
      return <Text component={component} id={id} size={size} fw={700}>{children}</Text>;
    };
    return { a: ({ href, children }: { href?: string; children?: ReactNode }) => <Anchor href={href} target="_blank" rel="noreferrer noopener" underline="always">{children}</Anchor>, h1: heading(1), h2: heading(2), h3: heading(3), h4: heading(4), h5: heading(5), h6: heading(6) };
  }), [cards, questionCardId, hintsByTitle, drillId, unlockedHints, visibleHints, hintHoldTransition, hintUnlocked, hintVisibility, compact]);
  const questionPane = <Panel className="question-pane" label="Question" scrollable padding="sm" style={{ minHeight: 0, height: "100%", overflow: "auto" }}><Text component="h2" fw={700} mb="sm" style={{ fontSize: compact ? "var(--mantine-font-size-xl)" : "1.5rem" }}>Question</Text>{questionControls}{hintError && <Alert color="orange" mb="sm">{hintError}</Alert>}<Stack gap="md">{cards.map((card, index) => { const headingId = `${questionCardId}-${index}`; return <Panel component="section" key={`${courseId}/${drillId}/${card.kind}/${index}`} padding="md" {...(card.heading ? { labelledBy: headingId } : { label: "Question specification" })} style={{ background: card.kind === "context" ? "var(--ir-color-raised)" : "var(--ir-color-canvas)" }}><Markdown remarkPlugins={[remarkGfm]} components={cardComponents[index]}>{card.markdown}</Markdown></Panel>; })}</Stack></Panel>;
  const resultsPane = <Panel className="results-pane" label="Results" aria-describedby="results-context" scrollable padding="sm" style={{ minWidth: 0, minHeight: 0, height: "100%", overflow: "auto" }}>
    <div style={{ position: "sticky", top: 0, zIndex: 'var(--ir-z-sticky)', background: "var(--ir-color-surface)" }}><PanelHeader title="Results" actions={<><StatusBadge tone={statusColor[view.status]}>{statusLabel[view.status]}</StatusBadge>{view.status === "running" && <Text size="sm" c="dimmed" aria-hidden="true">{elapsed}s</Text>}{view.stale && <StatusBadge tone="warning">Stale</StatusBadge>}</>} {...(!compact ? { toggle: { expanded: !runnerCollapsed, onToggle: onToggleRunner, controlsId: resultsContentId, label: 'Toggle Test results' } } : {})} /></div>
    <Panel id="results-context" label="Result context" padding="sm" style={{ marginTop: 'var(--mantine-spacing-xs)' }}><Text size="sm" fw={600}>{selectedSubmission ? "Submitted result" : "Current workspace"}</Text></Panel>
    {/* A hidden compact pane cannot complete a height transition; remount on layout changes to discard stale measurements. */}
    {view.output && (view.output.entries.some((entry) => entry.text) || view.output.truncated) && <Collapse key={compact ? "compact-output" : "wide-output"} transitionDuration={compact ? 0 : undefined} in={!runnerCollapsed || compact}><Stack gap="xs" mt="sm" aria-label="Console output"><Text component="h3" fw={600}>Console output</Text>{view.output.entries.filter((entry) => entry.text).map((entry, index) => <div key={index}><Text fw={600} size="sm" style={{ overflowWrap: "anywhere" }}>{entry.testName || "Outside tests"}</Text><StatusBadge mb={4} tone={entry.stream === "stderr" ? "danger" : "neutral"}>{entry.stream}</StatusBadge><CodeOutput label={`${entry.testName || "Outside tests"} ${entry.stream} output`}>{entry.text}</CodeOutput></div>)}{view.output.truncated && <Text size="xs" c="dimmed">Output truncated after 64 KiB.</Text>}</Stack></Collapse>}
    <Collapse key={compact ? "compact" : "wide"} transitionDuration={compact ? 0 : undefined} id={resultsContentId} in={!runnerCollapsed || compact}><Stack gap="sm" mt="sm">{view.status === "unsaved" && <Text size="sm">Tests have not run since this drill changed.</Text>}{view.status === "runner-error" && <Alert color="red" title="Runner error" icon={<IconRefresh size={18} />}>{view.message}<Button variant="secondary" mt="sm" onClick={() => void execute("run")}>Retry</Button></Alert>}{view.diagnostics.length > 0 && <Stack gap="xs" aria-label="Type problems"><Text component="h3" fw={600}>Type problems</Text>{view.diagnostics.map((diagnostic, index) => <Panel label="Type diagnostic" padding="sm" key={`${diagnostic.file}-${diagnostic.line}-${index}`}><Button variant="subtle" justify="flex-start" onClick={() => reveal(diagnostic)} disabled={!diagnostic.line}>{diagnostic.file ?? filename}{diagnostic.line ? `:${diagnostic.line}:${diagnostic.col ?? 1}` : ""}</Button><CodeOutput label="Type diagnostic">{diagnostic.message}</CodeOutput></Panel>)}</Stack>}{(view.tests.length > 0 || view.status === "incomplete") && <Stack gap="xs" aria-label="Test list"><Text component="h3" fw={600}>Test results</Text><Text size="sm" fw={600}>{`${view.tests.filter((test) => test.status === "passed").length} passed · ${view.tests.filter((test) => test.status === "failed").length} failed · ${view.tests.filter((test) => test.status === "skipped").length} skipped · ${view.tests.filter((test) => test.status === "pending" || test.status === "todo").length} pending · ${view.tests.length} total`}</Text>{view.status === "incomplete" && <Alert color="yellow" title="Run incomplete">{view.tests.length === 0 ? "No tests executed." : "Every test must execute and pass; skipped or pending tests do not count as passed."}</Alert>}{view.tests.map((test, index) => <Panel label={`Test ${test.name}`} padding="sm" key={`${test.name}-${index}`}><Group gap="xs" align="flex-start" wrap="nowrap"><StatusBadge tone={test.status === "passed" ? "success" : test.status === "failed" ? "danger" : "neutral"}>{test.status}</StatusBadge><div style={{ minWidth: 0, flex: 1 }}><Text size="sm" fw={600}>{test.name}</Text>{test.message && <CodeOutput label={`${test.name} failure output`}>{test.message}</CodeOutput>}</div></Group></Panel>)}</Stack>}{view.status === "idle" && !view.tests.length && <Text c="dimmed">Run the drill to see TypeScript and test results.</Text>}</Stack></Collapse>
  </Panel>;
  const workspacePanes = useMemo(() => ({ question: questionPane, editor: editorPane, results: resultsPane }), [questionPane, editorPane, resultsPane]);
  return <section ref={workspaceRef} aria-label="Code practice workspace" data-layout={compact ? "tabs" : "columns"} data-resizing={resizing || undefined} style={{ containerType: "inline-size", flex: 1, minHeight: 0, height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
    <style>{`.code-runner-live{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.question-pane{container:question-pane/inline-size;min-inline-size:0;overflow-wrap:anywhere;word-break:break-word}.question-pane :where(pre,code){max-inline-size:100%;min-inline-size:0;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}.question-pane pre{inline-size:100%;margin-inline:0}`}</style>
    <style>{`[data-resizing=true] iframe{pointer-events:none}`}</style>
    <style>{`.workspace-left{height:100%;min-height:0;display:grid;grid-template-rows:var(--workspace-rows);row-gap:var(--mantine-spacing-xs)}[data-layout=tabs] .workspace-left{grid-template-rows:minmax(0,1fr)}[data-layout=tabs] .workspace-left>[data-pane]{grid-area:1/1}`}</style>
    <div className="code-runner-live" aria-live="polite" aria-atomic="true">{announcement}</div>
    {compact && <SegmentedControl fullWidth mb="xs" value={compactPane} onChange={(value) => setCompactPane(value as typeof compactPane)} styles={{ control: { minHeight: 44 }, label: { minHeight: 44, display: "flex", alignItems: "center", justifyContent: "center" } }} data={[{ label: "Question", value: "question" }, { label: "Editor", value: "editor" }, { label: <span>Results<span aria-hidden="true"> · {statusLabel[view.status]}</span></span>, value: "results" }]} />}
    <SplitPane className="workspace-grid" data-testid="coding-workspace-columns" value={editorPercent} valueSide="second" onChange={onEditorPercentChange} min={45} max={80} resetValue={65} label="Resize question and editor" visiblePane={compact ? compactPane === 'editor' ? 'second' : 'first' : undefined} onResizeChange={setResizing} style={{ flex: 1, minHeight: 0, "--workspace-rows": runnerCollapsed ? "minmax(0,1fr) auto" : "minmax(0,1fr) fit-content(38%)" } as CSSProperties}>
      <div className="workspace-left">{(["question", "results"] as const).map((pane) => { const inactive = compact && compactPane !== pane; return <div key={pane} data-pane={pane} hidden={inactive} inert={inactive} aria-hidden={inactive || undefined} style={{ minWidth: 0, minHeight: 0, overflow: "hidden" }}>{workspacePanes[pane]}</div>; })}</div>
      <div data-pane="editor" hidden={compact && compactPane !== 'editor'} inert={compact && compactPane !== 'editor'} aria-hidden={compact && compactPane !== 'editor' || undefined} style={{ minWidth: 0, minHeight: 0, height: '100%', overflow: "hidden" }}>{workspacePanes.editor}</div>
    </SplitPane>
    {resizing && <div data-testid="workspace-resize-overlay" aria-hidden="true" style={{ position: "fixed", inset: 0, zIndex: 'var(--ir-z-drag)', cursor: "col-resize", pointerEvents: 'none' }} />}
  </section>;
}
