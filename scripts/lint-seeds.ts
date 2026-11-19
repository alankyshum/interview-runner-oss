import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from '@typescript/typescript6';
import { courseRepos } from '../server/courseRepos';

const repoIndex = process.argv.indexOf('--repo');
if (repoIndex >= 0 && !process.argv[repoIndex + 1]) throw new Error('--repo requires a path');
const legacyFixture = repoIndex < 0 && process.argv[2] && !process.argv[2].startsWith('-') ? resolve(process.argv[2]) : undefined;
const roots = legacyFixture ? [legacyFixture] : repoIndex >= 0 ? [resolve(process.argv[repoIndex + 1], 'drills')] : courseRepos.map((repo) => resolve(repo.root, 'drills'));
const reference = '~/.claude/skills/course--author/reference/drill-authoring.md';
const marker = 'SEED AUTHORING CONTRACT';
const errors: string[] = [];
const aiWorkspaces = new Set<string>();
for (const repo of (legacyFixture ? [] : repoIndex >= 0 ? [{ root: resolve(process.argv[repoIndex + 1]) }] : courseRepos)) {
  const courses = join(repo.root, 'courses');
  try {
    for (const name of readdirSync(courses).filter((value) => value.endsWith('.json') && !value.endsWith('.hints.json'))) {
      const manifest = JSON.parse(readFileSync(join(courses, name), 'utf8')) as { chapters?: Array<{ drills?: Array<{ contentType?: string; workspacePath?: string }> }> };
      for (const drill of manifest.chapters?.flatMap((chapter) => chapter.drills ?? []) ?? []) if (drill.contentType === 'ai-coding' && drill.workspacePath) aiWorkspaces.add(resolve(repo.root, drill.workspacePath));
    }
  } catch { /* manifest validation reports malformed repositories elsewhere */ }
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : /\.seed\.(?:ts|py)$/.test(path) ? [path] : [];
  });
}

function lineOf(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function checkType(source: ts.SourceFile, declaration: ts.TypeAliasDeclaration | ts.InterfaceDeclaration, file: string): void {
  const members = ts.isTypeAliasDeclaration(declaration) && ts.isTypeLiteralNode(declaration.type)
    ? declaration.type.members
    : ts.isInterfaceDeclaration(declaration) ? declaration.members : undefined;
  if (!members) return;
  members.forEach((member) => {
    if (!ts.isPropertySignature(member) && !ts.isPropertyDeclaration(member)) return;
    const name = member.name && ts.isIdentifier(member.name) ? member.name.text : member.name?.getText(source) ?? '<unknown>';
    if (ts.getJSDocCommentsAndTags(member).some((comment) => ts.isJSDoc(comment))) return;
    errors.push(`${file}:${lineOf(source, member)} — field '${name}' on type '${declaration.name.text}' has no doc comment (see ${reference})`);
  });
}

const seedFiles = roots.flatMap(files).filter((file) => ![...aiWorkspaces].some((workspace) => file.startsWith(`${workspace}/`)));
for (const file of seedFiles) {
  const text = readFileSync(file, 'utf8');
  if (file.endsWith('.py')) {
    if (!text.trim()) errors.push(`${relative(process.cwd(), file)}:1 — Python seed must not be empty`);
    continue;
  }
  if (!text.startsWith('/*') || (text.match(new RegExp(marker, 'g')) ?? []).length !== 1) {
    errors.push(`${relative(process.cwd(), file)}:1 — missing exactly one ${marker} header (see ${reference})`);
  }
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  source.statements.forEach((statement) => {
    if (!ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) return;
    if (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) checkType(source, statement, relative(process.cwd(), file));
  });
}

if (!roots.length) {
  console.log('Seed lint skipped: no linked course repositories.');
} else if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Seed lint passed: ${seedFiles.length} seed files checked.`);
}
