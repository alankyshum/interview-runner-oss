import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock('../../shared/legacyReading', async (original) => { const actual = await original<typeof import('../../shared/legacyReading')>(); return { isLegacyReading: (course: string, drill: string) => actual.isLegacyReading(course, drill) || course === 'demo' && drill === 'lesson' }; });
import CourseShell from "./CourseShell";
import { HOTKEYS_STORAGE_KEY } from "./appHotkeys";

const course = { id: "demo", title: "Demo", chapters: [{ id: "chapter", title: "Chapter", drills: [{ contentType: "reading", id: "lesson", title: "Lesson", kind: "logic", estMinutes: 5, sourcePath: "drills/demo/lesson.ts", outlinePath: "outlines/demo/lesson.json", instructions: "Read it." }] }] };
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  window.history.replaceState({}, "", "/?course=demo&chapter=chapter&drill=lesson");
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/api/courses") return json([{ id: "demo", title: "Demo", chapterCount: 1, drillCount: 1 }]);
    if (url === "/api/courses/demo") return json(course);
    if (url === "/api/cheatsheets" || url === "/api/books") return json([]);
    if (url === "/api/outlines/demo/lesson") return json({ courseId: 'demo', drillId: 'lesson', title: 'Lesson', nodes: [{ id: 'one', type: 'claim', text: 'Read.' }] });
    if (url === "/api/test-results") return json({ available: false });
    return json({});
  }));
});

const renderShell = () => render(<MantineProvider><CourseShell /></MantineProvider>);

describe("course runner shortcuts", () => {
  it.each(['excalidraw-wysiwyg', 'excalidraw-hyperlinkContainer'])('does not consume panel shortcuts while editing %s', async (className) => {
    renderShell(); await screen.findByRole('heading', { name: 'Lesson' });
    const container = document.createElement('div'); container.className = className; const input = document.createElement('input'); container.append(input); document.body.append(container); input.focus();
    const reached = vi.fn(); input.addEventListener('keydown', reached);
    for (const [key, code, altKey] of [['.', 'Period', false], ['\\', 'Backslash', false], ['\\', 'Backslash', true]] as const) {
      const event = new KeyboardEvent('keydown', { key, code, metaKey: true, altKey, bubbles: true, cancelable: true }); input.dispatchEvent(event); expect(event.defaultPrevented).toBe(false); fireEvent.keyUp(input, { key, code, metaKey: true, altKey });
    }
    expect(reached).toHaveBeenCalledTimes(3); expect(screen.queryByRole('dialog', { name: 'Keyboard Shortcuts' })).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Library' })).toBeInTheDocument(); expect(screen.getByRole('complementary', { name: 'Course outline' })).toBeInTheDocument(); container.remove();
  });
  it('returns focus to the canvas when the shortcut modal trigger disappeared', async () => {
    renderShell(); await screen.findByRole('heading', { name: 'Lesson' });
    const host = document.createElement('div'); host.className = 'recall-whiteboard-canvas'; const canvas = document.createElement('div'); canvas.className = 'excalidraw'; canvas.tabIndex = 0; host.append(canvas); document.body.append(host);
    const trigger = document.createElement('button'); document.body.append(trigger); trigger.focus();
    fireEvent.keyDown(trigger, { key: '.', code: 'Period', metaKey: true }); expect(await screen.findByRole('dialog', { name: 'Keyboard Shortcuts' })).toBeInTheDocument();
    trigger.remove(); fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' }); await waitFor(() => expect(canvas).toHaveFocus()); host.remove();
  });
  it('does not open sidebar controls on hover or steal focus', async () => {
    renderShell(); await screen.findByRole('heading', { name: 'Lesson' });
    const focus = document.createElement('button'); document.body.append(focus); focus.focus();
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'Sidebar and theme controls' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument(); expect(focus).toHaveFocus(); focus.remove();
  });
  it("keeps the floating controls focused when the library shortcut toggles visibility", async () => {
    renderShell(); await screen.findByRole("heading", { name: "Lesson" });
    const headerTrigger = screen.getByRole("button", { name: "Sidebar and theme controls" }); headerTrigger.focus();
    fireEvent.keyDown(headerTrigger, { key: "\\", code: "Backslash", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Library" })).not.toBeInTheDocument());
    const fallback = screen.getByRole("button", { name: "Sidebar and theme controls" });
    await waitFor(() => expect(fallback).toHaveFocus());
    fireEvent.keyUp(fallback, { key: "\\", code: "Backslash", metaKey: true });
    fireEvent.keyDown(fallback, { key: "\\", code: "Backslash", metaKey: true });
    await screen.findByRole("navigation", { name: "Library" });
    expect(screen.getByRole("button", { name: "Sidebar and theme controls" })).toBe(fallback);
    await waitFor(() => expect(fallback).toHaveFocus());
  });
  it("shows registry-derived menu suffixes and every configured shortcut in the modal", async () => {
    const user = userEvent.setup(); renderShell();
    await screen.findByRole("heading", { name: "Lesson" });
    await user.click(screen.getByRole("button", { name: "Sidebar and theme controls" }));

    const libraryItem = await screen.findByRole("menuitemcheckbox", { name: /Hide library/ });
    const chaptersItem = await screen.findByRole("menuitemcheckbox", { name: /Hide course chapters/ });
    expect(libraryItem).toHaveTextContent("⌘\\");
    expect(chaptersItem).toHaveTextContent("⌘⌥\\");
    const shortcutsItem = screen.getByRole("menuitem", { name: /Keyboard shortcuts/ });
    expect(shortcutsItem).toHaveTextContent("⌘.");
    await user.click(shortcutsItem);

    expect(await screen.findByRole("dialog", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
    for (const label of ["Save", "Run tests", "Submit solution", "Previous file", "Next file", "Toggle library", "Toggle course chapters", "Keyboard shortcuts", "Delete line", "Duplicate line", "Rename symbol"]) expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Rename symbol: F2, or Command plus Shift plus R")).toBeInTheDocument();
  });

  it("uses exact physical panel shortcuts and opens the modal with Mod+Period", async () => {
    renderShell(); await screen.findByRole("heading", { name: "Lesson" });
    expect(screen.getByRole("navigation", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Course outline" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "|", code: "Backslash", metaKey: true, altKey: true });
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Course outline" })).not.toBeInTheDocument());
    expect(screen.getByRole("navigation", { name: "Library" })).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "\\", code: "Backslash", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Library" })).not.toBeInTheDocument());

    fireEvent.keyDown(document.body, { key: ".", code: "Period", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Keyboard Shortcuts" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard Shortcuts" })).not.toBeInTheDocument());
  });
  it("honors a persisted library shortcut and shows its updated label", async () => {
    localStorage.setItem(HOTKEYS_STORAGE_KEY, JSON.stringify({ "panels.library": "Mod+[KeyL]" }));
    renderShell(); await screen.findByRole("heading", { name: "Lesson" });
    fireEvent.keyDown(document.body, { key: "\\", code: "Backslash", metaKey: true });
    expect(screen.getByRole("navigation", { name: "Library" })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "l", code: "KeyL", metaKey: true });
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "Library" })).not.toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Sidebar and theme controls" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: /Show library/ })).toHaveTextContent("⌘L");
  });
});
