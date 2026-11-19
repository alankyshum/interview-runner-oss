// Persisted storage keys, not display labels — renaming a panel in the UI must not
// silently discard a user's saved collapse state. Adding a panel = one id here plus
// one default below.
export type PanelId = "build" | "preview" | "test-results" | "whiteboard-questions";
export const LIBRARY_WIDTH_MIN = 240;
export const LIBRARY_WIDTH_DEFAULT = 304;
export const LIBRARY_WIDTH_MAX = 416;
export const clampLibraryWidth = (value: number) => Math.max(LIBRARY_WIDTH_MIN, Math.min(LIBRARY_WIDTH_MAX, Math.round(value)));
export const clampEditorPercent = (value: number) => Math.max(45, Math.min(80, Math.round(value)));

export type UiState = {
  sidebarCollapsed: boolean;
  sheetLibraryCollapsed?: boolean;
  outlineCollapsed: boolean;
  libraryWidth: number;
  editorPercent: number;
  courseRepo?: string;
  libraryExpanded: Record<string, boolean>;
  panels: Record<PanelId, boolean>;
  chapters: Record<string, Record<string, boolean>>;
};

const STORAGE_KEY = "interview-runner-ui-state";
const defaults: UiState = {
  sidebarCollapsed: false,
  outlineCollapsed: false,
  libraryWidth: LIBRARY_WIDTH_DEFAULT,
  editorPercent: 65,
  courseRepo: undefined,
  libraryExpanded: {},
  panels: { build: false, preview: false, "test-results": false, "whiteboard-questions": false },
  chapters: {},
};

function cloneDefaults(): UiState {
  return { sidebarCollapsed: defaults.sidebarCollapsed, outlineCollapsed: defaults.outlineCollapsed, libraryWidth: defaults.libraryWidth, editorPercent: defaults.editorPercent, courseRepo: defaults.courseRepo, libraryExpanded: {}, panels: { ...defaults.panels }, chapters: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readState(value: unknown): UiState {
  const result = cloneDefaults();
  if (!isRecord(value)) return result;
  if (typeof value.sidebarCollapsed === "boolean") result.sidebarCollapsed = value.sidebarCollapsed;
  if (typeof value.sheetLibraryCollapsed === "boolean") result.sheetLibraryCollapsed = value.sheetLibraryCollapsed;
  if (typeof value.outlineCollapsed === "boolean") result.outlineCollapsed = value.outlineCollapsed;
  if (typeof value.libraryWidth === "number" && Number.isFinite(value.libraryWidth)) result.libraryWidth = clampLibraryWidth(value.libraryWidth);
  if (typeof value.editorPercent === "number" && Number.isFinite(value.editorPercent)) result.editorPercent = clampEditorPercent(value.editorPercent);
  if (typeof value.courseRepo === "string" && /^[^/]+\/[^/]+$/.test(value.courseRepo)) result.courseRepo = value.courseRepo;
  if (isRecord(value.libraryExpanded)) for (const [key, open] of Object.entries(value.libraryExpanded)) if (typeof open === "boolean") result.libraryExpanded[key] = open;
  if (isRecord(value.panels)) {
    for (const id of Object.keys(result.panels) as PanelId[]) {
      if (typeof value.panels[id] === "boolean") result.panels[id] = value.panels[id] as boolean;
    }
  }
  if (isRecord(value.chapters)) {
    for (const [courseId, chapters] of Object.entries(value.chapters)) {
      if (!isRecord(chapters)) continue;
      result.chapters[courseId] = {};
      for (const [chapterId, open] of Object.entries(chapters)) {
        if (typeof open === "boolean") result.chapters[courseId][chapterId] = open;
      }
    }
  }
  return result;
}

export function getUiState(): UiState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === null ? cloneDefaults() : readState(JSON.parse(raw));
  } catch {
    return cloneDefaults();
  }
}

export function setUiState(state: UiState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(readState(state)));
  } catch {
    // Storage can be unavailable (for example in private browsing).
  }
}

export function updateUiState(update: (state: UiState) => UiState): UiState {
  const next = update(getUiState());
  setUiState(next);
  return next;
}
