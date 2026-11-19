import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import CodeOutput from "./CodeOutput";

describe("CodeOutput", () => {
  it("preserves multiline whitespace in a bounded monospace pre/code block", () => {
    render(<CodeOutput label="failure output">{"first line\n    indented line\nthird line"}</CodeOutput>);
    const output = screen.getByLabelText("failure output");
    expect(output.tagName).toBe("PRE"); expect(output.querySelector("code")).toHaveTextContent("first line indented line third line");
    expect(output.style.whiteSpace).toBe("pre-wrap"); expect(output.style.overflowWrap).toBe("anywhere"); expect(output.style.overflow).toBe("auto"); expect(output.style.maxHeight).toBe("16rem"); expect(output.style.fontFamily).toContain("--mantine-font-family-monospace");
    expect(output.textContent).toBe("first line\n    indented line\nthird line");
  });

  it("renders colored object inspection and plain Unicode as clean text", () => {
    const value = "{ status: \u001b[32m'pass'\u001b[39m, label: 'café ✓' }";
    render(<CodeOutput label="console output">{value}</CodeOutput>);

    expect(screen.getByLabelText("console output")).toHaveTextContent("{ status: 'pass', label: 'café ✓' }");
    expect(screen.getByLabelText("console output").textContent).not.toContain("\u001b");
  });

  it("renders accessible line-numbered diff output", () => {
    render(<CodeOutput label="source diff" lineNumbers diff>{"--- a/file.ts\n+++ b/file.ts\n-old\n+new"}</CodeOutput>);
    const output = screen.getByLabelText("source diff");
    expect(output.style.whiteSpace).toBe("pre");
    expect(output.querySelectorAll("code > span")).toHaveLength(4);
    expect(output.textContent).toContain("1--- a/file.ts");
  });
});
