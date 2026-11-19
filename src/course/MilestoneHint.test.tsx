import { MantineProvider } from "@mantine/core";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoldForHint, type MilestoneHintContent } from "./MilestoneHint";

const hint: MilestoneHintContent = { title: "Milestone 1", approach: "Track one queue.", solution: "```text\nexpire -> admit -> record\n```" };
const holdName = (title = "Milestone 1") => `Hold 3s for hint · ${title} (hold for 3 seconds)`;
const startPointer = (button: HTMLElement, overrides: Record<string, unknown> = {}) => fireEvent.pointerDown(button, { pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, ...overrides });
const renderHint = (title = "Milestone 1", onUnlock = vi.fn(), onHoldTransition = vi.fn()) => ({ onUnlock, onHoldTransition, ...render(<MantineProvider><HoldForHint title={title} hint={{ ...hint, title }} onUnlock={onUnlock} onHoldTransition={onHoldTransition} /></MantineProvider>) });

describe("HoldForHint", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("is compact while idle and uses milestone-specific accessible names", () => {
    renderHint("Milestone 2"); const button = screen.getByRole("button", { name: holdName("Milestone 2") });
    expect(button).toHaveTextContent("Hold 3s for hint"); expect(button).toHaveStyle({ touchAction: "none" });
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument(); expect(screen.queryByText(/Hold continuously/)).not.toBeInTheDocument();
  });

  it("stays locked at 2999ms and unlocks at 3000ms with one start and unlock transition", () => {
    const { onUnlock, onHoldTransition } = renderHint(); const button = screen.getByRole("button", { name: holdName() }); startPointer(button);
    expect(onHoldTransition).toHaveBeenCalledOnce(); expect(onHoldTransition).toHaveBeenCalledWith("Milestone 1", "started"); expect(screen.getByRole("progressbar")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2_999)); expect(screen.queryByLabelText("Hint for Milestone 1")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1)); expect(screen.getByLabelText("Hint for Milestone 1")).toBeInTheDocument(); expect(onUnlock).toHaveBeenCalledOnce(); expect(onHoldTransition).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Hide hint for Milestone 1" })).toBeInTheDocument();
  });

  it("keeps the answer visible when releasing a completed hold, but lets the next click hide it", () => {
    renderHint(); const button = screen.getByRole("button", { name: holdName() }); startPointer(button);
    act(() => vi.advanceTimersByTime(3_000)); fireEvent.pointerUp(button); fireEvent.click(button);
    expect(screen.getByLabelText("Hint for Milestone 1")).toBeInTheDocument();
    startPointer(button); fireEvent.pointerUp(button); fireEvent.click(button);
    expect(screen.queryByLabelText("Hint for Milestone 1")).not.toBeInTheDocument();
  });

  it("keeps the answer visible after releasing a completed keyboard hold", () => {
    renderHint(); const button = screen.getByRole("button", { name: holdName() }); fireEvent.keyDown(button, { key: " ", repeat: false });
    act(() => vi.advanceTimersByTime(3_000)); fireEvent.keyUp(button, { key: " " }); fireEvent.click(button);
    expect(screen.getByLabelText("Hint for Milestone 1")).toBeInTheDocument();
    fireEvent.keyDown(button, { key: " ", repeat: false }); fireEvent.keyUp(button, { key: " " }); fireEvent.click(button);
    expect(screen.queryByLabelText("Hint for Milestone 1")).not.toBeInTheDocument();
  });

  it("keeps unlocking behavior when rendered at the normalized card heading level", () => {
    const onUnlock = vi.fn(); render(<MantineProvider><HoldForHint title="Milestone 1" headingLevel={3} headingSize="lg" hint={hint} onUnlock={onUnlock} /></MantineProvider>);
    expect(screen.getByRole("heading", { name: "Milestone 1", level: 3 })).toBeInTheDocument(); startPointer(screen.getByRole("button", { name: holdName() })); act(() => vi.advanceTimersByTime(3_000)); expect(screen.getByLabelText("Hint for Milestone 1")).toBeInTheDocument(); expect(onUnlock).toHaveBeenCalledOnce();
  });

  it("does not unlock from a simple click", () => { renderHint(); fireEvent.click(screen.getByRole("button", { name: holdName() })); act(() => vi.advanceTimersByTime(3_100)); expect(screen.queryByLabelText("Hint for Milestone 1")).not.toBeInTheDocument(); });

  it.each(["pointerUp", "pointerLeave", "pointerCancel", "lostPointerCapture", "blur", "windowBlur", "keyUp"])("cancels on %s once before the threshold", (kind) => {
    const { onHoldTransition } = renderHint(); const button = screen.getByRole("button", { name: holdName() });
    if (kind === "keyUp") fireEvent.keyDown(button, { key: " ", repeat: false }); else startPointer(button);
    act(() => vi.advanceTimersByTime(1_500));
    if (kind === "windowBlur") fireEvent(window, new Event("blur")); else if (kind === "keyUp") fireEvent.keyUp(button, { key: " " }); else if (kind === "blur") fireEvent.blur(button); else if (kind === "pointerUp") fireEvent.pointerUp(button); else if (kind === "pointerLeave") fireEvent.pointerLeave(button); else if (kind === "pointerCancel") fireEvent.pointerCancel(button); else fireEvent(button, new Event("lostpointercapture", { bubbles: true }));
    act(() => vi.advanceTimersByTime(2_000)); expect(screen.queryByLabelText("Hint for Milestone 1")).not.toBeInTheDocument(); expect(onHoldTransition.mock.calls).toEqual([["Milestone 1", "started"], ["Milestone 1", "cancelled"]]);
  });

  it("ignores secondary and non-primary pointers and prevents the hold context menu", () => {
    const { onHoldTransition } = renderHint(); const button = screen.getByRole("button", { name: holdName() });
    startPointer(button, { button: 2 }); startPointer(button, { isPrimary: false }); act(() => vi.advanceTimersByTime(3_100)); expect(onHoldTransition).not.toHaveBeenCalled(); expect(screen.queryByLabelText("Hint for Milestone 1")).not.toBeInTheDocument();
    const context = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); button.dispatchEvent(context); expect(context.defaultPrevented).toBe(true);
  });

  it("ignores repeated keydown events and requires one continuous hold", () => {
    const { onHoldTransition } = renderHint(); const button = screen.getByRole("button", { name: holdName() }); fireEvent.keyDown(button, { key: "Enter", repeat: false }); act(() => vi.advanceTimersByTime(1_000));
    fireEvent.keyDown(button, { key: "Enter", repeat: true }); act(() => vi.advanceTimersByTime(1_999)); expect(screen.queryByLabelText("Hint for Milestone 1")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1)); expect(screen.getByLabelText("Hint for Milestone 1")).toBeInTheDocument(); expect(onHoldTransition).toHaveBeenCalledTimes(1);
  });

  it("keeps milestones independent and resets disclosure state on drill switch", () => {
    const view = render(<MantineProvider><div><HoldForHint title="Milestone 1" hint={hint} onUnlock={vi.fn()} /><HoldForHint title="Milestone 2" hint={{ ...hint, title: "Milestone 2" }} onUnlock={vi.fn()} /></div></MantineProvider>);
    startPointer(screen.getByRole("button", { name: holdName("Milestone 1") })); act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByLabelText("Hint for Milestone 1")).toBeInTheDocument(); expect(screen.queryByLabelText("Hint for Milestone 2")).not.toBeInTheDocument();
    view.rerender(<MantineProvider><HoldForHint key="other-drill" title="Milestone 1" hint={hint} onUnlock={vi.fn()} /></MantineProvider>); expect(screen.getByRole("button", { name: holdName() })).toHaveAttribute("aria-expanded", "false");
  });

  it("cancels timers on unmount", () => { const onUnlock = vi.fn(); const view = renderHint("Milestone 1", onUnlock); startPointer(screen.getByRole("button", { name: holdName() })); view.unmount(); act(() => vi.advanceTimersByTime(3_100)); expect(onUnlock).not.toHaveBeenCalled(); });
});
