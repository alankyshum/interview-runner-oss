import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CourseRunnerHotkeysProvider, HOTKEYS_STORAGE_KEY, SANDBOX_HOTKEY_EVENT } from "./appHotkeys";
import SandboxFrame from "./SandboxFrame";

describe("SandboxFrame readiness", () => {
  beforeEach(() => { localStorage.clear(); vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel"); });
  afterEach(() => vi.useRealTimers());

  it("stops waiting for an iframe after 30 seconds and offers Retry", () => {
    vi.useFakeTimers(); const retry = vi.fn();
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxFrame url="/sandbox/s1/" onRetry={retry} /></CourseRunnerHotkeysProvider></MantineProvider>);
    expect(screen.getByText("Starting sandbox…")).toBeInTheDocument(); act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole("alert")).toHaveTextContent("The editor could not be loaded.");
  });

  it.each([
    ["Mod+Backslash", "panels.library", { key: "\\", code: "Backslash", metaKey: true }],
    ["Mod+Alt+Backslash", "panels.courseChapters", { key: "\\", code: "Backslash", metaKey: true, altKey: true }],
    ["Mod+Quote", "runner.runTests", { key: "'", code: "Quote", metaKey: true }],
    ["Mod+Enter", "runner.submit", { key: "Enter", code: "Enter", metaKey: true }],
  ])("captures %s in the iframe and forwards it to the runner", (_label, expected, init) => {
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxFrame url="/sandbox/s1/" onRetry={vi.fn()} /></CourseRunnerHotkeysProvider></MantineProvider>);
    const frame = screen.getByTitle("Sandbox editor") as HTMLIFrameElement; fireEvent.load(frame);
    const runner = vi.fn(); const editor = vi.fn(); window.addEventListener(SANDBOX_HOTKEY_EVENT, runner); frame.contentDocument!.addEventListener("keydown", editor);
    const event = new KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }); frame.contentDocument!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); expect(editor).not.toHaveBeenCalled(); expect(runner).toHaveBeenCalledOnce(); expect((runner.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: expected });
    window.removeEventListener(SANDBOX_HOTKEY_EVENT, runner); frame.contentDocument!.removeEventListener("keydown", editor);
  });

  it("uses customized runner bindings and leaves Mod+S to code-server", () => {
    localStorage.setItem(HOTKEYS_STORAGE_KEY, JSON.stringify({ "panels.library": "Mod+[KeyL]" }));
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxFrame url="/sandbox/s1/" onRetry={vi.fn()} /></CourseRunnerHotkeysProvider></MantineProvider>);
    const frame = screen.getByTitle("Sandbox editor") as HTMLIFrameElement; fireEvent.load(frame);
    const runner = vi.fn(); const editor = vi.fn(); window.addEventListener(SANDBOX_HOTKEY_EVENT, runner); frame.contentDocument!.addEventListener("keydown", editor);

    const customized = new KeyboardEvent("keydown", { key: "l", code: "KeyL", metaKey: true, bubbles: true, cancelable: true }); frame.contentDocument!.dispatchEvent(customized);
    expect(customized.defaultPrevented).toBe(true); expect(runner).toHaveBeenCalledOnce(); expect(editor).not.toHaveBeenCalled(); expect((runner.mock.calls[0][0] as CustomEvent).detail).toEqual({ id: "panels.library" });

    const save = new KeyboardEvent("keydown", { key: "s", code: "KeyS", metaKey: true, bubbles: true, cancelable: true }); frame.contentDocument!.dispatchEvent(save);
    expect(save.defaultPrevented).toBe(false); expect(runner).toHaveBeenCalledOnce(); expect(editor).toHaveBeenCalledOnce();
    const optionDown = new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", altKey: true, bubbles: true, cancelable: true }); frame.contentDocument!.dispatchEvent(optionDown);
    expect(optionDown.defaultPrevented).toBe(false); expect(runner).toHaveBeenCalledOnce(); expect(editor).toHaveBeenCalledTimes(2);
    const commandTwo = new KeyboardEvent("keydown", { key: "2", code: "Digit2", metaKey: true, bubbles: true, cancelable: true }); frame.contentDocument!.dispatchEvent(commandTwo);
    expect(commandTwo.defaultPrevented).toBe(false); expect(runner).toHaveBeenCalledOnce(); expect(editor).toHaveBeenCalledTimes(3);
    window.removeEventListener(SANDBOX_HOTKEY_EVENT, runner); frame.contentDocument!.removeEventListener("keydown", editor);
  });

  it("leaves the palette binding and Monaco chords inside the sandbox", () => {
    localStorage.setItem(HOTKEYS_STORAGE_KEY, JSON.stringify({ "palette.open": "Mod+[KeyP]" }));
    render(<MantineProvider><CourseRunnerHotkeysProvider><SandboxFrame url="/sandbox/s1/" onRetry={vi.fn()} /></CourseRunnerHotkeysProvider></MantineProvider>);
    const frame = screen.getByTitle("Sandbox editor") as HTMLIFrameElement; fireEvent.load(frame);
    const runner = vi.fn(); window.addEventListener(SANDBOX_HOTKEY_EVENT, runner);
    for (const [key, code] of [["k", "KeyK"], ["p", "KeyP"]]) {
      const event = new KeyboardEvent("keydown", { key, code, metaKey: true, bubbles: true, cancelable: true });
      frame.contentDocument!.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
    }
    expect(runner).not.toHaveBeenCalled(); window.removeEventListener(SANDBOX_HOTKEY_EVENT, runner);
  });
});
