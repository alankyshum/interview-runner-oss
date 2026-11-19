import { HotkeysProvider, defineAppHotkeys, formatForDisplay, matchesKeyboardEvent, type AppHotkey, type CustomHotkeys, type Hotkey } from "@tanstack/react-hotkeys";
import { type ReactNode, useEffect, useRef } from "react";

export const HOTKEYS_STORAGE_KEY = "interview-runner-hotkeys";

const captured = { capture: true, ignoreInputs: false } as const;
const panelCaptured = { ...captured, preventDefault: false, stopPropagation: false } as const;

export const appHotkeys = defineAppHotkeys({
  "runner.save": { hotkey: "Mod+[KeyS]", meta: { name: "Save", group: "COURSE RUNNER" }, options: captured },
  "runner.runTests": { hotkey: "Mod+[Quote]", meta: { name: "Run tests", group: "COURSE RUNNER" }, options: captured },
  "runner.submit": { hotkey: "Mod+[Enter]", meta: { name: "Submit solution", group: "COURSE RUNNER" }, options: captured },
  "files.previous": { hotkey: "Mod+Alt+[BracketLeft]", meta: { name: "Previous file", group: "FILE NAVIGATION" }, options: captured },
  "files.previousArrow": { hotkey: "Mod+Alt+[ArrowLeft]", meta: { name: "Previous file", group: "FILE NAVIGATION" }, options: captured },
  "files.next": { hotkey: "Mod+Alt+[BracketRight]", meta: { name: "Next file", group: "FILE NAVIGATION" }, options: captured },
  "files.nextArrow": { hotkey: "Mod+Alt+[ArrowRight]", meta: { name: "Next file", group: "FILE NAVIGATION" }, options: captured },
  "panels.library": { hotkey: "Mod+[Backslash]", meta: { name: "Toggle library", group: "PANELS" }, options: panelCaptured },
  "panels.courseChapters": { hotkey: "Mod+Alt+[Backslash]", meta: { name: "Toggle course chapters", group: "PANELS" }, options: panelCaptured },
  "panels.shortcuts": { hotkey: "Mod+[Period]", meta: { name: "Keyboard shortcuts", group: "PANELS" }, options: panelCaptured },
  "palette.open": { hotkey: "Mod+[KeyK]", meta: { name: "Command palette", group: "COURSE RUNNER" }, options: { capture: true, ignoreInputs: true, preventDefault: false, stopPropagation: false } },
  "editor.deleteLine": { hotkey: "Control+Shift+[KeyK]", meta: { name: "Delete line", group: "EDITOR" }, options: captured },
  "editor.duplicateLine": { hotkey: "Mod+Shift+[KeyD]", meta: { name: "Duplicate line", group: "EDITOR" }, options: captured },
  "editor.renameSymbolF2": { hotkey: "F2", meta: { name: "Rename symbol", group: "EDITOR" }, options: captured },
  "editor.renameSymbolMod": { hotkey: "Mod+Shift+[KeyR]", meta: { name: "Rename symbol", group: "EDITOR" }, options: captured },
});

const sandboxForwardedGroups = new Set(["COURSE RUNNER", "FILE NAVIGATION", "PANELS"]);
export const SANDBOX_HOTKEY_EVENT = "interview-runner:sandbox-hotkey";
export type AppHotkeyId = keyof typeof appHotkeys;

export function sandboxForwardedHotkeys(hotkeys: typeof appHotkeys): AppHotkey[] {
  return Object.values(hotkeys).filter((hotkey) => hotkey.id !== "runner.save" && hotkey.id !== "palette.open" && sandboxForwardedGroups.has(hotkey.meta?.group ?? "") && hotkey.hotkey !== null);
}

export function matchesSandboxForwardedHotkey(event: KeyboardEvent, hotkey: AppHotkey): boolean {
  if (!hotkey.hotkey) return false;
  const steps = Array.isArray(hotkey.hotkey) ? hotkey.hotkey : [hotkey.hotkey];
  return steps.some((step) => matchesKeyboardEvent(event, step));
}

export function useSandboxForwardedHotkey(id: AppHotkeyId, callback: () => void, enabled = true) {
  const callbackRef = useRef(callback); callbackRef.current = callback;
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: Event) => { if ((event as CustomEvent<{ id?: string }>).detail?.id === id) callbackRef.current(); };
    window.addEventListener(SANDBOX_HOTKEY_EVENT, handler);
    return () => window.removeEventListener(SANDBOX_HOTKEY_EVENT, handler);
  }, [id, enabled]);
}

declare module "@tanstack/react-hotkeys" {
  interface Register {
    appHotkeys: typeof appHotkeys;
  }
}

function savedCustomHotkeys(): CustomHotkeys<typeof appHotkeys> {
  try {
    const value = JSON.parse(localStorage.getItem(HOTKEYS_STORAGE_KEY) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

export function CourseRunnerHotkeysProvider({ children }: { children: ReactNode }) {
  return <HotkeysProvider appHotkeys={appHotkeys} customHotkeys={savedCustomHotkeys()} onCustomHotkeysChange={(custom) => localStorage.setItem(HOTKEYS_STORAGE_KEY, JSON.stringify(custom))}>{children}</HotkeysProvider>;
}

const macOrder = (parts: string[]) => parts.includes("⌘") ? [...parts].sort((a, b) => {
  const rank = (part: string) => part === "⌘" ? 0 : part === "⌥" || part === "⌃" ? 1 : part === "⇧" ? 2 : 3;
  return rank(a) - rank(b);
}) : parts;

export function shortcutParts(hotkey: Hotkey | null): string[][] {
  if (!hotkey) return [];
  const formatted = formatForDisplay(hotkey, { parts: true });
  const steps = Array.isArray(formatted[0]) ? formatted as string[][] : [formatted as string[]];
  return steps.map(macOrder);
}

export function shortcutInline(hotkey: Hotkey | null): string {
  return shortcutParts(hotkey).map((step) => step.join("")).join(", ");
}

const accessiblePart: Record<string, string> = { "⌘": "Command", "⌥": "Option", "⌃": "Control", "⇧": "Shift", "↵": "Enter", "←": "Left Arrow", "→": "Right Arrow", "\\": "Backslash", ".": "Period", "'": "Quote" };
export const shortcutAccessibleLabel = (parts: string[][]) => parts.map((step) => step.map((part) => accessiblePart[part] ?? part).join(" plus ")).join(", then ");
