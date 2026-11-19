import type { ReactNode } from "react";
import { stripAnsi } from "../stripAnsi";

export default function CodeOutput({ children, label, lineNumbers = false, diff = false }: { children: ReactNode; label?: string; lineNumbers?: boolean; diff?: boolean }) {
  const content = typeof children === "string" ? stripAnsi(children) : children;
  const rendered = lineNumbers && typeof content === "string" ? content.split("\n").map((line, index) => <span key={index} style={{ display: "grid", gridTemplateColumns: "3.5rem minmax(0, 1fr)", background: diff && line.startsWith("+") && !line.startsWith("+++") ? "var(--ir-color-success-bg)" : diff && line.startsWith("-") && !line.startsWith("---") ? "var(--ir-color-danger-bg)" : undefined }}><span aria-hidden="true" style={{ userSelect: "none", textAlign: "right", paddingRight: "1rem", color: "var(--ir-color-text-secondary)" }}>{index + 1}</span><span>{line || " "}</span></span>) : content;
  return <pre className="ir-scroll-region" role={label ? "region" : undefined} aria-label={label} tabIndex={label ? 0 : undefined} style={{ margin: 0, maxHeight: lineNumbers ? "24rem" : "16rem", overflow: "auto", whiteSpace: lineNumbers ? "pre" : "pre-wrap", overflowWrap: lineNumbers ? "normal" : "anywhere", padding: "var(--mantine-spacing-xs)", borderRadius: "var(--ir-radius-default)", background: "var(--ir-color-raised)", color: "var(--ir-color-text)", fontFamily: "var(--mantine-font-family-monospace)", fontSize: "var(--mantine-font-size-sm)", lineHeight: 1.45 }}><code>{rendered}</code></pre>;
}
