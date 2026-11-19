import {
  Anchor,
  AppShell,
  Alert,
  Collapse,
  Drawer,
  Flex,
  Group,
  Loader,
  Modal,
  Menu,
  Popover,
  NavLink,
  Progress,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
  useMantineColorScheme,
  useComputedColorScheme,
} from "@mantine/core";
import { useDisclosure, useMediaQuery, useViewportSize } from "@mantine/hooks";
import { IconAdjustments, IconCheck, IconChevronDown, IconChevronRight, IconCircle, IconDeviceDesktop, IconKeyboard, IconLibrary, IconMenu2, IconMoon, IconPlayerPause, IconPlayerPlay, IconRefresh, IconRestore, IconSun, IconX } from "@tabler/icons-react";
import { useAppHotkeys, useHotkey } from "@tanstack/react-hotkeys";
import Markdown from "react-markdown";
import { ReadingMarkdown } from "./ReadingMarkdown";
import remarkGfm from "remark-gfm";
import { isValidElement, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from 'react-dom';
import { clampEditorPercent, clampLibraryWidth, getUiState, LIBRARY_WIDTH_DEFAULT, LIBRARY_WIDTH_MAX, LIBRARY_WIDTH_MIN, setUiState, type PanelId } from "./uiState";
import { OutlineReader } from "../reader/OutlineReader";
import { MapRecall } from "../reader/MapRecall";
import { useRecallProgress } from "../reader/useRecallProgress";
import type { CourseSummary } from "./courseDiscovery";
import LibraryPanel, { sortUpNext, type LibraryItem, type LibrarySnapshot } from "./LibraryPanel";
import { HeadingDeadline } from "./DeadlineLine";
import { copyText } from "./copyText";
import type { Outline } from "../../server/outlines";
import SandboxWorkspace from "./SandboxWorkspace";
import { learnerTimeZoneHeaders } from "./timeZone";
import { countdownRemaining, pauseCountdown, persistCountdown, persistCountdownReset, readCountdown, readCountdownReset, restartCountdown, startCountdown, type CountdownState } from "./countdownTimer";
import { Button, Button as UIButton, IconButton, IconButton as UIIconButton, Panel, PanelHeader, StatusBadge, TimerDisplay, WorkspaceHeader } from '../ui';

type Status = "not-started" | "in-progress" | "blocked" | "done";
import { isWhiteboardDrill, parseCourse, parseCheatsheet, type Chapter, type Course, type Cheatsheet } from '../../shared/courseSchema';
import './cheatsheet.css';
import { CheatsheetCoverage } from './CheatsheetCoverage';
import { CHEATSHEET_COVERAGE_ENABLED } from '../../shared/cheatsheetCoverage';
import { composeCheatsheetContent, prepareCheatsheetContent, watchCheatsheetCodeOverflow, watchCheatsheetDiagramFailures } from './cheatsheetContent';
import { CHEATSHEET_HYDRATE_EVENT, hydrateCheatsheetMaps } from './cheatsheetMaps';
import { hydrateCheatsheetMermaid } from './cheatsheetMermaid';
import { CheatsheetMindmap } from './CheatsheetMindmap';
import { ContentTypeIcon } from './ContentTypeIcon';
import KeyboardShortcutsModal from "./KeyboardShortcutsModal";
import CommandPalette, { type MenuCommand } from "./CommandPalette";
import { CourseRunnerHotkeysProvider, shortcutInline, useSandboxForwardedHotkey } from "./appHotkeys";
export type { Drill, Chapter, Course } from '../../shared/courseSchema';
type ProgressRecord = { status: Status; updatedAt: string; notes?: string };
export type DrillAttempt = { attemptNumber: number; startedAt: string; accumulatedActiveMs: number; elapsedMs: number; activeSince?: string; completedAt?: string; stage?: number; stageCount?: number; lastStageReason?: "start" | "manual" | "timer" };
export const attemptActionLabel = (aiCoding: boolean, attempt: DrillAttempt | undefined, running: boolean): string => running ? "Pause" : aiCoding ? attempt && !attempt.completedAt ? "Resume attempt" : "Start new attempt" : "Start";
type TestFile = { status: string; tests: Array<{ name: string; status: string; message?: string }>; output?: { entries: Array<{ stream: "stdout" | "stderr"; text: string; testName?: string }>; truncated?: boolean }; updatedAt: string; stale?: boolean; staleReason?: "drill-changed" };
type TestResults = { available: boolean; reason?: "no-runs-recorded"; files?: Record<string, TestFile> };
type OutlineState =
  | { status: "loading" }
  | { status: "ready"; outline: Outline }
  | { status: "absent" }
  | { status: "error"; message: string };


function markdownNodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(markdownNodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return markdownNodeText(node.props.children);
  return "";
}

export function CopyableMarkdownPre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = markdownNodeText(children).replace(/\n$/, "");
  const onCopy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return <Panel label="Code example" padding="sm" style={{ overflow: "hidden", marginBlock: 'var(--mantine-spacing-sm)' }}><Group justify="flex-end" mb="xs"><Button size="sm" variant="secondary" onClick={() => void onCopy()}>{copied ? "Copied" : "Copy code"}</Button></Group><pre className="ir-scroll-region" role="region" aria-label="Code example" tabIndex={0} style={{ margin: 0, overflowX: "auto", whiteSpace: "pre" }}>{children}</pre></Panel>;
}
const isManifestKey = (path: string) => !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path);
const formatTime = (milliseconds: number) => `${Math.floor(milliseconds / 60_000).toString().padStart(2, "0")}:${Math.floor(milliseconds % 60_000 / 1_000).toString().padStart(2, "0")}`;

function StatusIcon({ status }: { status: Status }) {
  if (status === "done") return <IconCheck aria-hidden="true" size={16} color="var(--ir-color-success)" />;
  if (status === "in-progress") return <IconRefresh aria-hidden="true" size={16} color="var(--ir-color-info)" />;
  if (status === "blocked") return <span role="img" aria-label="Blocked" style={{ fontSize: 16, lineHeight: 1 }}>🚫</span>;
  return <IconCircle aria-hidden="true" size={14} color="var(--ir-color-text-secondary)" />;
}

const STATUS_OPTIONS: Array<{ value: Status; label: string }> = [
  { value: "not-started", label: "Not started" },
  { value: "in-progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
];

function DrillStatusControl({ value, onChange }: { value: Status; onChange: (value: Status) => void }) {
  return <div className="drill-status-control" role="radiogroup" aria-label="Drill status">{STATUS_OPTIONS.map((option) => <label className="drill-status-option" data-status={option.value} key={option.value}><input type="radio" name="drill-status" value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} /><span>{option.label}</span></label>)}</div>;
}

export function courseNavigationWidth(mobile: boolean, wide: boolean, courseOutlinePresent: boolean, libraryWidth = LIBRARY_WIDTH_DEFAULT, libraryPresent = true): string | number {
  if (mobile) return "100%";
  const visibleLibraryWidth = libraryPresent ? (wide ? clampLibraryWidth(libraryWidth) : 272) : 0;
  const visibleOutlineWidth = courseOutlinePresent ? (wide ? 320 : 296) : 0;
  return visibleLibraryWidth + visibleOutlineWidth;
}
export function libraryWidthForKey(current: number, key: string, shiftKey = false): number {
  if (key === "Home") return LIBRARY_WIDTH_MIN;
  if (key === "End") return LIBRARY_WIDTH_MAX;
  const delta = shiftKey ? 32 : 8;
  if (key === "ArrowLeft") return clampLibraryWidth(current - delta);
  if (key === "ArrowRight") return clampLibraryWidth(current + delta);
  return clampLibraryWidth(current);
}

const SHEET_HEADINGS_WIDTH_KEY = 'interview-runner-sheet-headings-width';
const SHEET_HEADINGS_MIN = 224;
const SHEET_HEADINGS_DEFAULT = 256;
const SHEET_HEADINGS_MAX = 480;
const clampSheetHeadingsWidth = (width: number, max = SHEET_HEADINGS_MAX) => Math.max(SHEET_HEADINGS_MIN, Math.min(max, Math.round(width)));
function readSheetHeadingsWidth() {
  try {
    const raw = localStorage.getItem(SHEET_HEADINGS_WIDTH_KEY);
    const value = raw === null || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(value) ? clampSheetHeadingsWidth(value) : SHEET_HEADINGS_DEFAULT;
  } catch { return SHEET_HEADINGS_DEFAULT; }
}

function SemanticMenuItem({ role, checked, children, leftSection, rightSection, onClick, testId }: { role: "menuitemcheckbox" | "menuitemradio"; checked: boolean; children: ReactNode; leftSection: ReactNode; rightSection?: ReactNode; onClick: () => void; testId?: string }) {
  // Mantine's Menu.Item currently hard-codes role="menuitem" after forwarded props.
  // Correct it after commit while retaining Mantine's roving focus/arrow-key behavior.
  return <Menu.Item ref={(node) => { if (node) { node.setAttribute("role", role); node.setAttribute("aria-checked", String(checked)); } }} leftSection={leftSection} rightSection={rightSection} onClick={onClick} data-testid={testId}>{children}</Menu.Item>;
}

export default function CourseShell() {
  return <CourseRunnerHotkeysProvider><CourseShellBody /></CourseRunnerHotkeysProvider>;
}

export function CourseShellBody() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const resolvedColorScheme = useComputedColorScheme("light", { getInitialValueInEffect: true });
  const [courses, setCourses] = useState<Array<CourseSummary & { repo: string; chapterCount: number; drillCount: number }>>([]);
  const [library, setLibrary] = useState<LibrarySnapshot>({ categories: [], items: [], courseRepos: [] });
  const initialCourses = useRef<Promise<typeof courses> | null>(null);
  const initialSheets = useRef<Promise<Array<{ id: string; title: string; repo?: string }>> | null>(null);
  const loadInitialCourses = () => initialCourses.current ??= fetch('/api/courses').then((response) => response.json() as Promise<typeof courses>);
  const loadInitialSheets = () => initialSheets.current ??= fetch('/api/cheatsheets').then((response) => response.ok ? response.json() as Promise<Array<{ id: string; title: string; repo?: string }>> : []);
  const initialLibrary = useRef<Promise<LibrarySnapshot | null> | null>(null);
  const libraryUrl = (workspace = new URLSearchParams(location.search).get('workspace')) => workspace ? `/api/library?workspace=${encodeURIComponent(workspace)}` : '/api/library';
  const loadInitialLibrary = () => initialLibrary.current ??= (async () => {
    const params = new URLSearchParams(location.search); let workspace = params.get('workspace');
    if (!workspace && params.has('course')) { const items = await loadInitialCourses(); if (Array.isArray(items)) workspace = items.find((item) => item.id === params.get('course'))?.repo ?? null; }
    if (!workspace && params.has('cheatsheet')) { const items = await loadInitialSheets(); if (Array.isArray(items)) workspace = items.find((item) => item.id === params.get('cheatsheet'))?.repo ?? null; }
    const response = await fetch(libraryUrl(workspace)); return response.ok ? response.json() as Promise<LibrarySnapshot> : null;
  })().catch(() => null);
  const [tagsEditing, setTagsEditing] = useState(false);
  const [chapterRanks, setChapterRanks] = useState<Record<string, number>>({});
  const [course, setCourse] = useState<Course | null>(null);
  const recallProgress = useRecallProgress(course);
  const loadedCourseRef = useRef<Course | null>(null);
  const [progress, setProgress] = useState<Record<string, ProgressRecord>>({});
  const [progressHydratedCourseId, setProgressHydratedCourseId] = useState<string | null>(null);
  const [progressLoadFailed, setProgressLoadFailed] = useState(false);
  const [whiteboardStatusBusy, setWhiteboardStatusBusy] = useState(false);
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const [selectedId, setSelectedId] = useState<string>();
  const [storedCourseId] = useState(() => localStorage.getItem("interview-runner-course"));
  const [requestedCourseId] = useState(() => new URLSearchParams(window.location.search).get("course"));
  const [requestedWorkspace] = useState(() => new URLSearchParams(window.location.search).get("workspace"));
  const [requestedChapterId] = useState(() => new URLSearchParams(window.location.search).get("chapter"));
  const [requestedDrillId] = useState(() => new URLSearchParams(window.location.search).get("drill"));
  const [uiState, setUiStateLocal] = useState(getUiState);
  const [openChapters, setOpenChapters] = useState<Record<string, boolean>>({});
  const [resetChapter, setResetChapter] = useState<Chapter | null>(null);
  const [hintResetVersion, setHintResetVersion] = useState(0);
  const [timer, setTimer] = useState<CountdownState>({ remainingMs: 60_000 });
  const [clockNow, setClockNow] = useState(Date.now());
  const [timerAnnouncement, setTimerAnnouncement] = useState("");
  const [attempts, setAttempts] = useState<Record<string, DrillAttempt[]>>({});
  const [attemptsState, setAttemptsState] = useState<{ status: "loading" | "loaded" | "failed"; message?: string }>({ status: "loading" });
  const [attemptBusy, setAttemptBusy] = useState(false);
  const [newAttemptOpen, setNewAttemptOpen] = useState(false);
  const attemptStartTrigger = useRef<HTMLButtonElement>(null);
  const expiredAnnounced = useRef(false);
  const [results, setResults] = useState<TestResults | null>(null);
  const [previewOverrides, setPreviewOverrides] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [outlineState, setOutlineState] = useState<OutlineState>({ status: "loading" });
  const [outlineProgress, setOutlineProgress] = useState({ checked: 0, total: 0 });
  const outlineRequest = useRef(0);
  const courseRequest = useRef(0);
  const [opened, { open, close }] = useDisclosure(false);
  const [navOpened, { toggle: toggleNav, close: closeNav }] = useDisclosure(false);
  const [workspaceNavOpened, { open: openWorkspaceNav, close: closeWorkspaceNav }] = useDisclosure(false);
  const [navStep, setNavStep] = useState<"library" | "outline">(() => new URLSearchParams(location.search).has("course") ? "outline" : "library");
  const [category, setCategory] = useState<"courses" | "cheatsheets">(() => new URLSearchParams(location.search).has("cheatsheet") ? "cheatsheets" : new URLSearchParams(location.search).has("workspace") || new URLSearchParams(location.search).has("course") ? "courses" : localStorage.getItem("interview-runner-category") === "cheatsheets" ? "cheatsheets" : "courses");
  const categoryRef = useRef(category);
  const [cheatsheets, setCheatsheets] = useState<Array<{id:string;title:string}>>([]);
  const [cheatsheetId, setCheatsheetId] = useState<string | null>(() => new URLSearchParams(location.search).get("cheatsheet"));
  const [sheet, setSheet] = useState<Cheatsheet | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [sheetContent, setSheetContent] = useState<string | null>(null);
  const [sheetContentError, setSheetContentError] = useState<string | null>(null);
  const [sheetHeadingIndex, setSheetHeadingIndex] = useState(0);
  const sheetContentRef = useRef<HTMLElement>(null);
  const [sheetMapHosts, setSheetMapHosts] = useState<Array<{ host: HTMLElement; id: string; title: string; path: string }>>([]);
  const sheetLocationRef = useRef<HTMLDivElement>(null);
  const sheetHeaderRef = useRef<HTMLElement>(null);
  const sheetJumpCancel = useRef<() => void>(() => {});
  const sheetPanelRef = useRef<HTMLElement>(null);
  const [savedSheetHeadingsWidth, setSavedSheetHeadingsWidth] = useState(readSheetHeadingsWidth);
  const [resizingSheetHeadings, setResizingSheetHeadings] = useState(false);
  const sheetResize = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const pendingSheetHeading = useRef<number | null>(null);
  const sheetView = useMemo(() => {
    if (sheetContent === null) return { html: '', headings: [] as Array<{ index: number; title: string; level: number; sectionId?: string; sectionHeading: boolean }> };
    const template = document.createElement('template'); template.innerHTML = sheetContent;
    template.content.querySelectorAll('[data-sheet-heading-index]').forEach((element) => element.removeAttribute('data-sheet-heading-index'));
    let sectionId: string | undefined;
    const headings: Array<{ index: number; title: string; level: number; sectionId?: string; sectionHeading: boolean }> = [];
    for (const element of template.content.querySelectorAll('[data-sheet-section],h1,h2,h3,h4,h5,h6')) {
      const marker = element.getAttribute('data-sheet-section');
      if (marker) sectionId = marker;
      if (!element.matches('h1,h2,h3,h4,h5,h6')) continue;
      const index = headings.length;
      element.setAttribute('data-sheet-heading-index', String(index));
      headings.push({ index, title: element.textContent?.replace(/\s+/g, ' ').trim() || 'Untitled heading', level: Number(element.tagName.slice(1)), sectionId, sectionHeading: Boolean(marker) });
    }
    return { html: template.innerHTML, headings };
  }, [sheetContent]);
  const sheetMarkup = useMemo(() => ({ __html: sheetView.html }), [sheetView.html]);
  useLayoutEffect(() => {
    const root = sheetContentRef.current;
    if (!root || !sheet || sheetContent === null) { setSheetMapHosts([]); return; }
    const hosts: Array<{ host: HTMLElement; id: string; title: string; path: string }> = [];
    for (const lesson of sheet.chapters.flatMap((chapter) => chapter.drills)) {
      if (!lesson.mindmapPath) continue;
      const marker = [...root.querySelectorAll<HTMLElement>('[data-sheet-section]')].find((element) => element.dataset.sheetSection === lesson.id);
      if (!marker) continue;
      const host = document.createElement('div'); host.dataset.sheetMapHero = lesson.id;
      if (marker.matches('h1,h2,h3,h4,h5,h6')) marker.before(host); else marker.prepend(host);
      hosts.push({ host, id: lesson.id, title: lesson.title, path: lesson.mindmapPath });
    }
    setSheetMapHosts(hosts);
    return () => { hosts.forEach(({ host }) => host.remove()); };
  }, [sheet, sheetContent, sheetMarkup]);
  const sheetLocation = useMemo(() => {
    let section = ''; let subsection = '';
    for (const heading of sheetView.headings.slice(0, sheetHeadingIndex + 1)) {
      if (heading.level <= 2) { section = heading.title; subsection = ''; }
      else if (heading.level === 3) subsection = heading.title;
    }
    return [section, subsection].filter(Boolean);
  }, [sheetView.headings, sheetHeadingIndex]);
  const [controlsOpened, setControlsOpened] = useState(false);
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [shortcutsOpened, setShortcutsOpened] = useState(false);
  const sidebarControlsTrigger = useRef<HTMLButtonElement>(null);
  const shortcutReturnFocus = useRef<HTMLElement | null>(null);
  const hotkeys = useAppHotkeys();
  const wideLibrary = useMediaQuery("(min-width: 64em)", true) ?? true;
  const { width: viewportWidth } = useViewportSize();
  const sheetLibraryCollapsed = uiState.sheetLibraryCollapsed ?? ((viewportWidth || window.innerWidth) < 1600);
  const themeModeLabel = colorScheme === "auto" ? `System (${resolvedColorScheme})` : colorScheme === "dark" ? "Dark" : "Light";
  useEffect(() => {
    if (!tagsEditing) return;
    const protectDraft = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", protectDraft);
    return () => window.removeEventListener("beforeunload", protectDraft);
  }, [tagsEditing]);
  useEffect(() => {
    void Promise.all([loadInitialSheets(), loadInitialLibrary()]).then(([items, snapshot]: [Array<{id:string;title:string;repo?:string}>, LibrarySnapshot | null]) => {
      const requestedSheet = new URLSearchParams(location.search).get('cheatsheet');
      const sheetItems = Array.isArray(items) ? items : [];
      const workspace = requestedWorkspace ?? (snapshot?.workspaceMode ? snapshot.items[0]?.repo : undefined) ?? sheetItems.find((item) => item.id === requestedSheet)?.repo ?? snapshot?.defaultWorkspace;
      const available = snapshot?.workspaceMode ? sheetItems.filter((item) => item.repo === workspace) : sheetItems;
      setCheatsheets(available);
      setLibrary((current) => ({ ...current, items: [...current.items, ...available.filter((sheet) => !current.items.some((item) => item.kind === "cheatsheet" && item.id === sheet.id)).map((sheet, position) => ({ kind: "cheatsheet" as const, id: sheet.id, repo: sheet.repo, categoryId: "uncategorized", position: current.items.length + position, status: "active" as const, statusExplicit: false, manifestTitle: sheet.title, title: sheet.title, tags: [], doneDrills: 0, totalDrills: 0, remainingMinutes: 0, inProgress: false }))] }));
      if (categoryRef.current !== "cheatsheets" || new URLSearchParams(location.search).has("cheatsheet") || !available[0]) return;
      setCheatsheetId(available[0].id);
      localStorage.setItem("interview-runner-cheatsheet", available[0].id);
      const params = new URLSearchParams(location.search);
      for (const key of ["course", "chapter", "drill", "section", "heading"]) params.delete(key);
      params.set("cheatsheet", available[0].id);
      history.replaceState({}, "", `${location.pathname}?${params}${location.hash}`);
    }).catch(() => setCheatsheets([]));
  }, []);
  useEffect(() => {
    if (category !== "cheatsheets" || !cheatsheetId) return;
    const p = new URLSearchParams(location.search);
    for (const k of ["course", "chapter", "drill"]) p.delete(k);
    p.set("cheatsheet", cheatsheetId);
    localStorage.setItem("interview-runner-category", "cheatsheets");
    history.replaceState({}, "", `${location.pathname}?${p}${location.hash}`);
  }, []);
  const selectCheatsheet = (id: string | null) => { categoryRef.current = "cheatsheets"; setCategory("cheatsheets"); localStorage.setItem("interview-runner-category", "cheatsheets"); setCheatsheetId(id); setNavStep("outline"); closeNav(); const p = new URLSearchParams(location.search); for (const k of ["course","chapter","drill","section","heading"]) p.delete(k); if (id) { p.set("cheatsheet", id); localStorage.setItem("interview-runner-cheatsheet", id); } history.replaceState({}, "", `${location.pathname}${p.size ? `?${p}` : ""}`); };
  useEffect(() => {
    if (category !== 'cheatsheets' || !cheatsheetId) { setSheet(null); return; }
    const controller = new AbortController(); pendingSheetHeading.current = null; setSheet(null); setSheetError(null); setSheetContent(null); setNavStep('outline');
    void (async () => {
      try {
        const response = await fetch(`/api/cheatsheets/${encodeURIComponent(cheatsheetId)}`, { signal: controller.signal, cache: 'no-store' });
        let payload: unknown; try { payload = await response.json(); } catch { throw new Error(`Cheatsheet unavailable (${response.status}): invalid response.`); }
        if (!response.ok) throw new Error(payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : `Cheatsheet unavailable (${response.status}).`);
        const data = parseCheatsheet(`${cheatsheetId}.json`, payload);
        if (controller.signal.aborted) return;
        setSheet(data); setSheetHeadingIndex(0);
      } catch (error) { if (!controller.signal.aborted) setSheetError(error instanceof Error ? error.message : 'Cheatsheet unavailable.'); }
    })();
    return () => controller.abort();
  }, [category, cheatsheetId]);
  useEffect(() => {
    if (category !== 'cheatsheets' || !sheet) return;
    const controller = new AbortController(); setSheetContent(null); setSheetContentError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/cheatsheets/${encodeURIComponent(sheet.id)}/content`, { signal: controller.signal, cache: 'no-store' });
        let payload: unknown; try { payload = await response.json(); } catch { throw new Error(`Cheatsheet content unavailable (${response.status}): invalid response.`); }
        if (!response.ok) throw new Error(payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : `Cheatsheet content unavailable (${response.status}).`);
        if (!payload || typeof payload !== 'object' || !('sections' in payload) || !Array.isArray(payload.sections) || !('layout' in payload) || !(payload.layout === null || typeof payload.layout === 'string')) throw new Error('Invalid cheatsheet content response.');
        const lessons = sheet.chapters.flatMap((chapter) => chapter.drills);
        if (payload.sections.length !== lessons.length || payload.sections.some((section: unknown, index: number) => !section || typeof section !== 'object' || !('id' in section) || section.id !== lessons[index].id || !('html' in section) || typeof section.html !== 'string')) throw new Error('Cheatsheet sections do not match the manifest. Refresh and try again.');
        const content = composeCheatsheetContent(payload.layout, payload.sections as Array<{ id: string; html: string }>);
        if (!controller.signal.aborted) setSheetContent(prepareCheatsheetContent(content));
      } catch (error) { if (!controller.signal.aborted) setSheetContentError(error instanceof Error ? error.message : 'Cheatsheet content unavailable.'); }
    })();
    return () => controller.abort();
  }, [category, sheet]);
  useEffect(() => {
    const root = sheetContentRef.current;
    if (sheetContent === null || !root) return;
    const stopFailures = watchCheatsheetDiagramFailures(root);
    const stopCode = watchCheatsheetCodeOverflow(root);
    const stopMaps = hydrateCheatsheetMaps(root, sheet?.id ?? '');
    const stopMermaid = hydrateCheatsheetMermaid(root, sheet?.id ?? '');
    return () => { stopMermaid(); stopMaps(); stopCode(); stopFailures(); };
  }, [sheetContent, sheet?.id]);
  const scrollSheetTarget = (id?: string, anchor?: string, headingIndex?: number, focus = false) => {
    const root = sheetContentRef.current; if (!root) return;
    const target = anchor ? [...root.querySelectorAll('[id]')].find((element) => element.id === anchor) : headingIndex !== undefined ? root.querySelector(`[data-sheet-heading-index="${headingIndex}"]`) : [...root.querySelectorAll('[data-sheet-section]')].find((element) => element.getAttribute('data-sheet-section') === id) ?? [...root.querySelectorAll('[id]')].find((element) => element.id === id);
    if (!target) return;
    const previous = target.previousElementSibling;
    const hero = id && !anchor && headingIndex === undefined ? [...root.querySelectorAll<HTMLElement>('[data-sheet-map-hero]')].find((element) => element.dataset.sheetMapHero === id) : undefined;
    const scrollTarget = hero ?? (!target.matches('h1,h2,h3,h4,h5,h6,article.card') && previous?.matches('h1,h2,h3,h4,h5,h6') ? previous : target);
    sheetJumpCancel.current();
    if (target instanceof HTMLDetailsElement) target.open = true;
    for (let parent = target.parentElement; parent && parent !== root; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
    const enclosing = target instanceof HTMLDetailsElement ? target : target.closest('details');
    if (enclosing) for (const map of enclosing.querySelectorAll<HTMLElement>('[data-markmap-src]')) {
      if (map.getClientRects().length && Boolean(map.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING)) map.dispatchEvent(new Event(CHEATSHEET_HYDRATE_EVENT));
    }
    const disclosure = target instanceof HTMLDetailsElement || Boolean(target.closest('details'));
    const card = headingIndex === undefined ? target.closest('article.card') : null;
    const active = scrollTarget !== target ? scrollTarget : card && (disclosure || !target.hasAttribute('data-sheet-heading-index')) ? card.querySelector('[data-sheet-heading-index]') ?? target : target;
    const index = active.getAttribute('data-sheet-heading-index');
    pendingSheetHeading.current = index === null ? null : Number(index);
    if (index !== null) setSheetHeadingIndex(Number(index));
    scrollTarget.scrollIntoView?.({ block: 'start' });
    if (focus && scrollTarget instanceof HTMLElement) { scrollTarget.setAttribute('tabindex', '-1'); scrollTarget.focus({ preventScroll: true }); }
    let first = 0; let second = 0; let timer: ReturnType<typeof setTimeout> | undefined; let resize: ResizeObserver | undefined; let mutations: MutationObserver | undefined; let stopped = false;
    const cancel = () => { stopped = true; if (first) cancelAnimationFrame(first); if (second) cancelAnimationFrame(second); if (timer) clearTimeout(timer); resize?.disconnect(); mutations?.disconnect(); };
    sheetJumpCancel.current = cancel;
    first = requestAnimationFrame(() => { second = requestAnimationFrame(() => {
      if (stopped || !scrollTarget.isConnected) return;
      scrollTarget.scrollIntoView?.({ block: 'start' }); let baseline = scrollTarget.getBoundingClientRect().top;
      const correct = () => { if (!stopped && scrollTarget.isConnected && Math.abs(scrollTarget.getBoundingClientRect().top - baseline) > 8) { scrollTarget.scrollIntoView?.({ block: 'start' }); baseline = scrollTarget.getBoundingClientRect().top; } };
      resize = new ResizeObserver(correct);
      resize.observe(root); resize.observe(scrollTarget);
      const started = Date.now();
      const pendingMaps = () => [...root.querySelectorAll<HTMLElement>('[data-markmap-src]')].some((map) => Boolean(map.getClientRects().length) && Boolean(map.compareDocumentPosition(target) & Node.DOCUMENT_POSITION_FOLLOWING) && !map.hasAttribute('data-map-ready') && !map.hasAttribute('data-map-error'));
      const finish = () => { if (!stopped && Date.now() - started >= 2000 && !pendingMaps()) { correct(); cancel(); } };
      mutations = new MutationObserver(finish); mutations.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-map-error', 'data-map-ready'] });
      timer = setTimeout(() => { if (!pendingMaps()) { correct(); cancel(); } else timer = setTimeout(() => { correct(); cancel(); }, 3000); }, 2000);
    }); });
  };
  useEffect(() => {
    const root = sheetContentRef.current; const strip = sheetLocationRef.current; const header = sheetHeaderRef.current;
    if (!root || !strip || !header) return;
    const measure = () => root.style.setProperty('--sheet-scroll-offset', `${Math.ceil(header.getBoundingClientRect().height + 8)}px`);
    measure(); const observer = new ResizeObserver(measure); observer.observe(header); observer.observe(strip);
    return () => observer.disconnect();
  }, [sheetContent]);
  const selectSheetHeading = (heading: (typeof sheetView.headings)[number]) => {
    setSheetHeadingIndex(heading.index); closeNav();
    const params = new URLSearchParams(location.search);
    if (heading.sectionId) params.set('section', heading.sectionId); else params.delete('section');
    if (heading.sectionHeading) params.delete('heading'); else params.set('heading', String(heading.index));
    history.replaceState({}, '', `${location.pathname}?${params}`);
    scrollSheetTarget(undefined, undefined, heading.index, mobileNav);
  };
  useEffect(() => {
    const root = sheetContentRef.current; const main = root?.closest('main');
    if (sheetContent === null || !root || !main || !cheatsheetId) return;
    const key = `interview-runner-sheet-scroll:${cheatsheetId}`;
    const url = () => `${location.pathname}${location.search}${location.hash}`;
    let storageError = false; let first = 0; let second = 0;
    const save = () => {
      try { sessionStorage.setItem(key, JSON.stringify({ url: url(), top: main.scrollTop })); }
      catch (error) { if (!storageError) { storageError = true; console.warn('Cheatsheet scroll position could not be saved:', error); } }
    };
    const navigate = () => {
      let anchor = ''; try { anchor = decodeURIComponent(location.hash.slice(1)); } catch { return; }
      const params = new URLSearchParams(location.search); if (params.get('cheatsheet') !== cheatsheetId) return;
      const rawIndex = params.get('heading'); const requestedIndex = rawIndex !== null && /^\d+$/.test(rawIndex) ? Number(rawIndex) : -1;
      const requested = sheetView.headings[requestedIndex];
      if (anchor) scrollSheetTarget(undefined, anchor);
      else if (requested && (!params.has('section') || requested.sectionId === params.get('section'))) scrollSheetTarget(undefined, undefined, requested.index);
      else if (params.has('section')) scrollSheetTarget(params.get('section') ?? undefined);
      else { sheetJumpCancel.current(); pendingSheetHeading.current = null; main.scrollTop = 0; }
    };
    let restored = false;
    try {
      const navigation = performance.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
      const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { url?: unknown; top?: unknown } | null;
      if (navigation?.type === 'reload' && saved?.url === url() && typeof saved.top === 'number' && Number.isFinite(saved.top) && saved.top >= 0) {
        const top = saved.top; main.scrollTop = top; first = requestAnimationFrame(() => { second = requestAnimationFrame(() => { main.scrollTop = top; }); }); restored = true;
      }
    } catch (error) { console.warn('Cheatsheet scroll position could not be restored:', error); }
    if (!restored) navigate();
    main.addEventListener('scroll', save, { passive: true }); window.addEventListener('pagehide', save);
    window.addEventListener('hashchange', navigate); window.addEventListener('popstate', navigate);
    return () => { main.removeEventListener('scroll', save); window.removeEventListener('pagehide', save); window.removeEventListener('hashchange', navigate); window.removeEventListener('popstate', navigate); if (first) cancelAnimationFrame(first); if (second) cancelAnimationFrame(second); sheetJumpCancel.current(); pendingSheetHeading.current = null; };
  }, [sheetContent]);
  useEffect(() => {
    const root = sheetContentRef.current; const main = root?.closest('main');
    if (sheetContent === null || !root || !main) return;
    let frame = 0;
    const update = () => {
      frame = 0; const location = sheetLocationRef.current; const edge = Math.max(main.getBoundingClientRect().top + 1, location && location.getClientRects().length ? location.getBoundingClientRect().bottom + 1 : 0);
      const headings = [...root.querySelectorAll<HTMLElement>('[data-sheet-heading-index]')];
      const pending = pendingSheetHeading.current;
      if (pending !== null && headings[pending]?.getClientRects().length) { setSheetHeadingIndex(pending); return; }
      let current = 0;
      for (let index = 0; index < headings.length; index++) {
        if (headings[index].getClientRects().length && headings[index].getBoundingClientRect().top <= edge) current = index;
      }
      setSheetHeadingIndex(current);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const userScroll = () => { if (pendingSheetHeading.current !== null) { pendingSheetHeading.current = null; sheetJumpCancel.current(); schedule(); } };
    const onKey = (event: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(event.key) || event.target instanceof HTMLElement && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))) return;
      userScroll();
      if (!event.defaultPrevented && !event.altKey && !event.ctrlKey && !event.metaKey && (event.target === document.body || event.target === document.documentElement) && ['PageDown', 'PageUp', ' '].includes(event.key)) {
        event.preventDefault(); const direction = event.key === 'PageUp' || event.key === ' ' && event.shiftKey ? -1 : 1;
        main.scrollBy({ top: direction * main.clientHeight * 0.85, behavior: 'auto' });
      }
    };
    main.addEventListener('scroll', schedule, { passive: true }); main.addEventListener('wheel', userScroll, { passive: true }); main.addEventListener('touchstart', userScroll, { passive: true }); main.addEventListener('pointerdown', userScroll, { passive: true }); window.addEventListener('keydown', onKey); window.addEventListener('resize', schedule);
    return () => { main.removeEventListener('scroll', schedule); main.removeEventListener('wheel', userScroll); main.removeEventListener('touchstart', userScroll); main.removeEventListener('pointerdown', userScroll); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', schedule); if (frame) cancelAnimationFrame(frame); };
  }, [sheetContent]);
  useEffect(() => {
    const panel = sheetPanelRef.current; const current = panel?.querySelector<HTMLElement>('[aria-current="location"]');
    if (!panel || !current) return;
    const bounds = panel.getBoundingClientRect(); const item = current.getBoundingClientRect();
    if (item.top < bounds.top) panel.scrollTop += item.top - bounds.top;
    else if (item.bottom > bounds.bottom) panel.scrollTop += item.bottom - bounds.bottom;
  }, [sheetHeadingIndex, sheetView, navOpened, navStep, wideLibrary, uiState.outlineCollapsed]);
  useEffect(() => {
    if (category !== 'cheatsheets' || sheetContent === null) return;
    document.documentElement.dataset.printCheatsheet = 'true';
    let closed: HTMLDetailsElement[] = [];
    const beforePrint = () => { closed = [...(sheetContentRef.current?.querySelectorAll('details:not([open])') ?? [])] as HTMLDetailsElement[]; closed.forEach((detail) => { detail.open = true; }); };
    const afterPrint = () => { closed.forEach((detail) => { detail.open = false; }); closed = []; };
    window.addEventListener('beforeprint', beforePrint); window.addEventListener('afterprint', afterPrint);
    return () => { afterPrint(); delete document.documentElement.dataset.printCheatsheet; window.removeEventListener('beforeprint', beforePrint); window.removeEventListener('afterprint', afterPrint); };
  }, [category, sheetContent]);
  const updateUi = (update: (state: typeof uiState) => typeof uiState) => {
    setUiStateLocal((current) => { const next = update(current); setUiState(next); return next; });
  };
  useEffect(() => {
    if (library.workspaceMode) return;
    const repoIds = [...new Set(library.items.filter((item) => item.kind === "course" && item.repo).map((item) => item.repo!))].sort();
    if (!repoIds.length) return;
    const linkedCourseId = new URLSearchParams(location.search).get("course");
    const linkedRepo = linkedCourseId ? library.items.find((item) => item.kind === "course" && item.id === linkedCourseId)?.repo : undefined;
    const next = linkedRepo ?? (uiState.courseRepo && repoIds.includes(uiState.courseRepo) ? uiState.courseRepo : repoIds[0]);
    if (next && next !== uiState.courseRepo) updateUi((state) => ({ ...state, courseRepo: next }));
  }, [library.items, course?.id]);
  const openKeyboardShortcuts = (returnTo: HTMLElement | null = document.activeElement instanceof HTMLElement ? document.activeElement : null) => {
    shortcutReturnFocus.current = returnTo;
    setControlsOpened(false);
    setShortcutsOpened(true);
  };
  const closeKeyboardShortcuts = () => {
    setShortcutsOpened(false);
    window.requestAnimationFrame(() => { const target = shortcutReturnFocus.current; if (target?.isConnected) target.focus(); if (!target?.isConnected || document.activeElement !== target) document.querySelector<HTMLElement>('.recall-whiteboard-canvas .excalidraw[tabindex]')?.focus(); });
  };
  const toggleLibrary = () => {
    const active = document.activeElement;
    const restoreControls = active === sidebarControlsTrigger.current || (controlsOpened && active instanceof HTMLElement && Boolean(active.closest('[role="menu"]')));
    if (category === "cheatsheets") {
      if (mobileNav) { setNavStep("library"); if (!navOpened) toggleNav(); setControlsOpened(false); }
      else updateUi((state) => ({ ...state, sheetLibraryCollapsed: !(state.sheetLibraryCollapsed ?? ((viewportWidth || window.innerWidth) < 1600)) }));
    } else updateUi((state) => ({ ...state, sidebarCollapsed: !state.sidebarCollapsed }));
    if (restoreControls) requestAnimationFrame(() => sidebarControlsTrigger.current?.focus());
  };
  const toggleCourseChapters = () => updateUi((state) => ({ ...state, outlineCollapsed: !state.outlineCollapsed }));
  const showKeyboardShortcuts = () => { if (!shortcutsOpened) openKeyboardShortcuts(); };
  const panelHotkey = (action: () => void) => (event: KeyboardEvent) => { const active = document.activeElement; if (active instanceof Element && active.closest('.excalidraw-wysiwyg, .excalidraw-hyperlinkContainer')) return; event.preventDefault(); event.stopPropagation(); action(); };
  useHotkey(hotkeys["panels.library"], panelHotkey(toggleLibrary));
  useHotkey(hotkeys["panels.courseChapters"], panelHotkey(toggleCourseChapters));
  useHotkey(hotkeys["panels.shortcuts"], panelHotkey(showKeyboardShortcuts));
  useSandboxForwardedHotkey("panels.library", toggleLibrary);
  useSandboxForwardedHotkey("panels.courseChapters", toggleCourseChapters);
  useSandboxForwardedHotkey("panels.shortcuts", showKeyboardShortcuts);
  const setLibraryWidth = (width: number) => updateUi((state) => ({ ...state, libraryWidth: clampLibraryWidth(width) }));
  const startLibraryResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!wideLibrary) return;
    event.preventDefault();
    const startX = event.clientX; const startWidth = clampLibraryWidth(uiState.libraryWidth);
    const move = (next: PointerEvent) => setLibraryWidth(startWidth + next.clientX - startX);
    const finish = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish);
  };
  const togglePanel = (id: PanelId) => updateUi((state) => ({ ...state, panels: { ...state.panels, [id]: !state.panels[id] } }));
  const toggleChapter = (courseId: string, chapterId: string) => setOpenChapters((current) => {
    const next = { ...current, [chapterId]: !current[chapterId] };
    updateUi((state) => ({ ...state, chapters: { ...state.chapters, [courseId]: next } }));
    return next;
  });
  // Reference sheets use the heading drawer below tablet landscape; other
  // courses keep the existing `sm` breakpoint.
  const phone = !(useMediaQuery("(min-width: 48em)", true) ?? true);
  const sheetDesktop = useMediaQuery("(min-width: 64em)", true) ?? true;
  const mobileNav = phone || (category === "cheatsheets" && !sheetDesktop);
  const compactCodingNavigation = !(useMediaQuery("(min-width: 75em)", true) ?? true);
  // One rule for all three panes: collapsed hugs its header; expanded takes an equal
  // share of the free space and never drops below 30vh.
  const paneSizing = (collapsed: boolean) => ({
    flexGrow: collapsed ? 0 : 1,
    flexShrink: collapsed ? 0 : 1,
    flexBasis: "auto",
    minHeight: collapsed ? 0 : "30vh",
    overflowX: "hidden",
    overflowY: collapsed ? "hidden" : "scroll",
  }) as const;
  const selected = course?.chapters.flatMap((chapter) => chapter.drills).find((drill) => drill.id === selectedId);
  const selectedAttempts = selected ? attempts[selected.id] ?? [] : [];
  const currentAttempt = selectedAttempts.at(-1);
  const currentAttemptElapsedMs = currentAttempt ? currentAttempt.accumulatedActiveMs + (currentAttempt.activeSince ? Math.max(0, clockNow - Date.parse(currentAttempt.activeSince)) : 0) : 0;
  const priorAttempts = currentAttempt ? selectedAttempts.slice(0, -1) : [];
  const timerDurationMs = Math.max(1, selected?.estMinutes ?? 1) * 60_000;
  const timerKey = `interview-runner-timer:${course?.id ?? ""}/${selected?.id ?? ""}`;
  useEffect(() => {
    if (!course?.id || !selected?.id) return;
    if (selected.contentType === "ai-coding") return;
    const next = readCountdown(localStorage, timerKey, timerDurationMs, Date.now());
    setTimer(next); setClockNow(Date.now()); expiredAnnounced.current = next.remainingMs === 0;
    if (next.remainingMs === 0) setTimerAnnouncement("Time's up");
  }, [course?.id, selected?.id, timerKey, timerDurationMs]);
  useEffect(() => {
    const aiCoding = selected?.contentType === "ai-coding";
    if (aiCoding && attemptsState.status !== "loaded") return;
    if (!currentAttempt) { if (aiCoding) { localStorage.removeItem(timerKey); setTimer(restartCountdown(timerDurationMs)); setClockNow(Date.now()); } return; }
    if (!currentAttempt.activeSince && !aiCoding) return;
    const now = Date.now(); const elapsed = currentAttempt.accumulatedActiveMs + (currentAttempt.activeSince ? Math.max(0, now - Date.parse(currentAttempt.activeSince)) : 0); const resetAt = readCountdownReset(localStorage, timerKey, currentAttempt.attemptNumber, currentAttempt.startedAt); const remainingMs = Math.max(0, timerDurationMs - Math.max(0, elapsed - resetAt));
    const next = remainingMs > 0 && currentAttempt.activeSince ? { remainingMs, endTime: now + remainingMs } : { remainingMs };
    setTimer(next); setClockNow(now); persistCountdown(localStorage, timerKey, next);
  }, [course?.id, selected?.id, selected?.contentType, currentAttempt?.attemptNumber, currentAttempt?.startedAt, currentAttempt?.activeSince, currentAttempt?.accumulatedActiveMs, attemptsState.status, timerDurationMs, timerKey]);
  useEffect(() => {
    if (!timer.endTime || !course?.id || !selected?.id) return;
    const tick = () => {
      const now = Date.now(); setClockNow(now);
      if (countdownRemaining(timer, now) > 0) return;
      const expired = { remainingMs: 0 }; setTimer(expired); persistCountdown(localStorage, timerKey, expired);
      if (!expiredAnnounced.current) { expiredAnnounced.current = true; setTimerAnnouncement("Time's up"); void mutateAttempt("pause"); }
    };
    tick(); const interval = window.setInterval(tick, 250); return () => window.clearInterval(interval);
  }, [timer.endTime, timerKey, course?.id, selected?.id]);
  const commitTimer = (next: CountdownState) => { setTimer(next); setClockNow(Date.now()); persistCountdown(localStorage, timerKey, next); };
  async function mutateAttempt(action: "start" | "pause" | "complete", reset = false): Promise<boolean> {
    if (!course || !selected) return false;
    setAttemptBusy(true);
    try {
      const response = await fetch(`/api/attempts/${encodeURIComponent(course.id)}/${encodeURIComponent(selected.id)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
      const payload = await response.json() as { attempts?: DrillAttempt[]; error?: string };
      if (!response.ok || !Array.isArray(payload.attempts)) throw new Error(payload.error ?? `Attempt could not be ${action === "start" ? "started" : action === "pause" ? "paused" : "completed"}.`);
      const latest = payload.attempts.at(-1);
      if (action === "start" && (!latest?.activeSince || latest.completedAt || !Number.isFinite(Date.parse(latest.activeSince)))) throw new Error("Attempt could not be started.");
      if (reset && latest?.activeSince) persistCountdownReset(localStorage, timerKey, latest.attemptNumber, latest.startedAt, latest.accumulatedActiveMs + Math.max(0, Date.now() - Date.parse(latest.activeSince)));
      setAttempts((current) => ({ ...current, [selected.id]: payload.attempts! }));
      return true;
    } catch (attemptError) {
      setSaveNotice(attemptError instanceof Error ? attemptError.message : "Attempt time could not be saved.");
      return false;
    } finally { setAttemptBusy(false); }
  }
  const startTimer = async (reset = false) => { const restart = reset || countdownRemaining(timer, Date.now()) === 0 || Boolean(currentAttempt?.completedAt); if (!await mutateAttempt("start", restart)) return; expiredAnnounced.current = false; const base = restart ? restartCountdown(timerDurationMs) : timer; commitTimer(startCountdown(base, Date.now())); setTimerAnnouncement(reset ? "Timer restarted" : "Timer started"); };
  const requestStartTimer = () => { if (selected?.contentType === "ai-coding" && currentAttempt?.completedAt) setNewAttemptOpen(true); else void startTimer(); };
  const closeNewAttempt = () => { setNewAttemptOpen(false); window.requestAnimationFrame(() => attemptStartTrigger.current?.focus()); };
  const pauseTimer = () => { const next = pauseCountdown(timer, Date.now()); commitTimer(next); void mutateAttempt("pause"); setTimerAnnouncement(`Timer paused at ${formatTime(next.remainingMs)}`); };
  const resetTimer = () => { if (!attemptBusy) void startTimer(true); };
  const remainingMs = countdownRemaining(timer, clockNow);
  const timerRunning = selected?.contentType === "ai-coding" ? Boolean(currentAttempt?.activeSince && !currentAttempt.completedAt) : timer.endTime !== undefined && remainingMs > 0;
  const whiteboardTimer = <TimerDisplay className="drill-timer" remaining={remainingMs} state={remainingMs === 0 ? 'expired' : timerRunning ? 'running' : 'paused'} label="Time remaining" announcement={timerAnnouncement} actions={<><UIButton variant="secondary" disabled={attemptBusy} leftSection={timerRunning ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />} onClick={timerRunning ? pauseTimer : requestStartTimer}>{timerRunning ? "Pause" : "Start"}</UIButton><UIIconButton label="Restart timer" icon={<IconRestore size={17} aria-hidden="true" />} disabled={attemptBusy} onClick={resetTimer} /></>} />;
  const selectedCheatsheet = cheatsheets.find((item) => item.id === cheatsheetId);
  useEffect(() => {
    if (category === "cheatsheets") {
      document.title = selectedCheatsheet
        ? `${selectedCheatsheet.title} · Cheatsheets`
        : cheatsheetId ? "Cheatsheet unavailable · Cheatsheets" : "Courses";
      return;
    }
    document.title = selected && course
      ? `${selected.title} · ${course.title}`
      : course ? `${course.title} · Courses` : "Courses";
  }, [category, cheatsheetId, selectedCheatsheet, selected, course]);
  const selectedChapter = course?.chapters.find((chapter) => chapter.drills.some((drill) => drill.id === selectedId));
  const selectedChapterDone = selectedChapter?.drills.filter((drill) => progress[drill.id]?.status === "done").length ?? 0;
  const displayedChapters = useMemo(() => {
    if (!course) return [];
    return course.chapters.map((chapter, index) => ({ chapter, index })).sort((a, b) => {
      const ar = chapterRanks[a.chapter.id]; const br = chapterRanks[b.chapter.id];
      if (ar === undefined && br === undefined) return a.index - b.index;
      if (ar === undefined) return 1;
      if (br === undefined) return -1;
      return ar - br || a.index - b.index;
    }).map(({ chapter }) => chapter);
  }, [course, chapterRanks]);

  // The URL carries the whole selection. `chapter` is always derived from the selected
  // drill, so the two params can never describe different places in the course.
  const chapterOfDrill = (data: Course, drillId?: string) => data.chapters.find((chapter) => chapter.drills.some((drill) => drill.id === drillId));
  const updateRoute = (courseId: string, chapterId?: string, drillId?: string) => {
    if (categoryRef.current !== "courses") return;
    const params = new URLSearchParams(window.location.search);
    params.set("course", courseId);
    for (const [key, value] of [["chapter", chapterId], ["drill", drillId]] as const) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  };
  const selectDrill = (data: Course, drillId: string) => {
    setSelectedId(drillId);
    void fetchOutline(data.id, drillId);
    updateRoute(data.id, chapterOfDrill(data, drillId)?.id, drillId);
  };
  const fetchOutline = async (courseId: string, drillId?: string) => {
    const request = ++outlineRequest.current;
    setOutlineState({ status: "loading" });
    setOutlineProgress({ checked: 0, total: 0 });
    const declared = loadedCourseRef.current?.id === courseId ? loadedCourseRef.current.chapters.flatMap((chapter) => chapter.drills).find((drill) => drill.id === drillId) : undefined;
    if (!drillId || declared?.contentType !== "reading" || !declared.outlinePath) {
      if (request === outlineRequest.current) setOutlineState({ status: "absent" });
      return;
    }
    try {
      const response = await fetch(`/api/outlines/${encodeURIComponent(courseId)}/${encodeURIComponent(drillId)}`);
      if (request !== outlineRequest.current) return;
      if (response.status === 404) {
        let payload: unknown;
        try { payload = await response.json(); } catch { /* handled as an unavailable outline below */ }
        if (request !== outlineRequest.current) return;
        if (payload && typeof payload === "object" && !Array.isArray(payload) && (payload as { error?: unknown }).error === `No outline for ${drillId}`) setOutlineState({ status: "absent" });
        else setOutlineState({ status: "error", message: "The course outline could not be loaded (404)." });
        return;
      }
      if (!response.ok) {
        setOutlineState({ status: "error", message: `The course outline could not be loaded (${response.status}).` });
        return;
      }
      const payload = await response.json() as Partial<Outline>;
      if (request !== outlineRequest.current) return;
      if (payload.courseId !== courseId || payload.drillId !== drillId || typeof payload.title !== "string" || !Array.isArray(payload.nodes) || payload.nodes.length === 0) {
        setOutlineState({ status: "error", message: "The course outline returned invalid data." });
        return;
      }
      setOutlineState({ status: "ready", outline: payload as Outline });
    } catch {
      if (request === outlineRequest.current) setOutlineState({ status: "error", message: "The course outline is unavailable. Try again later." });
    }
  };
  const fetchCourse = async (id: string, chapterId?: string, drillId?: string) => {
    const request = ++courseRequest.current;
    ++outlineRequest.current;
    setOutlineState({ status: "loading" });
    setOutlineProgress({ checked: 0, total: 0 });
    let data: Course;
    try {
      const response = await fetch(`/api/courses/${encodeURIComponent(id)}`, { headers: learnerTimeZoneHeaders() });
      if (!response.ok) throw new Error(`Unable to load course (${response.status})`);
      data = parseCourse(`${id}.json`, await response.json(), false);
    } catch (cause) {
      if (request === courseRequest.current) setError(cause instanceof Error ? cause.message : 'Unable to load course');
      return;
    }
    if (request !== courseRequest.current) return;
    // A drill id only wins if the course actually contains it; otherwise fall back to
    // the requested chapter, then to the first chapter.
    loadedCourseRef.current = data;
    const drillChapter = chapterOfDrill(data, drillId);
    const selectedChapter = drillChapter ?? data.chapters.find((chapter) => chapter.id === chapterId) ?? data.chapters[0];
    const selectedDrillId = (drillChapter ? drillId : undefined) ?? selectedChapter?.drills[0]?.id;
    setError(null); setCourse(data); setSelectedId(selectedDrillId); localStorage.setItem("interview-runner-course", id);
    setProgress({});
    setAttempts({});
    setAttemptsState({ status: "loading" });
    setProgressHydratedCourseId(null);
    setProgressLoadFailed(false);
    setChapterRanks({});
    setSaveNotice(null);
    updateRoute(id, selectedChapter?.id, selectedDrillId);
    const persisted = getUiState().chapters[id] ?? {};
    setOpenChapters(Object.fromEntries(data.chapters.map((chapter) => [chapter.id, persisted[chapter.id] ?? true])));
    void fetchOutline(id, selectedDrillId);
    try { const p = await fetch(`/api/progress/${encodeURIComponent(id)}`); if (!p.ok) throw new Error('Progress unavailable'); const payload = await p.json() as Record<string, ProgressRecord>; if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error('Invalid progress'); if (request === courseRequest.current) { setProgress(payload); setProgressHydratedCourseId(id); if (!drillId) { const resumePool = chapterId ? data.chapters.find((chapter) => chapter.id === chapterId)?.drills ?? [] : data.chapters.flatMap((chapter) => chapter.drills); const resume = resumePool.find((drill) => payload[drill.id]?.status !== "done"); if (resume && resume.id !== selectedDrillId) { setSelectedId(resume.id); updateRoute(id, chapterOfDrill(data, resume.id)?.id, resume.id); void fetchOutline(id, resume.id); } } } } catch { if (request === courseRequest.current) setProgressLoadFailed(true); }
    await fetchAttempts(id, request);
    try { const r = await fetch(`/api/book-chapter-rank/${encodeURIComponent(id)}`); const payload = await r.json(); if (request === courseRequest.current) setChapterRanks(payload && typeof payload === "object" && !Array.isArray(payload) ? Object.fromEntries(Object.entries(payload).filter(([, value]) => typeof value === "number")) as Record<string, number> : {}); } catch { if (request === courseRequest.current) setChapterRanks({}); }
  };
  async function fetchAttempts(id: string, request = courseRequest.current) {
    setAttemptsState({ status: "loading" });
    try {
      const response = await fetch(`/api/attempts/${encodeURIComponent(id)}`, { headers: learnerTimeZoneHeaders() });
      const payload = await response.json() as { attempts?: unknown; error?: string };
      if (!response.ok || !payload.attempts || typeof payload.attempts !== "object" || Array.isArray(payload.attempts)) throw new Error(payload.error || response.statusText || `Attempts could not be loaded (${response.status}).`);
      if (request === courseRequest.current) { setAttempts(payload.attempts as Record<string, DrillAttempt[]>); setAttemptsState({ status: "loaded" }); }
    } catch (cause) {
      if (request === courseRequest.current) setAttemptsState({ status: "failed", message: cause instanceof Error ? cause.message : "Attempts could not be loaded." });
    }
  }
  useEffect(() => {
    Promise.all([loadInitialCourses(), loadInitialLibrary()]).then(async ([items, snapshot]: [typeof courses, LibrarySnapshot | null]) => {
      if (!Array.isArray(items)) throw new Error("Unable to load courses");
      if (requestedWorkspace && (!snapshot || !Array.isArray(snapshot.categories) || !Array.isArray(snapshot.items))) throw new Error('Workspace library could not be loaded');
      if (snapshot && Array.isArray(snapshot.categories) && Array.isArray(snapshot.items)) setLibrary(snapshot);
      const workspace = snapshot?.workspaceMode ? requestedWorkspace ?? items.find((item) => item.id === requestedCourseId)?.repo ?? snapshot.items.find((item) => item.kind === 'cheatsheet' && item.id === new URLSearchParams(location.search).get('cheatsheet'))?.repo ?? snapshot.defaultWorkspace : undefined;
      if (workspace) {
        updateUi((state) => ({ ...state, courseRepo: workspace }));
        const params = new URLSearchParams(location.search); params.set('workspace', workspace);
        history.replaceState({}, '', `${location.pathname}?${params}${location.hash}`);
      }
      const visible = workspace ? items.filter((item) => item.repo === workspace) : items;
      setCourses(items);
       setLibrary((current) => ({ ...current, items: [...current.items, ...visible.filter((summary) => !current.items.some((item) => item.kind === "course" && item.id === summary.id)).map((summary, position) => ({ kind: "course" as const, id: summary.id, repo: summary.repo, categoryId: "uncategorized", position: current.items.length + position, status: "active" as const, statusExplicit: false, manifestTitle: summary.title, title: summary.title, company: summary.company, role: summary.role, tier: summary.tier, deadline: summary.deadline, tags: summary.tags ?? [], doneDrills: 0, totalDrills: summary.drillCount, remainingMinutes: 0, inProgress: false }))] }));
      const initial = requestedCourseId ? visible.find((item) => item.id === requestedCourseId) : visible.find((item) => item.id === storedCourseId) ?? visible[0];
      if (category === "cheatsheets") return;
      if (requestedCourseId && !initial) {
        setError(`Unknown course "${requestedCourseId}". Available course ids: ${visible.map((item) => item.id).join(", ")}`);
        return;
      }
      const fromUrl = initial?.id === requestedCourseId;
      if (initial) void fetchCourse(initial.id, fromUrl ? requestedChapterId ?? undefined : undefined, fromUrl ? requestedDrillId ?? undefined : undefined);
    }).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    // jsdom and older embedded webviews may not expose EventSource. The real
    // browser uses the stream; this one-shot fallback keeps the initial view
    // useful without reintroducing polling.
    if (typeof EventSource === "undefined") {
      void fetch("/api/test-results").then((response) => response.ok ? response.json() : null).then((payload) => { if (payload) setResults(payload as TestResults); }).catch(() => { /* watcher may be offline */ });
      return;
    }
    const source = new EventSource("/api/test-results/stream");
    const applySnapshot = (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as TestResults;
        setResults(payload.files ? { ...payload, files: Object.fromEntries(Object.entries(payload.files).filter(([path]) => isManifestKey(path))) } : payload);
      } catch { /* malformed updates are ignored */ }
    };
    const applyUpdate = (event: MessageEvent<string>) => {
      try {
        const update = JSON.parse(event.data) as { courseId?: string; chapterId?: string; drillId?: string; testPath?: string; result?: TestFile };
        if (!update.courseId || !update.chapterId || !update.drillId || !update.testPath || !isManifestKey(update.testPath) || !update.result) return;
        // Keep every update. The rendered result is selected from this stable identity,
        // rather than dropping events for drills which are currently off screen.
        setResults((current) => {
          const { reason: _staleReason, ...base } = current ?? { available: true };
          return { ...base, available: true, files: { ...(current?.files ?? {}), [update.testPath!]: update.result! } };
        });
      } catch { /* malformed updates are ignored */ }
    };
    source.addEventListener("snapshot", applySnapshot);
    source.addEventListener("test-result", applyUpdate);
    return () => { source.removeEventListener("snapshot", applySnapshot); source.removeEventListener("test-result", applyUpdate); source.close(); };
  }, []);

  const saveCourseTags = async (tags: string[]) => {
    if (!course) throw new Error("Choose a course before editing tags.");
    const response = await fetch(`/api/courses/${encodeURIComponent(course.id)}/tags`, { method: "PUT", headers: { "Content-Type": "application/json", ...learnerTimeZoneHeaders() }, body: JSON.stringify({ tags }) });
    const payload = await response.json() as { tags?: string[]; error?: string };
    if (!response.ok || !Array.isArray(payload.tags)) throw new Error(payload.error ?? `Tags could not be saved (${response.status}).`);
    setCourse((current) => current?.id === course.id ? { ...current, tags: payload.tags } : current);
    setCourses((current) => current.map((item) => item.id === course.id ? { ...item, tags: payload.tags } : item));
    setLibrary((current) => ({ ...current, items: current.items.map((item) => item.kind === "course" && item.id === course.id ? { ...item, tags: payload.tags! } : item) }));
  };
  const updateStatus = useCallback(async (status: Status, allowBlockedOverwrite = false) => {
    if (!course || !selected) return;
    if (progressRef.current[selected.id]?.status === status) return;
    if (progressRef.current[selected.id]?.status === "blocked" && !allowBlockedOverwrite) return;
    if (status === "in-progress" && progressRef.current[selected.id]?.status === "done") return;
    const courseId = course.id;
    const drillId = selected.id;
    const whiteboard = isWhiteboardDrill(selected);
    const generation = courseRequest.current;
    try {
      const r = await fetch(`/api/progress/${encodeURIComponent(courseId)}/${encodeURIComponent(drillId)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
      if (r.ok) {
        const record = await r.json() as ProgressRecord;
        if (generation === courseRequest.current && courseId === course?.id) { setProgress((current) => ({ ...current, [drillId]: record })); if (whiteboard && course.type === 'map-recall') recallProgress.update(drillId, { checked: record.status === 'done' ? 1 : 0, total: 1 }); }
        if (whiteboard) { try { const response = await fetch(libraryUrl()); if (!response.ok) throw new Error('Library progress refresh failed'); const snapshot = await response.json() as LibrarySnapshot; if (generation === courseRequest.current) setLibrary(snapshot); } catch { if (generation === courseRequest.current) setSaveNotice('Progress was saved, but Library progress could not be refreshed.'); } }
        else if (status === "done") { commitTimer(pauseCountdown(timer, Date.now())); try { const response = await fetch(`/api/attempts/${encodeURIComponent(courseId)}`, { headers: learnerTimeZoneHeaders() }); const payload = await response.json() as { attempts?: unknown }; if (response.ok && payload.attempts && typeof payload.attempts === "object" && !Array.isArray(payload.attempts) && generation === courseRequest.current) setAttempts(payload.attempts as Record<string, DrillAttempt[]>); } catch { /* the completion is durable even if this refresh fails */ } }
      } else if (generation === courseRequest.current && courseId === course?.id) setSaveNotice(whiteboard ? "Whiteboard completion could not be saved." : "Progress could not be saved. Your local selection will remain visible.");
    } catch {
      if (generation === courseRequest.current && courseId === course?.id) setSaveNotice(whiteboard ? "Whiteboard completion could not be saved." : "Progress could not be saved. Your local selection will remain visible.");
    }
  }, [course?.id, course?.type, selected?.id, selected?.contentType, selected?.contentType === 'recall' ? selected.whiteboard : undefined, timer, recallProgress.update]);
  const onReaderComplete = useCallback((complete: boolean) => {
    void updateStatus(complete ? "done" : "in-progress");
  }, [updateStatus]);
  const whiteboardCompletion = selected && (isWhiteboardDrill(selected) || (selected.contentType === 'map' && course?.type !== 'map-recall')) ? <Group gap="xs"><UIButton variant="secondary" disabled={progressHydratedCourseId !== course?.id} loading={whiteboardStatusBusy} onClick={() => { setWhiteboardStatusBusy(true); void updateStatus(progress[selected.id]?.status === 'done' ? 'not-started' : 'done', true).finally(() => setWhiteboardStatusBusy(false)); }}>{progress[selected.id]?.status === 'done' ? 'Mark not done' : 'Mark as done'}</UIButton>{progressLoadFailed && <Text size="xs" style={{ color: 'var(--ir-color-danger)' }}>Progress unavailable. Reload to try again.</Text>}</Group> : undefined;
  const codingDrill = category === 'courses' && (selected?.contentType === "coding" || selected?.contentType === "ai-coding");
  const readingOutline = category === 'courses' && selected?.contentType === "reading" && Boolean(selected.outlinePath);
  const selectedKey = course && selected ? `${course.id}/${selected.id}` : undefined;
  const previewCollapsed = selectedKey ? previewOverrides[selectedKey] ?? true : true;
  const togglePreview = () => {
    if (!selectedKey) return;
    setPreviewOverrides((current) => ({ ...current, [selectedKey]: !previewCollapsed }));
  };
  const resultKey = selected?.testPath ?? (selected?.contentType === "ai-coding" ? selected.workspacePath : undefined);
  const reportEntry = useMemo(() => results?.available && resultKey ? results.files?.[resultKey] : undefined, [results, resultKey]);
  const doReset = async () => {
    if (!course || !resetChapter) return;
    const response = await fetch(`/api/progress/${encodeURIComponent(course.id)}/reset`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapterId: resetChapter.id }) });
    if (response.ok) {
      const resetIds = new Set(resetChapter.drills.map((drill) => drill.id));
      setProgress((current) => Object.fromEntries(Object.entries(current).map(([id, record]) => [id, resetIds.has(id) ? { ...record, status: "not-started" } : record]))); setHintResetVersion((current) => current + 1);
    }
    setResetChapter(null);
    close();
  };
  const openLibraryItem = (item: LibraryItem) => {
    if (item.kind === "cheatsheet") { setNavStep("library"); selectCheatsheet(item.id); return; }
    categoryRef.current = "courses"; setCategory("courses"); localStorage.setItem("interview-runner-category", "courses"); if (item.repo) updateUi((state) => ({ ...state, courseRepo: item.repo }));
    const params = new URLSearchParams(location.search); params.delete("cheatsheet"); params.delete("section"); params.delete("heading"); params.set("course", item.id); for (const key of ["chapter", "drill"]) params.delete(key); history.replaceState({}, "", `${location.pathname}?${params}`);
    setNavStep("outline"); void fetchCourse(item.id); if (wideLibrary) closeNav();
  };
  const activeLibraryKey = category === "cheatsheets" && cheatsheetId ? `cheatsheet:${cheatsheetId}` : course ? `course:${course.id}` : undefined;
  const selectedLibraryCourse = library.items.find((item) => item.kind === "course" && item.id === course?.id);
  const selectedDeadline = selectedLibraryCourse ? selectedLibraryCourse.deadline : course?.deadline;
  // This panel is the course's chapter/drill navigator, not the optional reader
  // outline. Only show it when the current course has something to navigate.
  const hasCourseOutline = category === "courses" && Boolean(course) && displayedChapters.some((chapter) => chapter.drills.length > 0);
  const hasSheetOutline = category === 'cheatsheets' && Boolean(sheet);
  const overlayNavigation = Boolean(category === 'courses' && selected?.contentType === "ai-coding" && currentAttempt && !currentAttempt.completedAt && compactCodingNavigation && !mobileNav);
  const baseCourseOutlinePresent = (hasCourseOutline || hasSheetOutline) && (mobileNav ? navStep === "outline" : !uiState.outlineCollapsed);
  const baseLibraryPresent = mobileNav ? navStep === "library" : category === "cheatsheets" ? !sheetLibraryCollapsed : !uiState.sidebarCollapsed;
  const courseOutlinePresent = !overlayNavigation && baseCourseOutlinePresent;
  const libraryPresent = !overlayNavigation && baseLibraryPresent;
  useEffect(() => { if (mobileNav || category !== 'cheatsheets' || !courseOutlinePresent || !sheet) { sheetResize.current = null; setResizingSheetHeadings(false); } }, [mobileNav, category, courseOutlinePresent, sheet]);
  const switchCourseRepo = (courseRepo: string) => {
    if (!library.workspaceMode) { updateUi((state) => ({ ...state, courseRepo })); return; }
    const params = new URLSearchParams(location.search); params.set('workspace', courseRepo);
    for (const key of ['course', 'chapter', 'drill', 'cheatsheet', 'section', 'heading']) params.delete(key);
    location.assign(`${location.pathname}?${params}`);
  };
  const selectLibraryItem = (item: LibraryItem) => { openLibraryItem(item); closeWorkspaceNav(); };
  const menuCommands: MenuCommand[] = [
    { id: "library", label: (category === "cheatsheets" ? sheetLibraryCollapsed : uiState.sidebarCollapsed) ? "Show library" : "Hide library", icon: <IconLibrary aria-hidden="true" size={16} />, hotkey: "panels.library", onClick: toggleLibrary },
    ...(hasCourseOutline || hasSheetOutline ? [{ id: "chapters", label: uiState.outlineCollapsed ? "Show course chapters" : "Hide course chapters", icon: <IconChevronRight aria-hidden="true" size={16} />, hotkey: "panels.courseChapters" as const, onClick: toggleCourseChapters }] : []),
    { id: "shortcuts", label: "Keyboard shortcuts", icon: <IconKeyboard aria-hidden="true" size={16} />, hotkey: "panels.shortcuts", onClick: () => openKeyboardShortcuts(sidebarControlsTrigger.current) },
    { id: "system", label: "System", icon: <IconDeviceDesktop aria-hidden="true" size={16} />, onClick: () => setColorScheme("auto") },
    { id: "light", label: "Light", icon: <IconSun aria-hidden="true" size={16} />, onClick: () => setColorScheme("light") },
    { id: "dark", label: "Dark", icon: <IconMoon aria-hidden="true" size={16} />, onClick: () => setColorScheme("dark") },
  ];
  const savedLibraryWidth = clampLibraryWidth(uiState.libraryWidth);
  const sheetLibraryLimit = Math.max(LIBRARY_WIDTH_MIN, (viewportWidth || window.innerWidth) - (courseOutlinePresent ? 256 : 0) - 768);
  const libraryWidth = category === "cheatsheets" && !mobileNav ? Math.min(savedLibraryWidth, sheetLibraryLimit) : savedLibraryWidth;
  const sheetHeadingsMax = Math.max(SHEET_HEADINGS_MIN, Math.min(SHEET_HEADINGS_MAX, (viewportWidth || window.innerWidth) - (libraryPresent ? libraryWidth : 0) - 512));
  const sheetHeadingsWidth = clampSheetHeadingsWidth(savedSheetHeadingsWidth, sheetHeadingsMax);
  const setSheetHeadingsWidth = (value: number) => {
    const width = clampSheetHeadingsWidth(value, sheetHeadingsMax);
    setSavedSheetHeadingsWidth(width);
    try { localStorage.setItem(SHEET_HEADINGS_WIDTH_KEY, String(width)); } catch { /* Keep the width for this session when storage is unavailable. */ }
  };
  const narrowMapNav = course?.type === 'map-recall' && !mobileNav && !wideLibrary;
  const navbarWidth = category === "cheatsheets" && !mobileNav ? (libraryPresent ? libraryWidth : 0) + (courseOutlinePresent ? sheetHeadingsWidth : 0) : narrowMapNav ? (libraryPresent ? 210 : 0) + (courseOutlinePresent ? 240 : 0) : courseNavigationWidth(mobileNav, wideLibrary, courseOutlinePresent, libraryWidth, libraryPresent);
  const mapSurface = category === 'courses' && selected?.contentType === 'map';
  const showSheetLocation = category === "cheatsheets" && sheetContent !== null && !sheetError && !sheetContentError;
  const sidebarControls = <div data-testid="sidebar-controls" data-floating="true" data-opened={controlsOpened || undefined} onKeyDownCapture={(event) => { if (event.key === "Escape" && controlsOpened) { event.preventDefault(); event.stopPropagation(); setControlsOpened(false); requestAnimationFrame(() => sidebarControlsTrigger.current?.focus()); } }}>
           <Menu opened={controlsOpened} onChange={setControlsOpened} trigger="click" position="top-start" offset={8} shadow="md" width={280} transitionProps={{ duration: 0 }} withinPortal={!mapFullscreen} keepMounted closeOnItemClick={false} closeOnEscape={false}>
            <Menu.Target><IconButton ref={sidebarControlsTrigger} variant="primary" data-testid="sidebar-controls-trigger" label="Sidebar and theme controls" tooltipDisabled={controlsOpened} icon={<IconAdjustments size={20} aria-hidden="true" />} /></Menu.Target>
           <Menu.Dropdown style={{ background: 'var(--ir-color-canvas)', color: 'var(--ir-color-text)', boxShadow: 'var(--ir-shadow-overlay)' }} onKeyDownCapture={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setControlsOpened(false); requestAnimationFrame(() => sidebarControlsTrigger.current?.focus()); } }}>
             <Menu.Label>Sidebars</Menu.Label>
               {menuCommands.filter((item) => item.id === "library" || item.id === "chapters").map((item) => { const checked = item.id === "library" ? !(category === "cheatsheets" ? sheetLibraryCollapsed : uiState.sidebarCollapsed) : !uiState.outlineCollapsed; return <SemanticMenuItem key={item.id} role="menuitemcheckbox" checked={checked} leftSection={item.icon} rightSection={checked ? <IconCheck aria-hidden="true" size={16} /> : null} onClick={item.onClick}><span>{item.label} <Text component="span" size="xs" c="dimmed">({shortcutInline(hotkeys[item.hotkey!].hotkey)})</Text></span></SemanticMenuItem>; })}
              {menuCommands.filter((item) => item.id === "shortcuts").map((item) => <Menu.Item key={item.id} leftSection={item.icon} onClick={item.onClick}><span>{item.label} <Text component="span" size="xs" c="dimmed">({shortcutInline(hotkeys[item.hotkey!].hotkey)})</Text></span></Menu.Item>)}
            <Menu.Divider /><Menu.Label>Theme · {themeModeLabel}</Menu.Label>
             {menuCommands.filter((item) => ["system", "light", "dark"].includes(item.id)).map((item) => { const checked = colorScheme === (item.id === "system" ? "auto" : item.id); return <SemanticMenuItem key={item.id} role="menuitemradio" checked={checked} leftSection={item.icon} rightSection={checked ? <IconCheck size={16} /> : null} testId={item.id === "system" ? "theme-persistent" : undefined} onClick={item.onClick}>{item.label}</SemanticMenuItem>; })}
          </Menu.Dropdown>
         </Menu>
       </div>;
  const libraryPanel = <div style={{ width: overlayNavigation ? "min(22rem, 50%)" : mobileNav ? "100%" : narrowMapNav ? 210 : wideLibrary ? libraryWidth : "100%", height: "100%", position: "relative", flexShrink: 0 }}><LibraryPanel snapshot={library} activeKey={activeLibraryKey} courseRepo={uiState.courseRepo} onCourseRepoChange={switchCourseRepo} expanded={uiState.libraryExpanded} onExpandedChange={(key, open) => updateUi((state) => ({ ...state, libraryExpanded: { ...state.libraryExpanded, [key]: open } }))} onOpen={selectLibraryItem} onChange={setLibrary} />{wideLibrary && !overlayNavigation && !mobileNav && <div className="library-resizer" role="separator" aria-orientation="vertical" aria-label="Resize Library" aria-valuemin={LIBRARY_WIDTH_MIN} aria-valuemax={category === "cheatsheets" ? Math.min(LIBRARY_WIDTH_MAX, sheetLibraryLimit) : LIBRARY_WIDTH_MAX} aria-valuenow={libraryWidth} tabIndex={0} onPointerDown={startLibraryResize} onDoubleClick={() => setLibraryWidth(LIBRARY_WIDTH_DEFAULT)} onKeyDown={(event) => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); setLibraryWidth(libraryWidthForKey(libraryWidth, event.key, event.shiftKey)); }} style={{ position: "absolute", zIndex: 5, top: 0, bottom: 0, right: -4, width: 8, cursor: "col-resize" }} />}</div>;
  const outlinePanel = <aside aria-label="Course outline" data-map-recall={course?.type === 'map-recall' || undefined} style={{ width: mobileNav ? "100%" : narrowMapNav ? 240 : wideLibrary ? "20rem" : "18.5rem", height: "100%", overflowY: "auto", borderLeft: !mobileNav && libraryPresent ? "1px solid var(--mantine-color-default-border)" : undefined, padding: "var(--mantine-spacing-sm)", flexShrink: 0 }}>
    {mobileNav && <Button variant="subtle" fullWidth justify="flex-start" h={44} mb="xs" leftSection={<IconChevronRight size={16} style={{ transform: "rotate(180deg)" }} />} onClick={() => setNavStep("library")}>Back to Library</Button>}
    {course ? <>{selectedDeadline && <HeadingDeadline value={selectedDeadline} active={selectedLibraryCourse?.status !== 'done' && selectedLibraryCourse?.status !== 'archived'} />}<Text component="h2" fw={700} size="lg" data-testid="selected-course-label">{selectedLibraryCourse?.title ?? course.title}</Text>
      {course.type === 'map-recall' && <Text size="sm" c="dimmed">Map + recall · {course.chapters.flatMap((chapter) => chapter.drills).filter((drill) => drill.contentType === 'map').length} reference map{course.chapters.flatMap((chapter) => chapter.drills).filter((drill) => drill.contentType === 'map').length === 1 ? '' : 's'} · {course.chapters.flatMap((chapter) => chapter.drills).filter((drill) => drill.contentType === 'recall' || drill.contentType === 'whiteboard').length} recall lessons</Text>}
      <CourseTags key={course.id} tags={course.tags ?? []} onSave={saveCourseTags} onEditingChange={setTagsEditing} />
      {course.type === 'map-recall' ? <>{recallProgress.error && <Alert color="red" role="alert" title="Recall progress unavailable">{recallProgress.error}<Button mih={44} variant="subtle" onClick={recallProgress.retry}>Retry</Button></Alert>}{displayedChapters.map((chapter) => {
        const questions = chapter.drills.filter((drill) => drill.contentType === 'recall' || drill.contentType === 'whiteboard');
        const hasWhiteboards = questions.some(isWhiteboardDrill);
        const known = questions.every((drill) => recallProgress.values[drill.id]);
        const total = questions.reduce((sum, drill) => sum + (recallProgress.values[drill.id]?.total ?? 0), 0);
        const checked = questions.reduce((sum, drill) => sum + (recallProgress.values[drill.id]?.checked ?? 0), 0);
        const chapterOpen = Boolean(openChapters[chapter.id]);
        return <Panel key={chapter.id} label={chapter.title} padding="sm" style={{ marginBottom: 'var(--mantine-spacing-xs)' }}><NavLink component="button" mih={44} label={<Text size="sm" fw={600}>{chapter.title}</Text>} rightSection={<Group gap="xs">{known && total > 0 && <StatusBadge size="sm">{`${checked}/${total} ${hasWhiteboards ? 'completed' : 'recalled'}`}</StatusBadge>}{chapterOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}</Group>} aria-expanded={chapterOpen} onClick={() => toggleChapter(course.id, chapter.id)} />{known && total > 0 && <Progress aria-label={`${chapter.title} ${hasWhiteboards ? 'completion' : 'recall'} progress: ${checked} of ${total}`} value={checked / total * 100} size="xs" mt={4} />}<Collapse in={chapterOpen}><Stack gap={2} mt="xs">{chapter.drills.map((drill) => { const value = recallProgress.values[drill.id]; const detail = drill.contentType === 'map' ? 'Reference · not counted' : isWhiteboardDrill(drill) ? value ? `Whiteboard · ${value.checked ? 'Done' : 'Not done'}` : 'Whiteboard · progress unavailable' : value ? value.total ? `Recall · ${value.checked}/${value.total} recalled` : 'No recall questions available' : 'Recall · progress unavailable'; return <NavLink component="button" mih={44} key={drill.id} active={drill.id === selectedId} aria-label={`${drill.title} ${detail}`} onClick={() => { selectDrill(course, drill.id); closeNav(); }} leftSection={<ContentTypeIcon type={drill.contentType} whiteboard={isWhiteboardDrill(drill)} />} label={<Text size="sm">{drill.title}{' '}</Text>} description={detail} rightSection={value && value.total > 0 && value.checked === value.total ? <StatusIcon status="done" /> : undefined} />; })}</Stack></Collapse></Panel>;
      })}</> : displayedChapters.map((chapter) => { const done = chapter.drills.filter((d) => progress[d.id]?.status === "done").length; const blocked = chapter.drills.filter((d) => progress[d.id]?.status === "blocked").length; const chapterOpen = Boolean(openChapters[chapter.id]); return <Panel key={chapter.id} label={chapter.title} padding="sm" style={{ marginBottom: 'var(--mantine-spacing-xs)' }}><NavLink component="button" mih={44} label={<Text size="sm" fw={600} truncate>{chapter.title}</Text>} rightSection={<Group gap="xs">{blocked > 0 && <StatusBadge role="img" tone="danger" size="sm" aria-label={`${blocked} blocked ${blocked === 1 ? "drill" : "drills"}`}>{`🚫 ${blocked}`}</StatusBadge>}<StatusBadge size="sm">{`${done}/${chapter.drills.length}`}</StatusBadge>{chapterOpen ? <IconChevronDown aria-hidden="true" size={14} /> : <IconChevronRight aria-hidden="true" size={14} />}</Group>} aria-expanded={chapterOpen} onClick={() => toggleChapter(course.id, chapter.id)} /><Progress aria-label={`${chapter.title} progress: ${done} of ${chapter.drills.length} drills complete`} value={chapter.drills.length ? done / chapter.drills.length * 100 : 0} size="xs" mt={4} /><Collapse in={chapterOpen}><Stack gap={2} mt="xs">{chapter.drills.map((drill) => { const drillStatus = progress[drill.id]?.status ?? "not-started"; const whiteboard = isWhiteboardDrill(drill); return <NavLink component="button" mih={44} key={drill.id} active={drill.id === selectedId} aria-label={`${drill.title} ${drill.estMinutes}m, ${whiteboard ? 'Whiteboard' : drill.contentType}, ${drillStatus.replace("-", " ")}, ${drill.estMinutes} minutes`} onClick={() => { selectDrill(course, drill.id); closeNav(); }} leftSection={<ContentTypeIcon type={drill.contentType} whiteboard={whiteboard} />} label={<Text size="sm" truncate>{drill.title}{' '}</Text>} rightSection={<Group gap={4} wrap="nowrap"><StatusIcon status={drillStatus} /><StatusBadge tone="info" size="sm">{`${drill.estMinutes}m`}</StatusBadge></Group>} />; })}{chapter.drills.length === 0 && <Text c="dimmed" size="sm">No drills in this chapter</Text>}<Button variant="danger" size="sm" leftSection={<IconX size={13} />} onClick={() => { setResetChapter(chapter); open(); }}>Reset chapter</Button></Stack></Collapse></Panel>; })}
      {displayedChapters.length === 0 && <Text c="dimmed">This course has no drills.</Text>}</> : <Text c="dimmed">Choose a course from Library.</Text>}
  </aside>;
  const sheetPanel = <div style={{ width: mobileNav ? "100%" : sheetHeadingsWidth, height: "100%", position: "relative", flexShrink: 0 }}><aside ref={sheetPanelRef} aria-label="Cheatsheet headings" style={{ width: "100%", height: "100%", overflowY: "auto", borderLeft: !mobileNav && libraryPresent ? "1px solid var(--mantine-color-default-border)" : undefined, padding: "var(--mantine-spacing-sm)" }}>
    {mobileNav && <Button variant="subtle" fullWidth justify="flex-start" h={44} mb="xs" leftSection={<IconChevronRight size={16} style={{ transform: "rotate(180deg)" }} />} onClick={() => setNavStep("library")}>Back to Library</Button>}
    {sheet && <><Group justify="space-between" wrap="nowrap"><Text component="h2" fw={700} size="lg">{library.items.find((item) => item.kind === 'cheatsheet' && item.id === sheet.id)?.title ?? sheet.title}</Text></Group><nav aria-label="Page headings"><ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{sheetView.headings.map((heading) => <li key={heading.index} data-heading-level={heading.level}><NavLink className="cheatsheet-heading-link" style={{ paddingInlineStart: `calc(var(--mantine-spacing-sm) + ${Math.min(Math.max(heading.level - 2, 0), 3) * 12}px)` }} component="button" mih={44} active={sheetHeadingIndex === heading.index} aria-current={sheetHeadingIndex === heading.index ? 'location' : undefined} onClick={() => selectSheetHeading(heading)} label={<Text size="sm" fw={heading.level === 2 || sheetHeadingIndex === heading.index ? 600 : 400}>{heading.title}</Text>} /></li>)}</ul></nav></>}
  </aside>{!mobileNav && sheet && <div className="sheet-headings-resizer" role="separator" aria-label="Resize Page headings" aria-orientation="vertical" aria-valuemin={SHEET_HEADINGS_MIN} aria-valuemax={sheetHeadingsMax} aria-valuenow={sheetHeadingsWidth} tabIndex={0}
    onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); sheetResize.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: sheetHeadingsWidth }; event.currentTarget.setPointerCapture(event.pointerId); setResizingSheetHeadings(true); }}
    onPointerMove={(event) => { const drag = sheetResize.current; if (drag?.pointerId === event.pointerId) setSheetHeadingsWidth(drag.startWidth + event.clientX - drag.startX); }}
    onPointerUp={(event) => { if (sheetResize.current?.pointerId === event.pointerId) { sheetResize.current = null; setResizingSheetHeadings(false); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); } }}
    onPointerCancel={() => { sheetResize.current = null; setResizingSheetHeadings(false); }} onLostPointerCapture={() => { sheetResize.current = null; setResizingSheetHeadings(false); }}
    onDoubleClick={() => setSheetHeadingsWidth(SHEET_HEADINGS_DEFAULT)} onKeyDown={(event) => { const delta = event.shiftKey ? 32 : 8; const next = event.key === 'Home' ? SHEET_HEADINGS_MIN : event.key === 'End' ? sheetHeadingsMax : event.key === 'ArrowLeft' ? sheetHeadingsWidth - delta : event.key === 'ArrowRight' ? sheetHeadingsWidth + delta : null; if (next !== null) { event.preventDefault(); setSheetHeadingsWidth(next); } }} />}</div>;
  if (error && category === "courses") return <Alert color="red" m="md">{error}</Alert>;
  return (
    <AppShell transitionDuration={0} header={{ height: showSheetLocation ? 104 : 48, collapsed: !mobileNav }} navbar={{ width: navbarWidth, breakpoint: category === "cheatsheets" ? "64em" : "sm", collapsed: { mobile: !navOpened, desktop: !libraryPresent && !courseOutlinePresent } }} padding="md">
      <style>{`[data-testid="sidebar-controls"][data-floating="true"]{position:fixed;left:calc(12px + env(safe-area-inset-left, 0px));bottom:calc(12px + env(safe-area-inset-bottom, 0px));z-index:var(--ir-z-floating)}[data-floating="true"] [data-testid="sidebar-controls-trigger"]{opacity:.45;transition:opacity var(--ir-motion-standard) var(--ir-motion-ease)}[data-floating="true"]:is(:hover,:focus-within,[data-opened="true"]) [data-testid="sidebar-controls-trigger"]{opacity:1}[data-floating="true"] [data-testid="sidebar-controls-trigger"]:focus-visible{outline:2px solid var(--ir-color-focus);outline-offset:2px}@media (prefers-reduced-motion:reduce){[data-floating="true"] [data-testid="sidebar-controls-trigger"]{transition:none}}`}</style>
      <style>{`.library-resizer{background:transparent}.library-resizer::after{content:"";position:absolute;inset-block:0;left:3.5px;width:1px;background:var(--mantine-color-default-border)}.library-resizer:hover::after,.library-resizer:focus-visible::after{background:var(--mantine-primary-color-filled)}.library-resizer:focus-visible{outline:none}.drill-header-grid{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:var(--mantine-spacing-sm)}.drill-header-main,.drill-header-actions,.drill-status{min-width:0}.drill-header-actions{display:flex;align-items:center;justify-content:flex-end;gap:var(--mantine-spacing-xs);flex-wrap:wrap}.drill-timer{flex-wrap:nowrap;max-width:100%}.drill-status-control{display:grid;grid-template-columns:repeat(4,max-content);gap:2px;padding:4px;border-radius:var(--mantine-radius-default);background:var(--mantine-color-default-hover)}.drill-status-option{position:relative;min-width:0}.drill-status-option input{position:absolute;inset:0;z-index:1;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}.drill-status-option span{display:flex;align-items:center;justify-content:center;min-height:44px;padding-inline:var(--mantine-spacing-sm);border-radius:calc(var(--mantine-radius-default) - 2px);font-size:var(--mantine-font-size-xs);line-height:1.2;white-space:nowrap;cursor:pointer}.drill-status-option[data-status="not-started"] span{background:var(--mantine-color-default-hover)}.drill-status-option[data-status="in-progress"] span{background:var(--mantine-color-yellow-light)}.drill-status-option[data-status="blocked"] span{background:var(--mantine-color-red-light)}.drill-status-option[data-status="done"] span{background:var(--mantine-color-green-light)}.drill-status-option input:checked+span{font-weight:700;box-shadow:inset 0 0 0 2px var(--mantine-primary-color-filled)}.drill-status-option input:focus-visible+span{outline:2px solid var(--mantine-primary-color-filled);outline-offset:2px}.instruction-pane :where(pre,code){max-inline-size:120ch;inline-size:100%;min-inline-size:0;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word}@media(max-width:69.99375em){.drill-header-grid{grid-template-columns:minmax(0,1fr)}.drill-header-actions{width:100%;justify-content:flex-start;container:drill-actions/inline-size}.drill-status{width:100%;max-width:100%}}@container drill-actions (max-width:20rem){.drill-status-control{grid-template-columns:repeat(2,minmax(0,1fr))}.drill-status-option span{padding-inline:var(--mantine-spacing-xs);white-space:normal;text-align:center}}@container drill-actions (max-width:12rem){.drill-timer{display:grid!important;grid-template-columns:auto minmax(0,1fr);width:100%;align-items:center;justify-items:start}.drill-timer>:first-child{justify-self:end}}`}</style>
      <style>{`.drill-sticky-header{container:drill-header/inline-size}@container drill-header (min-width:48.001rem) and (max-width:56rem){.drill-header-grid{grid-template-columns:minmax(15rem,1fr) minmax(0,auto)}}@container drill-header (max-width:48rem){.drill-header-grid{grid-template-columns:minmax(0,1fr)}.drill-header-actions{width:100%;justify-content:flex-start;container:drill-actions/inline-size}.drill-status{width:auto;max-width:100%}.drill-status-control{grid-template-columns:repeat(2,max-content)}}@container drill-actions (max-width:28rem){.drill-status{width:100%}.drill-status-control{grid-template-columns:repeat(2,minmax(0,1fr))}.drill-status-option span{padding-inline:var(--mantine-spacing-xs);white-space:normal;text-align:center}}`}</style>
      <style>{`.drill-header-actions>.mantine-Badge-root[data-variant=outline],.drill-timer>.mantine-Badge-root[data-variant=light]{color:var(--mantine-color-text)}`}</style>
      <style>{`.drill-header-main .ir-workspace-title>h1{flex:1;font-size:var(--mantine-font-size-xl);line-height:1.4}.drill-timer{flex-wrap:wrap}.drill-header-actions>.ir-status-badge{font-size:var(--mantine-font-size-xs)}.drill-timer .ir-button:not(.ir-icon-button){font-size:var(--mantine-font-size-sm);padding-inline:var(--mantine-spacing-sm)}.drill-status-option span,.drill-header-actions .mantine-Button-label,.drill-header-actions .mantine-Badge-label{white-space:nowrap}@container drill-header (min-width:48.001rem){.drill-header-grid{grid-template-columns:minmax(15rem,1fr) minmax(0,auto)}.drill-header-main .ir-workspace-title>h1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}@media(max-width:24rem){.drill-header-main .ir-workspace-title>h1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}`}</style>
      <style>{`@media(max-width:24rem){.drill-timer{width:100%;flex-wrap:wrap}.drill-timer>*{flex-shrink:0;max-width:100%}.drill-status{width:100%;max-width:100%}.drill-status-control{width:100%;box-sizing:border-box;grid-template-columns:repeat(2,minmax(0,1fr))}.drill-status-option span{padding-inline:var(--mantine-spacing-xs);white-space:normal;text-align:center}}`}</style>
      <style>{`@media(max-width:24rem){.drill-status-option span{white-space:nowrap}}`}</style>
      <style>{`aside[aria-label="Course outline"] .mantine-NavLink-root[data-active="true"]{color:var(--ir-color-selected-fg);background:var(--ir-color-selected-bg);box-shadow:inset 3px 0 0 var(--ir-color-selected-fg)}aside[aria-label="Course outline"] .mantine-NavLink-root[data-active="true"] .mantine-NavLink-label{color:var(--ir-color-selected-fg);font-weight:600}aside[aria-label="Course outline"] .mantine-NavLink-root[data-active="true"]:focus-visible{outline:2px solid var(--ir-color-selected-fg);outline-offset:-2px}`}</style>
      <style>{`aside[aria-label="Course outline"] .mantine-NavLink-root[data-active="true"] :is(.mantine-NavLink-label .mantine-Text-root,.mantine-NavLink-description){color:var(--ir-color-selected-fg);opacity:1}`}</style>
      <style>{`.library-resizer::after{background:var(--ir-color-control-border)}.library-resizer:hover::after,.library-resizer:focus-visible::after{background:var(--ir-color-focus)}.library-resizer:focus-visible{outline:2px solid var(--ir-color-focus);outline-offset:-2px}.drill-status-control{background:var(--ir-color-raised)}.drill-status-option[data-status="not-started"] span{background:var(--ir-color-raised);color:var(--ir-color-text)}.drill-status-option[data-status="in-progress"] span{background:var(--ir-color-warning-bg);color:var(--ir-color-warning)}.drill-status-option[data-status="blocked"] span{background:var(--ir-color-danger-bg);color:var(--ir-color-danger)}.drill-status-option[data-status="done"] span{background:var(--ir-color-success-bg);color:var(--ir-color-success)}.drill-status-option input:checked+span{box-shadow:inset 0 0 0 2px var(--ir-color-accent)}.drill-status-option input:focus-visible+span{outline-color:var(--ir-color-focus)}`}</style>
      <AppShell.Header ref={sheetHeaderRef} p={0} hiddenFrom={category === "cheatsheets" ? undefined : "sm"} style={{ display: category === "cheatsheets" && !mobileNav ? "none" : undefined }}>
        <Group gap="sm" wrap="nowrap" h={48} px="xs">
          <IconButton variant="subtle" label="Toggle course navigation" tooltipDisabled={navOpened} icon={navOpened ? <IconX size={20} aria-hidden="true" /> : <IconMenu2 size={20} aria-hidden="true" />} onClick={toggleNav} aria-expanded={navOpened} />
          <Text size="sm" fw={600} truncate style={{ minWidth: 0, flex: 1 }}>{category === "cheatsheets" ? cheatsheets.find(x=>x.id===cheatsheetId)?.title ?? "Cheatsheets" : course?.title ?? "Interview runner"}</Text>
        </Group>
        {showSheetLocation && <div ref={sheetLocationRef} className="cheatsheet-location" data-has-card={sheetLocation[1] ? 'true' : undefined} role="group" aria-label={`Current location: ${sheetLocation.join(" › ")}`}><span className="cheatsheet-location-group"><span className="cheatsheet-location-group-full">{sheetLocation[0]}</span><span className="cheatsheet-location-group-emoji" aria-hidden="true">{sheetLocation[0]?.match(/^\p{Extended_Pictographic}\uFE0F?/u)?.[0] ?? sheetLocation[0]}</span></span>{sheetLocation[1] && <><span aria-hidden="true">›</span><span className="cheatsheet-location-card">{sheetLocation[1]}</span></>}</div>}
      </AppShell.Header>
      <AppShell.Navbar p={0} inert={course?.type === 'map-recall' && mobileNav && !navOpened ? true : undefined} style={{ overflow: "hidden" }}>
        <div style={{ height: "100%", display: "flex" }}>
            {libraryPresent && libraryPanel}
          {courseOutlinePresent && (category === 'cheatsheets' ? sheetPanel : outlinePanel)}
        </div>
      </AppShell.Navbar>
      {resizingSheetHeadings && <div data-testid="sheet-resize-overlay" aria-hidden="true" style={{ position: 'fixed', inset: 0, zIndex: 'var(--ir-z-drag)', cursor: 'col-resize' }} />}
      {overlayNavigation && <Drawer.Root opened={workspaceNavOpened} onClose={closeWorkspaceNav} size="min(92vw, 42rem)"><Drawer.Overlay /><Drawer.Content><Drawer.Header role="presentation"><Drawer.Title>Course navigation</Drawer.Title><IconButton variant="subtle" label="Close course navigation" icon={<IconX size={20} aria-hidden="true" />} tooltipWithinPortal={false} onClick={closeWorkspaceNav} /></Drawer.Header><Drawer.Body><div style={{ height: "calc(100dvh - 5rem)", display: "flex", minWidth: 0, overflow: "hidden" }}>{baseLibraryPresent && libraryPanel}{baseCourseOutlinePresent && outlinePanel}</div></Drawer.Body></Drawer.Content></Drawer.Root>}
      <AppShell.Main className={mapSurface ? 'map-lesson-main' : undefined} style={{ height: mobileNav && showSheetLocation ? "calc(100dvh - var(--app-shell-header-offset))" : codingDrill || readingOutline || selected?.contentType === 'map' || isWhiteboardDrill(selected) ? "100dvh" : "calc(100vh - 32px)", marginTop: mobileNav && showSheetLocation ? "var(--app-shell-header-offset)" : undefined, minHeight: mobileNav && showSheetLocation ? 0 : undefined, overscrollBehaviorY: mobileNav && showSheetLocation ? "contain" : undefined, paddingTop: mobileNav && showSheetLocation ? "var(--mantine-spacing-md)" : undefined, display: "flex", flexDirection: "column", overflowX: "hidden", overflowY: codingDrill || readingOutline || isWhiteboardDrill(selected) ? "hidden" : "auto", paddingBottom: mapSurface ? 'calc(var(--mantine-spacing-md) + env(safe-area-inset-bottom))' : codingDrill || isWhiteboardDrill(selected) ? "var(--mantine-spacing-md)" : "calc(var(--mantine-spacing-md) + 3.5rem)" }}>
        {category === "cheatsheets" ? (!cheatsheetId ? <Text c="dimmed">Choose a cheatsheet.</Text> : sheetError ? <Alert color="red" title="Cheatsheet unavailable" role="alert">{sheetError}</Alert> : sheetContentError ? <Alert color="red" title="Cheatsheet content unavailable" role="alert">{sheetContentError}</Alert> : sheetContent === null ? <Group gap="sm"><Loader aria-hidden="true" /><Text>Loading cheatsheet…</Text></Group> : <div className="cheatsheet-pane">{sheet && !sheetView.headings.some((heading) => heading.level === 1) && <h1 className="ir-visually-hidden">{sheet.title}</h1>}<Group className="cheatsheet-print-action" justify="flex-end" mb="sm"><Button variant="secondary" onClick={() => window.print()}>Print cheatsheet</Button></Group>{CHEATSHEET_COVERAGE_ENABLED && <CheatsheetCoverage key={cheatsheetId} courseId={cheatsheetId} root={sheetContentRef} headings={sheetView.headings} hidden={mobileNav && navOpened} onJump={(index) => { const heading = sheetView.headings[index]; if (heading) selectSheetHeading(heading); }} />}<article ref={sheetContentRef} className="cheatsheet-content" aria-label={sheet?.title} dangerouslySetInnerHTML={sheetMarkup} />{sheetMapHosts.map(({ host, id, title, path }) => createPortal(<CheatsheetMindmap courseId={cheatsheetId} title={title} path={path} />, host, id))}</div>) : <>
        {/* On mobile the burger owns the drawer; this desktop control stays reachable in either category. */}
        {saveNotice && <Alert color="orange" mb="sm" withCloseButton onClose={() => setSaveNotice(null)}>{saveNotice}</Alert>}
          {selected ? course && (selected.contentType === 'map' || selected.contentType === 'whiteboard' || (selected.contentType === 'recall' && (course.type === 'map-recall' || selected.whiteboard))) ? <MapRecall key={`${course.id}/${selected.id}`} courseId={course.id} lessonId={selected.id} kind={selected.contentType} title={selected.title} whiteboard={isWhiteboardDrill(selected)} questionsCollapsed={uiState.panels['whiteboard-questions']} onToggleQuestions={() => togglePanel('whiteboard-questions')} editorPercent={uiState.editorPercent} onEditorPercentChange={(editorPercent) => updateUi((state) => ({ ...state, editorPercent: clampEditorPercent(editorPercent) }))} timer={whiteboardTimer} completion={whiteboardCompletion} floatingControls={mapFullscreen ? sidebarControls : undefined} floatingControlsOpened={controlsOpened} onFullscreenChange={setMapFullscreen} hasStoredChecks={recallProgress.values[selected.id]?.hasStoredChecks} onProgress={(id, value) => { recallProgress.update(id, value); recallProgress.retry(); void fetch(libraryUrl()).then((response) => { if (!response.ok) throw new Error('Library progress refresh failed'); return response.json() as Promise<LibrarySnapshot>; }).then(setLibrary).catch(() => setSaveNotice('Library recall progress could not be refreshed.')); }} onNext={(() => { const drills = course.chapters.flatMap((chapter) => chapter.drills); const next = drills[drills.findIndex((drill) => drill.id === selected.id) + 1]; return next ? () => selectDrill(course, next.id) : undefined; })()} /> : readingOutline ? (
            <div data-testid="drill-sticky-header" style={{ flex: 1, overflowY: "auto", padding: "var(--mantine-spacing-sm)", paddingBottom: "calc(var(--mantine-spacing-sm) + 3.5rem)" }}>
               <div data-testid="drill-header">
               {outlineState.status === "error" || outlineState.status === "absent" ? <Alert color="red" title="Outline unavailable" role="alert">{outlineState.status === "error" ? outlineState.message : "The declared reading outline is missing."}</Alert> : <OutlineReader
                  outline={outlineState.status === "ready" ? outlineState.outline : null}
                  loading={outlineState.status === "loading"}
                  completionEnabled={progressHydratedCourseId === course?.id}
                  chapterProgress={{ done: selectedChapterDone, total: selectedChapter?.drills.length ?? 0 }}
                  onProgress={setOutlineProgress}
                  onComplete={onReaderComplete}
                />}
             </div>
          </div>
        ) : <>
           <div data-testid="instruction-region" style={{ ...(codingDrill ? { flex: "0 0 auto", minHeight: 0, overflow: "visible" } : paneSizing(uiState.panels.build)), position: "relative", display: "flex", flexDirection: "column" }}>
              <div
               className="drill-sticky-header"
               data-testid="drill-sticky-header"
              style={{
                position: "sticky",
                top: 0,
                zIndex: 'var(--ir-z-sticky)',
                paddingBlock: "var(--mantine-spacing-xs)",
                marginBottom: "var(--mantine-spacing-xs)",
                background: "light-dark(var(--ir-color-canvas), var(--ir-color-surface))",
                borderBottom: "1px solid var(--ir-color-border)",
              }}
            >
               <WorkspaceHeader className="drill-header-grid" data-testid="drill-header" classNames={{ identity: 'drill-header-main', actions: 'drill-header-actions' }} title={selected.title} leading={overlayNavigation && <UIIconButton label="Open course navigation" icon={<IconLibrary size={18} aria-hidden="true" />} onClick={openWorkspaceNav} />} timer={codingDrill && <><Tooltip multiline label={<Stack gap={2}><Text size="xs">Active time starts with the timer; pauses are excluded.</Text>{priorAttempts.length ? priorAttempts.map((attempt) => <Text size="xs" key={attempt.attemptNumber}>Attempt {attempt.attemptNumber}: {formatTime(attempt.elapsedMs)}</Text>) : <Text size="xs">No prior attempts</Text>}</Stack>}><StatusBadge role="img" h={44} style={{ fontVariantNumeric: "tabular-nums", paddingInline: "var(--mantine-spacing-sm)" }} aria-label={currentAttempt ? `Attempt ${currentAttempt.attemptNumber}, ${currentAttempt.completedAt ? "actual" : "elapsed"} ${formatTime(currentAttemptElapsedMs)}, estimate ${selected.estMinutes} minutes` : `Attempt not started, estimate ${selected.estMinutes} minutes`}>{currentAttempt ? `Attempt ${currentAttempt.attemptNumber} · ${currentAttempt.completedAt ? "Actual" : "Elapsed"} ${formatTime(currentAttemptElapsedMs)} · Est ${selected.estMinutes}m` : `Not started · Est ${selected.estMinutes}m`}</StatusBadge></Tooltip><TimerDisplay className="drill-timer" remaining={remainingMs} state={remainingMs === 0 ? 'expired' : timerRunning ? 'running' : 'paused'} label="Time remaining" announcement={timerAnnouncement} actions={<><UIButton ref={attemptStartTrigger} variant="secondary" disabled={attemptBusy} leftSection={timerRunning ? <IconPlayerPause size={16} /> : <IconPlayerPlay size={16} />} onClick={timerRunning ? pauseTimer : requestStartTimer}>{timerRunning ? "Pause" : selected.contentType === "ai-coding" ? currentAttempt && !currentAttempt.completedAt ? "Resume attempt" : "Start new attempt" : "Start"}</UIButton><UIIconButton label="Restart timer" icon={<IconRestore size={17} aria-hidden="true" />} onClick={resetTimer} /></>} /></>} actions={<div className="drill-status"><DrillStatusControl value={progress[selected.id]?.status ?? "not-started"} onChange={(status) => void updateStatus(status, true)} /></div>} />
            </div>
              {!codingDrill && <Panel className="instruction-pane" data-testid="instruction-pane" label="Instructions" padding="md" style={{ minWidth: 0, overflowWrap: "anywhere", wordBreak: "break-word" }}><PanelHeader title="Instructions" toggle={{ expanded: !uiState.panels.build, onToggle: () => togglePanel("build"), controlsId: 'instructions-content' }} /><Collapse id="instructions-content" in={!uiState.panels.build}><Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <Anchor href={href} target="_blank" rel="noreferrer noopener">{children}</Anchor>, pre: ({ children }) => <CopyableMarkdownPre>{children}</CopyableMarkdownPre> }}>{selected.instructions}</Markdown></Collapse></Panel>}
           </div>
                  {codingDrill && course ? selected.contentType === "ai-coding" && attemptsState.status === "loading" ? <Group justify="center" h="100%" gap="sm"><Loader aria-hidden="true" /><Text>Loading attempt…</Text></Group> : selected.contentType === "ai-coding" && attemptsState.status === "failed" ? <Alert color="red" title="Attempt unavailable"><Stack gap="sm"><Text>{attemptsState.message}</Text><Button mih={44} onClick={() => void fetchAttempts(course.id)}>Retry</Button></Stack></Alert> : <SandboxWorkspace key={selectedKey} courseId={course.id} drillId={selected.id} sourcePath={selected.sourcePath} instructions={selected.instructions} estMinutes={selected.estMinutes} colorScheme={resolvedColorScheme === "dark" ? "dark" : "light"} watcherResult={reportEntry} runnerCollapsed={uiState.panels["test-results"]} onToggleRunner={() => togglePanel("test-results")} editorPercent={uiState.editorPercent} onEditorPercentChange={(editorPercent) => updateUi((state) => ({ ...state, editorPercent: clampEditorPercent(editorPercent) }))} onSubmitPassed={async () => { await updateStatus("done", true); commitTimer(pauseCountdown(timer, Date.now())); }} hintResetVersion={hintResetVersion} aiCoding={selected.contentType === "ai-coding"} attempt={currentAttempt} attempts={selectedAttempts} starting={attemptBusy} onStartAttempt={requestStartTimer} /> : <>
             {selected.contentType === 'reading' && !selected.outlinePath && selected.sourcePath.endsWith('.md') && course ? <ReadingMarkdown key={selectedKey} courseId={course.id} drillId={selected.id} /> : <Panel label="Preview" padding="md" style={{ ...paneSizing(previewCollapsed), boxSizing: "border-box" }}><PanelHeader title="Preview" toggle={{ expanded: !previewCollapsed, onToggle: togglePreview, controlsId: 'preview-content' }} /><Collapse id="preview-content" in={!previewCollapsed}><div style={{ width: "100%", maxWidth: "min(100%, var(--ir-reading-measure))" }}><Text c="dimmed">No visual output for this drill.</Text></div></Collapse></Panel>}
           </>}
        </> : <Text c="dimmed">Select a drill.</Text>}
        </>}
       </AppShell.Main>
       {!mapFullscreen && sidebarControls}
         <Modal.Root opened={newAttemptOpen} onClose={closeNewAttempt} centered><Modal.Overlay /><Modal.Content><Modal.Header role="presentation"><Modal.Title>Start a new attempt?</Modal.Title><IconButton variant="subtle" label="Close new attempt dialog" icon={<IconX size={20} aria-hidden="true" />} tooltipWithinPortal={false} onClick={closeNewAttempt} /></Modal.Header><Modal.Body><Text>This creates a fresh workspace. Submitted attempts remain available for read-only review.</Text><Group justify="flex-end" mt="md"><Button data-autofocus variant="secondary" onClick={closeNewAttempt}>Keep current attempt</Button><Button loading={attemptBusy} onClick={() => { setNewAttemptOpen(false); void startTimer(); }}>Start new attempt</Button></Group></Modal.Body></Modal.Content></Modal.Root>
        <KeyboardShortcutsModal opened={shortcutsOpened} onClose={closeKeyboardShortcuts} />
       <CommandPalette menu={[...menuCommands, { id: 'design-system', label: 'Open design system gallery', icon: <IconAdjustments aria-hidden="true" size={16} />, onClick: () => { window.open('/design-system', '_blank', 'noopener,noreferrer'); } }]} courses={sortUpNext(library.items.filter((item) => item.kind === "course" && (!library.workspaceMode || item.repo === uiState.courseRepo)), library.categories)} cheatsheets={library.items.filter((item) => item.kind === "cheatsheet" && (!library.workspaceMode || item.repo === uiState.courseRepo))} categories={library.categories} repositories={library.courseRepos ?? []} onOpenCourse={selectLibraryItem} onOpenCheatsheet={selectLibraryItem} onSwitchRepo={switchCourseRepo} />
    </AppShell>
  );
}

function CourseTags({ tags, onSave, onEditingChange }: { tags: string[]; onSave: (tags: string[]) => Promise<void>; onEditingChange: (editing: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(tags);
  const [entry, setEntry] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const tagInput = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!editing) setDraft(tags); }, [tags, editing]);
  useEffect(() => { if (editing) tagInput.current?.focus(); }, [editing]);

  const commitEntry = () => {
    const tag = entry.trim();
    if (!tag) return;
    if (tag.length > 40 || /[\u0000-\u001f\u007f]/.test(tag)) { setError("Tags must be 1–40 characters and contain no control characters."); return; }
    if (draft.some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase())) { setError(`“${tag}” is already in the tags.`); return; }
    if (draft.length >= 20) { setError("You can add up to 20 tags."); return; }
    setDraft((current) => [...current, tag]);
    setEntry(""); setError(null); setNotice(null);
  };
  const addEntry = (raw: string) => {
    const trimmed = raw.trim();
    const quoted = trimmed.match(/^(["'])(.*)\1$/s);
    const values = (quoted ? [quoted[2]] : raw.split(",")).map((value) => value.trim()).filter(Boolean);
    if (!values.length) { if (raw.length) setError("Tags cannot be empty."); return; }
    let next = draft;
    for (const tag of values) {
      if (tag.length > 40 || /[\u0000-\u001f\u007f]/.test(tag)) { setError("Tags must be 1–40 characters and contain no control characters."); return; }
      if (next.some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase())) { setError(`“${tag}” is already in the tags.`); return; }
      if (next.length >= 20) { setError("You can add up to 20 tags."); return; }
      next = [...next, tag];
    }
    setDraft(next); setEntry(""); setError(null); setNotice(null);
  };
  const startEditing = () => { setDraft(tags); setEditing(true); onEditingChange(true); setNotice(null); };
  const restoreFocus = () => requestAnimationFrame(() => trigger.current?.focus());
  const cancel = () => { setDraft(tags); setEntry(""); setEditing(false); onEditingChange(false); setError(null); setNotice(null); restoreFocus(); };
  const save = async () => {
    setSaving(true); setError(null);
    try { await onSave(draft); setEditing(false); onEditingChange(false); setNotice("Tags saved."); restoreFocus(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Tags could not be saved."); }
    finally { setSaving(false); }
  };

  return <div className="course-tags">
    <style>{`.course-tags{margin-top:var(--mantine-spacing-sm);margin-bottom:var(--mantine-spacing-md)}.course-tags-trigger{min-height:44px;cursor:pointer;border-radius:var(--ir-radius-default)}.course-tags-trigger:hover{background:var(--ir-color-hover)}.course-tags-trigger:focus-visible{outline:2px solid var(--ir-color-focus);outline-offset:2px}`}</style>
    {!editing && <Group ref={trigger} className="course-tags-trigger" gap="xs" align="center" wrap="wrap" role="button" tabIndex={0} aria-label={tags.length ? `Edit tags: ${tags.join(', ')}` : 'Add tags'} onClick={startEditing} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); startEditing(); } }}>{tags.length ? tags.map((tag) => <StatusBadge key={tag} tone="info" size="sm">{tag}</StatusBadge>) : <Text size="sm" style={{ color: 'var(--ir-color-text-secondary)' }}>Add tags</Text>}</Group>}
    {editing && <Stack gap="xs" mt="sm">
      <Group gap="xs" role="list" aria-label="Tags being edited" align="center" wrap="wrap">
        {draft.map((tag) => <Group key={tag} gap={0} wrap="nowrap" role="listitem" style={{ border: "1px solid var(--ir-color-border)", borderRadius: "var(--ir-radius-pill)", minHeight: 44 }}><StatusBadge>{tag}</StatusBadge><IconButton variant="subtle" label={`Remove ${tag}`} icon={<IconX size={14} aria-hidden="true" />} onClick={() => { setDraft((current) => current.filter((value) => value !== tag)); setError(null); tagInput.current?.focus(); }} /></Group>)}
        <TextInput ref={tagInput} style={{ flex: "1 1 11rem", minWidth: "min(100%, 11rem)" }} label="Add a tag" aria-label="Add a tag" description="Space commits one word; paste a phrase or use quotes for multiword tags. Enter or comma also commits." value={entry} onChange={(event) => { setEntry(event.currentTarget.value); setError(null); }} onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addEntry(entry); return; }
          const text = entry.trimStart();
          const quotedOpen = (text.startsWith("\"") && !text.trimEnd().endsWith("\"")) || (text.startsWith("'") && !text.trimEnd().endsWith("'"));
          if (event.key === " " && !quotedOpen) { event.preventDefault(); commitEntry(); }
        }} />
      </Group>
      <Group gap="xs"><Button size="sm" variant="secondary" onClick={commitEntry} disabled={!entry.trim()}>Add tag</Button><Button size="sm" onClick={() => void save()} loading={saving} disabled={saving || Boolean(entry.trim())}>Save</Button><Button size="sm" variant="subtle" onClick={cancel} disabled={saving}>Cancel</Button></Group>
    </Stack>}
    {error && <Text size="sm" style={{ color: 'var(--ir-color-danger)' }} role="alert" mt="xs">{error}</Text>}
    {notice && <Text size="sm" style={{ color: 'var(--ir-color-text)' }} role="status" mt="xs">{notice}</Text>}
  </div>;
}
