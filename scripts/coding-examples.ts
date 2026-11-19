import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { loadCourseHints, loadCourses } from '../server/courses';

export type ExampleFinding = { courseId: string; field: string; message: string };
type Language = 'python' | 'typescript';
type Fence = { start: number; end: number; language: string; body: string[]; closed: boolean };
type Heading = { line: number; level: number; example: boolean };

/** Deterministic syntax checks only: expected values still require execution against tests or a reference. */
export function codingExampleTextIssues(text: string, languages: readonly Language[]): string[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const fences: Fence[] = []; const headings: Heading[] = []; const prose = [...lines];
  let open: Fence | undefined; let originalPrompt = false;
  for (const [index, line] of lines.entries()) {
    if (open) {
      prose[index] = '';
      if (/^\s*```\s*$/.test(line)) { open.end = index; open.closed = true; fences.push(open); open = undefined; }
      else open.body.push(line);
      continue;
    }
    // Exempt only the contiguous blockquote explicitly labeled as the verbatim prompt.
    if (originalPrompt && !/^\s{0,3}>/.test(line)) originalPrompt = false;
    if ((index === 0 || !/^\s{0,3}>/.test(lines[index - 1]!)) && /^\s{0,3}>\s*(?:\*\*Original interview prompt \(verbatim\)\*\*|Original interview prompt \(verbatim\))\s*$/i.test(line)) originalPrompt = true;
    if (originalPrompt) { prose[index] = ''; continue; }
    const fence = /^\s*```([^`]*)$/.exec(line);
    if (fence) { prose[index] = ''; open = { start: index, end: lines.length, language: fence[1]!.trim(), body: [], closed: false }; continue; }
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (heading) { headings.push({ line: index, level: heading[1]!.length, example: /^(?:(?:worked|illustrative)\s+)?examples?\b/i.test(heading[2]!) }); prose[index] = ''; }
  }
  if (open) fences.push(open);
  const findings: string[] = [];
  const exampleRanges = headings.filter((heading) => heading.example).map((heading) => ({ start: heading.line, end: headings.find((item) => item.line > heading.line && item.level <= heading.level)?.line ?? lines.length }));
  for (const fence of fences) if (!exampleRanges.some((range) => fence.start > range.start && fence.start < range.end) && fence.body.some((line) => /(?:#|\/\/)\s*->\s*\S/.test(line))) findings.push(`line ${fence.start + 1}: call-and-output examples must be under an Examples heading`);
  for (const heading of headings.filter((item) => item.example)) {
    const end = headings.find((item) => item.line > heading.line && item.level <= heading.level)?.line ?? lines.length;
    // A plural container may have individual example subheadings, each checked independently.
    if (headings.some((item) => item.example && item.line > heading.line && item.line < end)) continue;
    const blocks = fences.filter((fence) => fence.start > heading.line && fence.start < end);
    if (!blocks.length) { findings.push(`line ${heading.line + 1}: example section requires a fenced code block`); continue; }
    for (const block of blocks) {
      if (!block.closed) { findings.push(`line ${block.start + 1}: example fence is not closed`); continue; }
      if (!languages.includes(block.language as Language)) { findings.push(`line ${block.start + 1}: example fence must use ${languages.join(' or ')}`); continue; }
      const marker = block.language === 'python' ? '#' : '//';
      const pair = new RegExp(`^\\s*(?:(?:const|let|var)\\s+)?(?:[A-Za-z_$][\\w.$]*\\s*=\\s*)?(?:await\\s+)?(?:new\\s+)?[A-Za-z_$][\\w.$]*\\s*\\([^\\n]*\\)\\s*;?\\s*${marker}\\s*->\\s*\\S`, 'm');
      if (!pair.test(block.body.join('\n'))) findings.push(`line ${block.start + 1}: example block requires a call followed by ${marker} -> output`);
    }
  }
  let paragraph: string[] = []; let start = 0;
  const flush = () => {
    const value = paragraph.join(' ').replaceAll('**', ''); paragraph = [];
    if (/\bfor example\b|\be\.g\.(?=\s|[,;:]|$)|\bexamples?\s*[:—-]|\bexample\s+input\b/i.test(value) || (/\binput\s*:/i.test(value) && /\boutput\s*:/i.test(value)) || /\b(?:for|given|when)\b(?=[^.\n]{0,120}\b(?:returns?|outputs?|produces?)\b)[^.\n]{0,120}[0-9'"\[{][^.\n]{0,120}\b(?:returns?|outputs?|produces?)\s+(?:true|false|null|none|-?\d+)(?![\w-])/i.test(value)) findings.push(`line ${start + 1}: example-like prose must be replaced with a fenced call-and-output example`);
  };
  for (const [index, line] of prose.entries()) { if (!line.trim()) { if (paragraph.length) flush(); } else { if (!paragraph.length) start = index; paragraph.push(line); } }
  if (paragraph.length) flush();
  let inputLine: number | undefined; const headingLines = new Set(headings.map((heading) => heading.line));
  for (const [index, line] of prose.entries()) {
    if (headingLines.has(index)) inputLine = undefined;
    const value = line.replaceAll('**', '');
    const input = /\binput\s*:\s*(.*)/i.exec(value);
    if (input && /[0-9'"\[{]/.test(input[1]!)) inputLine = index;
    if (inputLine !== undefined && index > inputLine && index - inputLine <= 12 && /\boutput\s*:/i.test(value)) { findings.push(`line ${inputLine + 1}: Input/Output prose must be replaced with a fenced call-and-output example`); inputLine = undefined; }
  }
  return findings;
}

/** Strict form for authoring checks; publication rejects the same findings. */
export function assertCodingExampleText(text: string, languages: readonly Language[]): void {
  const issues = codingExampleTextIssues(text, languages);
  if (issues.length) throw new Error(issues.join('; '));
}

export async function findCodingExampleIssues(coursesDir: string, selectedCourseIds: readonly string[] = []): Promise<ExampleFinding[]> {
  const courses = await loadCourses(coursesDir); const selected = new Set(selectedCourseIds); const root = dirname(coursesDir); const findings: ExampleFinding[] = [];
  for (const course of courses) {
    if (selected.size && !selected.has(course.id)) continue;
    const files = new Map<string, Set<Language>>(); const handoffs = new Map<string, Set<Language>>();
    const add = (path: string, language: Language) => { const set = files.get(path) ?? new Set<Language>(); set.add(language); files.set(path, set); };
    const walk = async (directory: string, language: Language): Promise<void> => {
      let entries; try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || ['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', '__pycache__'].includes(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path, language);
        else if (entry.isFile() && (/\.md$/i.test(entry.name) || /(?:^|[-_.])(?:notes|handoff)\.txt$/i.test(entry.name))) add(relative(root, path).replaceAll('\\', '/'), language);
      }
    };
    const coding = course.chapters.flatMap((chapter, ci) => chapter.drills.map((drill, di) => ({ drill, ci, di }))).filter(({ drill }) => drill.contentType === 'coding' || drill.contentType === 'ai-coding');
    for (const { drill, ci, di } of coding) {
      const language: Language = drill.sourcePath.endsWith('.py') ? 'python' : 'typescript';
      for (const message of codingExampleTextIssues(drill.instructions, [language])) findings.push({ courseId: course.id, field: `chapters[${ci}].drills[${di}].instructions`, message });
      if (drill.contentType === 'ai-coding') { add(drill.handoffPath, language); const set = handoffs.get(drill.handoffPath) ?? new Set<Language>(); set.add(language); handoffs.set(drill.handoffPath, set); }
      await walk(resolve(root, 'drills', course.id, drill.id), language);
    }
    const hints = coding.length ? await loadCourseHints(course.id, coursesDir) : undefined;
    if (hints) for (const { drill } of coding) {
      const language: Language = drill.sourcePath.endsWith('.py') ? 'python' : 'typescript';
      for (const [index, hint] of (hints.drills[drill.id] ?? []).entries()) for (const field of ['approach', 'solution'] as const) for (const message of codingExampleTextIssues(hint[field], [language])) findings.push({ courseId: course.id, field: `courses/${course.id}.hints.json:${drill.id}[${index}].${field}`, message });
    }
    // Shared coding guides may serve multiple drills and languages.
    for (const language of new Set(coding.map(({ drill }): Language => drill.sourcePath.endsWith('.py') ? 'python' : 'typescript'))) await walk(resolve(root, 'guides', course.id), language);
    for (const [path, languages] of files) {
      const absolute = resolve(root, path); const info = await lstat(absolute); if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${path}: coding note must be a regular file`);
      const text = await readFile(absolute, 'utf8');
      const required = handoffs.get(path);
      const checks = required ? [...required].map((language) => [language]) : [[...languages]];
      for (const allowed of checks) for (const message of codingExampleTextIssues(text, allowed)) if (!findings.some((finding) => finding.courseId === course.id && finding.field === path && finding.message === message)) findings.push({ courseId: course.id, field: path, message });
    }
  }
  return findings.sort((a, b) => `${a.field}/${a.message}`.localeCompare(`${b.field}/${b.message}`));
}
