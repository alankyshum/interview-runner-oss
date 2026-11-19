import { Alert, Group, Loader, Modal, Select, Stack, Text, Tooltip } from "@mantine/core";
import { Button, IconButton, Panel, StatusBadge } from "../ui";
import { IconClipboardText, IconFiles, IconX } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import type { Course } from "../../shared/courseSchema";
import type { DrillAttempt } from "./CourseShell";
import SandboxWorkspaceShell from "./SandboxWorkspaceShell";
import { learnerTimeZone, learnerTimeZoneHeaders } from "./timeZone";

type Props = Omit<ComponentProps<typeof SandboxWorkspaceShell>, "sandbox"> & { aiCoding?: boolean; attempt?: DrillAttempt; attempts?: DrillAttempt[]; starting?: boolean; onStartAttempt?: () => void };
type Sandbox = { id: string; url: string; stage?: number };
type EditorLease = { key: string; stolen: boolean };

export default function SandboxWorkspace({ aiCoding = false, attempt: initialAttempt, attempts, starting = false, onStartAttempt, ...props }: Props) {
  const [sandbox, setSandbox] = useState<Sandbox>();
  const [attempt, setAttempt] = useState(initialAttempt);
  const [instructions, setInstructions] = useState(props.instructions);
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [timerNotice, setTimerNotice] = useState("");
  const [lease, setLease] = useState<EditorLease>();
  const [lockNotice, setLockNotice] = useState<"blocked" | "error">();
  const [takeover, setTakeover] = useState(0);
  const takeoverKey = useRef("");
  const pendingClose = useRef<Promise<void>>(Promise.resolve());
  const [healthWarning, setHealthWarning] = useState(false);
  const [reviewNumber, setReviewNumber] = useState<number>();
  const [reviewChoice, setReviewChoice] = useState<string>();
  const [latestResult, setLatestResult] = useState<{ status: string; tests: Array<{ status: string }> }>();
  const [resultError, setResultError] = useState<string>();
  const [resultLoaded, setResultLoaded] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const advanceRef = useRef<HTMLButtonElement>(null);
  const reviewOpenRef = useRef<HTMLButtonElement>(null);
  const lastStage = useRef(initialAttempt?.stage ?? 1);
  const retry = useCallback(() => setGeneration((value) => value + 1), []);
  const stage = attempt?.stage ?? sandbox?.stage ?? 1;
  const count = attempt?.stageCount ?? Math.max(stage, 1);
  const submitted = Boolean(attempt?.completedAt);
  const completedAttempts = (attempts ?? (attempt ? [attempt] : [])).filter((item) => item.completedAt);
  const review = reviewNumber !== undefined;
  const selectedReview = completedAttempts.find((item) => item.attemptNumber === reviewNumber);
  const editorEnabled = !aiCoding || Boolean(attempt && (!submitted || selectedReview));
  const disabled = starting || busy;
  const announce = useCallback((message: string) => { setAnnouncement(""); window.requestAnimationFrame(() => setAnnouncement(message)); }, []);
  const liveRegion = <div aria-live="polite" aria-atomic="true" className="code-runner-live">{announcement}</div>;

  const refreshInstructions = useCallback(async () => {
    const response = await fetch(`/api/courses/${encodeURIComponent(props.courseId)}`, { headers: learnerTimeZoneHeaders() });
    const course = await response.json() as Course & { error?: string };
    if (!response.ok) throw new Error(course.error ?? "Requirements could not be refreshed.");
    const drill = course.chapters.flatMap((chapter) => chapter.drills).find((item) => item.id === props.drillId);
    if (drill) setInstructions(drill.instructions);
  }, [props.courseId, props.drillId]);

  useEffect(() => { setAttempt(initialAttempt); }, [initialAttempt]);
  useEffect(() => { setReviewNumber(undefined); }, [attempt?.attemptNumber]);
  useEffect(() => { setReviewNumber(undefined); setReviewChoice(undefined); setLatestResult(undefined); setResultError(undefined); setResultLoaded(false); }, [props.courseId, props.drillId]);
  useEffect(() => {
    if (!aiCoding || !submitted) return;
    let active = true; setLatestResult(undefined); setResultError(undefined); setResultLoaded(false);
    void fetch(`/api/progress/${encodeURIComponent(props.courseId)}/${encodeURIComponent(props.drillId)}/submissions`).then(async (response) => { const payload = await response.json() as { submissions?: Array<{ result: { status: string; tests: Array<{ status: string }> } }>; error?: string }; if (!response.ok || !Array.isArray(payload.submissions)) throw new Error(payload.error ?? 'Submitted result could not be loaded.'); const result = payload.submissions.at(-1)?.result; if (result && (typeof result.status !== 'string' || !Array.isArray(result.tests))) throw new Error('Submitted result is invalid.'); if (active) { setLatestResult(result); setResultLoaded(true); } }).catch((cause: unknown) => { if (active) setResultError(cause instanceof Error ? cause.message : 'Submitted result could not be loaded.'); });
    return () => { active = false; };
  }, [aiCoding, submitted, props.courseId, props.drillId, attempt?.attemptNumber]);
  useEffect(() => { setInstructions(props.instructions); lastStage.current = initialAttempt?.stage ?? 1; setAdvanceOpen(false); setTimerNotice(""); }, [props.courseId, props.drillId, props.instructions]);
  const lockKey = `ir-editor:${props.courseId}/${props.drillId}`;
  useEffect(() => {
    if (!editorEnabled) return;
    let active = true; let release: (() => void) | undefined; const currentLease: EditorLease = { key: lockKey, stolen: false };
    setLease(undefined); setLockNotice(undefined);
    if (!navigator.locks) { setLockNotice("error"); return; }
    const steal = takeoverKey.current === lockKey; takeoverKey.current = "";
    void navigator.locks.request(lockKey, steal ? { steal: true } : { ifAvailable: true }, async (held) => {
      if (!active) return;
      if (!held) { setLockNotice("blocked"); return; }
      setLease(currentLease); setLockNotice(undefined);
      await new Promise<void>((resolve) => { release = resolve; });
    }).catch((cause: unknown) => {
      if (!active) return;
      if (cause instanceof DOMException && cause.name === "AbortError") { currentLease.stolen = true; setSandbox(undefined); setLease(undefined); setLockNotice("blocked"); }
      else { setLease(undefined); setLockNotice("error"); }
    });
    return () => { active = false; queueMicrotask(() => { void pendingClose.current.then(() => release?.(), () => release?.()); }); };
  }, [lockKey, aiCoding, aiCoding ? attempt?.attemptNumber : undefined, editorEnabled, reviewNumber, takeover]);
  useEffect(() => {
    if (!aiCoding || !attempt || submitted) return;
    let current = true;
    const poll = async () => {
      try {
        const response = await fetch(`/api/attempts/${encodeURIComponent(props.courseId)}`, { headers: learnerTimeZoneHeaders() }); const payload = await response.json() as { attempts?: Record<string, DrillAttempt[]> };
        const next = payload.attempts?.[props.drillId]?.at(-1); if (!current || !response.ok || !next) return;
        if ((next.stage ?? 1) > lastStage.current) { if (next.lastStageReason === "timer") { const message = `Requirement ${next.stage} revealed by the interview timer.`; setTimerNotice(message); announce(message); window.setTimeout(() => setTimerNotice(""), 5000); } lastStage.current = next.stage ?? 1; await refreshInstructions(); }
        if (current) setAttempt(next);
      } catch { /* polling is additive; explicit actions still report failures */ }
    };
    const interval = window.setInterval(() => void poll(), 1000); void poll(); return () => { current = false; window.clearInterval(interval); };
  }, [aiCoding, attempt?.attemptNumber, submitted, props.courseId, props.drillId, refreshInstructions, announce]);

  useEffect(() => {
    if (!editorEnabled) { setSandbox(undefined); return; }
    if (!lease || lease.key !== lockKey) return;
    let current = true; let created: Sandbox | undefined;
    setSandbox(undefined); setError(undefined);
    const startup = (async () => { await pendingClose.current; if (!current || lease.stolen) return; const response = await fetch("/api/sandboxes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ courseId: props.courseId, drillId: props.drillId, ...(reviewNumber === undefined ? {} : { review: true, attemptNumber: reviewNumber }) }), signal: AbortSignal.timeout(30_000) }); let payload: Partial<Sandbox> & { error?: string } = {}; try { payload = await response.json() as typeof payload; } catch { /* status text is used below */ } if (!response.ok || typeof payload.id !== "string" || typeof payload.url !== "string") throw new Error(payload.error || response.statusText || `Sandbox could not be started (${response.status}).`); created = { id: payload.id, url: payload.url, stage: payload.stage }; if (current && !lease.stolen) setSandbox(created); })();
    void startup.catch((cause: unknown) => { if (!current) { console.warn("Sandbox startup failed after closing", cause); return; } const message = cause instanceof DOMException && cause.name === "TimeoutError" ? "Sandbox start timed out. Try again." : cause instanceof Error ? cause.message : "Sandbox could not be started."; setError(message); announce(message); });
    return () => { current = false; const closing = startup.catch(() => {}).then(async () => { if (created && !lease.stolen) { const response = await fetch(`/api/sandboxes/${encodeURIComponent(created.id)}`, { method: "DELETE" }); if (!response.ok && response.status !== 404) throw new Error(`Sandbox cleanup failed (${response.status}).`); } }); pendingClose.current = closing; void closing.catch((cause: unknown) => console.error("Sandbox cleanup failed", cause)); };
  }, [props.courseId, props.drillId, generation, aiCoding, aiCoding ? attempt?.attemptNumber : undefined, editorEnabled, reviewNumber, lease, lockKey]);

  useEffect(() => {
    if (!sandbox) return;
    let active = true; let baseline: { oomKills?: number | null; extHostCrashes?: number | null } | undefined; setHealthWarning(false);
    const poll = async () => { try { const response = await fetch(`/api/sandboxes/${encodeURIComponent(sandbox.id)}`); if (!response.ok) throw new Error(`Sandbox health failed (${response.status}).`); const payload = await response.json() as { health?: { oomKills?: number | null; extHostCrashes?: number | null } | null }; const health = payload.health; if (!active || !health) return; if (baseline && ((health.oomKills != null && baseline.oomKills != null && health.oomKills > baseline.oomKills) || (health.extHostCrashes != null && baseline.extHostCrashes != null && health.extHostCrashes > baseline.extHostCrashes))) setHealthWarning(true); baseline = { oomKills: health.oomKills ?? baseline?.oomKills, extHostCrashes: health.extHostCrashes ?? baseline?.extHostCrashes }; } catch (error) { if (active) console.warn('Sandbox health unavailable', error); } };
    void poll(); const timer = window.setInterval(() => void poll(), 15_000); return () => { active = false; window.clearInterval(timer); };
  }, [sandbox?.id]);

  const copy = async (kind: "prompt" | "workspace") => {
    if (!sandbox) return; setBusy(true);
    try { const response = await fetch(kind === "prompt" ? `/api/drills/${encodeURIComponent(props.courseId)}/${encodeURIComponent(props.drillId)}/handoff` : `/api/sandboxes/${encodeURIComponent(sandbox.id)}/export.md`, { headers: learnerTimeZoneHeaders() }); const value = kind === "prompt" ? (await response.json() as { prompt?: string; error?: string }) : { prompt: await response.text() }; if (!response.ok || typeof value.prompt !== "string") throw new Error(value.error ?? "Copy failed"); await navigator.clipboard.writeText(value.prompt); announce(kind === "prompt" ? "Interviewer prompt copied" : "Workspace copied"); }
    catch { announce(kind === "prompt" ? "Interviewer prompt copy failed" : "Workspace copy failed"); }
    finally { setBusy(false); }
  };
  const advance = async () => {
    setBusy(true); setAdvanceOpen(false);
    try { const response = await fetch(`/api/attempts/${encodeURIComponent(props.courseId)}/${encodeURIComponent(props.drillId)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "advance", reason: "manual", timeZone: learnerTimeZone() }) }); const payload = await response.json() as { attempts?: DrillAttempt[]; error?: string }; if (!response.ok || !payload.attempts?.length) throw new Error(payload.error ?? "Requirement could not be revealed."); const next = payload.attempts.at(-1)!; setAttempt({ ...next, stage: (payload as unknown as { stage: number }).stage, stageCount: (payload as unknown as { stageCount: number }).stageCount, lastStageReason: "manual" }); lastStage.current = (payload as unknown as { stage: number }).stage; await refreshInstructions(); announce(`Requirement ${(payload as unknown as { stage: number }).stage} revealed`); window.requestAnimationFrame(() => advanceRef.current?.focus()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Requirement could not be revealed."); }
    finally { setBusy(false); }
  };

  if (aiCoding && starting && (!attempt || submitted)) return <>{liveRegion}<Group justify="center" h="100%" gap="sm"><Loader aria-hidden="true" /><Text>Starting fresh workspace…</Text></Group></>;
  if (aiCoding && !attempt) return <>{liveRegion}<Panel label="Attempt" padding="md"><Stack align="flex-start" gap="sm"><Text fw={600}>No attempt in progress</Text><Button onClick={onStartAttempt}>Start new attempt</Button></Stack></Panel></>;
  const choice = reviewChoice ?? String(completedAttempts.at(-1)?.attemptNumber ?? '');
  const reviewControls = completedAttempts.length ? <Group gap="xs" wrap="wrap" style={{ minWidth: 0, maxWidth: "100%" }}>{completedAttempts.length > 1 && <Select label="Submitted attempt" value={choice} data={completedAttempts.map((item) => ({ value: String(item.attemptNumber), label: `Attempt ${item.attemptNumber}` }))} onChange={(value) => setReviewChoice(value ?? undefined)} allowDeselect={false} />}<Button ref={reviewOpenRef} variant="secondary" aria-label="Review submitted work (read-only)" onClick={() => { setSandbox(undefined); setReviewNumber(Number(choice)); }}>Review submitted work</Button></Group> : null;
  if (aiCoding && submitted && !review) return <>{liveRegion}<Panel label="Submitted attempt" padding="md"><Stack align="flex-start" gap="sm"><Text fw={700}>Attempt submitted</Text>{latestResult ? <Text>Latest result: {latestResult.status} · {latestResult.tests.filter((test) => test.status === 'passed').length} passed / {latestResult.tests.length} tests</Text> : resultError ? <Alert color="red">{resultError}</Alert> : <Text>{resultLoaded ? 'No submitted result is available.' : 'Loading submitted result…'}</Text>}{reviewControls}</Stack></Panel></>;
  if (lockNotice === "blocked") return <Alert color="yellow" title="Open in another tab"><Button mih={44} onClick={() => { takeoverKey.current = lockKey; setTakeover((value) => value + 1); }}>Use here</Button></Alert>;
  if (lockNotice === "error") return <Alert color="red" title="Sandbox unavailable">Workspace locking is unavailable. Use a secure context and a browser with Web Locks support.</Alert>;
  if (error) return <>{liveRegion}<Alert color="red" title="Sandbox unavailable"><Stack gap="sm">{error}<Group><Button onClick={retry}>Retry</Button>{review && <Button variant="secondary" onClick={() => { setError(undefined); setReviewNumber(undefined); }}>Back to attempt</Button>}</Group></Stack></Alert></>;
  if (!lease || lease.key !== lockKey) return <Group justify="center" h="100%"><Loader aria-label="Opening workspace" /></Group>;
  if (!sandbox) return <Group justify="center" h="100%" gap="sm"><Loader aria-hidden="true" />{aiCoding && <Text>{review ? 'Opening submitted workspace…' : 'Starting fresh workspace…'}</Text>}</Group>;
  return <section style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "var(--mantine-spacing-xs)" }}>
    <style>{`.requirement-controls{min-width:0;max-width:100%}.requirement-controls>*{flex-shrink:0}.requirement-short,.stage-short,.stage-tiny,.review-short{display:none}@container question-pane (max-width:31rem){.stage-full,.review-full{display:none}.stage-short,.review-short{display:inline}}@container question-pane (max-width:21rem){.requirement-full{display:none}.requirement-short{display:inline}}@container question-pane (max-width:16rem){.requirement-controls{gap:2px}.stage-short{display:none}.stage-tiny{display:inline}}`}</style>
    {liveRegion}
    {!review && !submitted && aiCoding ? reviewControls : null}
    {sandbox && <SandboxWorkspaceShell {...props} instructions={instructions} questionControls={review ? <Group className="requirement-controls" gap="xs" mb="sm" wrap="wrap"><StatusBadge role="img" aria-label={`Read-only · Attempt ${reviewNumber}`}><span className="requirement-full" aria-hidden="true">Read-only · Attempt {reviewNumber}</span><span className="requirement-short" aria-hidden="true">Review {reviewNumber}</span></StatusBadge><Tooltip label="Close submitted workspace" events={{ hover: true, focus: true, touch: false }}><Button className="review-close" variant="subtle" aria-label="Close submitted workspace" onClick={() => { setSandbox(undefined); setReviewNumber(undefined); window.requestAnimationFrame(() => reviewOpenRef.current?.focus()); }}><span className="review-full" aria-hidden="true">Close submitted workspace</span><span className="review-short" aria-hidden="true">Close review</span></Button></Tooltip></Group> : aiCoding ? <Stack gap="xs" mb="sm"><Group className="requirement-controls" gap="xs" wrap="wrap"><StatusBadge role="img" h={36} tone="info" aria-label={submitted ? `Submitted · Requirement ${stage} of ${count}` : `Requirement ${stage} of ${count}`}><span className="requirement-full" aria-hidden="true">{submitted ? `Submitted · Requirement ${stage} of ${count}` : `Requirement ${stage} of ${count}`}</span><span className="requirement-short" aria-hidden="true">Req {stage}/{count}</span></StatusBadge>{!submitted && stage < count ? <Tooltip label="Mark stage done and reveal next" events={{ hover: true, focus: true, touch: false }}><Button ref={advanceRef} className="requirement-next" size="sm" aria-label="Mark stage done and reveal next" disabled={disabled || !sandbox} onClick={() => setAdvanceOpen(true)}><span className="stage-full" aria-hidden="true">Mark stage done and reveal next</span><span className="stage-short" aria-hidden="true">Next stage</span><span className="stage-tiny" aria-hidden="true">Next</span></Button></Tooltip> : !submitted ? <Text fw={600}>Final requirement</Text> : null}<IconButton label="Copy interviewer prompt" icon={<IconClipboardText size={18} aria-hidden="true" />} disabled={disabled || submitted || !sandbox} onClick={() => void copy("prompt")} /><IconButton label="Copy workspace as text" icon={<IconFiles size={18} aria-hidden="true" />} disabled={disabled || submitted || !sandbox} onClick={() => void copy("workspace")} /></Group>{timerNotice && <Panel label="Requirement update" padding="sm" style={{ background: 'var(--ir-color-info-bg)', color: 'var(--ir-color-info)' }}><Text size="sm">{timerNotice}</Text></Panel>}</Stack> : undefined} sandbox={{ ...sandbox, onRetry: retry, aiCoding, completed: submitted || review, review, controlsDisabled: disabled || submitted || review, submitDisabled: review || (aiCoding && stage < count), healthWarning: healthWarning ? <Alert mx="sm" my="xs" color="orange" title="Workspace may have stopped working" withCloseButton closeButtonLabel="Dismiss workspace warning" styles={{ closeButton: { minWidth: 44, minHeight: 44 } }} onClose={() => setHealthWarning(false)}>An editor process crashed or ran out of memory. Your files are preserved.<Button variant="secondary" ml="sm" onClick={retry}>Restart workspace</Button></Alert> : undefined }} />}
    <Modal.Root opened={advanceOpen} onClose={() => { setAdvanceOpen(false); window.requestAnimationFrame(() => advanceRef.current?.focus()); }} centered><Modal.Overlay /><Modal.Content><Modal.Header role="presentation"><Modal.Title>{`Reveal requirement ${stage + 1}?`}</Modal.Title><IconButton variant="subtle" label="Close requirement dialog" icon={<IconX size={20} aria-hidden="true" />} tooltipWithinPortal={false} onClick={() => { setAdvanceOpen(false); window.requestAnimationFrame(() => advanceRef.current?.focus()); }} /></Modal.Header><Modal.Body><Text>This commits the workspace and cannot be undone.</Text><Group justify="flex-end" mt="md"><Button ref={cancelRef} data-autofocus variant="secondary" onClick={() => { setAdvanceOpen(false); window.requestAnimationFrame(() => advanceRef.current?.focus()); }}>Keep working</Button><Button onClick={() => void advance()}>Reveal requirement {stage + 1}</Button></Group></Modal.Body></Modal.Content></Modal.Root>
  </section>;
}
