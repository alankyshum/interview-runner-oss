import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./copyText";

describe("copyText", () => {
  const originalClipboard = navigator.clipboard;
  const originalExecCommand = document.execCommand;

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
    document.execCommand = originalExecCommand;
    document.body.querySelectorAll("textarea").forEach((textarea) => textarea.remove());
    vi.restoreAllMocks();
  });

  it("uses navigator.clipboard when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    expect(await copyText("path")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("path");
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("falls back to execCommand when clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = vi.fn().mockReturnValue(true);
    expect(await copyText("path")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("falls back when clipboard.writeText rejects", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    document.execCommand = vi.fn().mockReturnValue(true);
    expect(await copyText("path")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("returns false when both copy paths fail", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    document.execCommand = vi.fn().mockImplementation(() => { throw new Error("denied"); });
    expect(await copyText("path")).toBe(false);
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("removes the temporary textarea when execCommand returns false", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    document.execCommand = vi.fn().mockReturnValue(false);
    expect(await copyText("path")).toBe(false);
    expect(document.body.querySelector("textarea")).toBeNull();
  });
});
