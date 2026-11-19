import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyableMarkdownPre } from "./CourseShell";

describe("CopyableMarkdownPre", () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: originalClipboard });
  });

  it("copies one fenced block as a single string", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<MantineProvider><CopyableMarkdownPre><code>{"# Role\n\nOne question.\n"}</code></CopyableMarkdownPre></MantineProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# Role\n\nOne question."));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});
