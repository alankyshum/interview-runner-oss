export type QuestionCard = { kind: "context" | "spec"; markdown: string; heading?: string; headingDepth?: number; headingLine?: number };

export const CONTEXT_HEADINGS = ["practice rules", "provenance and practice rules", "why this is here", "why this exercise"] as const;
const contextHeadings = new Set<string>(CONTEXT_HEADINGS);
export const normalizeQuestionHeading = (value: string) => value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

type Heading = { line: number; depth: number; title: string };
function headings(markdown: string): Heading[] {
  const result: Heading[] = []; let fence: { marker: string; length: number } | undefined;
  markdown.split(/\r?\n/).forEach((line, index) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      const next = { marker: marker[1][0], length: marker[1].length };
      if (!fence) fence = next;
      else if (fence.marker === next.marker && next.length >= fence.length) fence = undefined;
      return;
    }
    if (fence) return;
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (heading) result.push({ line: index, depth: heading[1].length, title: heading[2].trim() });
  });
  return result;
}

export function questionCards(markdown: string): QuestionCard[] {
  const allHeadings = headings(markdown); if (!allHeadings.length) return [{ kind: "spec", markdown }];
  const depth = Math.min(...allHeadings.map((heading) => heading.depth)); const shallow = allHeadings.filter((heading) => heading.depth === depth); const sourceLines = markdown.split(/\r?\n/);
  const sections = shallow.map((heading, index) => ({ heading, start: index === 0 ? 0 : heading.line, end: shallow[index + 1]?.line ?? sourceLines.length }));
  let contextCount = 0; while (contextCount < sections.length && contextHeadings.has(normalizeQuestionHeading(sections[contextCount].heading.title))) contextCount++;
  if (!contextCount) return [{ kind: "spec", markdown, heading: shallow[0].title, headingDepth: depth, headingLine: shallow[0].line + 1 }];
  const card = (kind: QuestionCard["kind"], start: number, end: number, heading: Heading): QuestionCard => ({ kind, markdown: sourceLines.slice(start, end).join("\n"), heading: heading.title, headingDepth: heading.depth, headingLine: heading.line - start + 1 });
  const result = [card("context", 0, sections[contextCount]?.start ?? sourceLines.length, sections[0].heading)];
  if (contextCount < sections.length) result.push(card("spec", sections[contextCount].start, sourceLines.length, sections[contextCount].heading));
  return result;
}
