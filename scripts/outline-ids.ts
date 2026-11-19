import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, basename } from 'node:path';
import { validateOutline, type Outline, type OutlineNode } from '../server/outlines';
import { requireRepoForCourse } from '../server/courseRepos';

// outline_nodes is keyed by node_id. Reissuing an id silently moves a reader's
// fold/check state onto unrelated prose. This command makes regeneration a diff,
// rather than an overwrite. It never edits an outline or ledger.
type Entry = { id: string; parent: string | null; text: string; type: string };
type DrillLedger = { courseId: string; drillId: string; title: string; retiredIds: string[]; entries: Entry[] };
type Ledger = { version: 1; drills: Record<string, DrillLedger> };

function usage(): never { throw new Error('Usage: npm run outline-ids -- <course-id> [outline.json] [--check]\n  --check  fail (exit 1) on any unexplained id drift; without it, report only'); }
function flatten(nodes: OutlineNode[], parent: string | null = null, out: Entry[] = []): Entry[] { for (const node of nodes) { out.push({ id: node.id, parent, text: node.text, type: node.type }); flatten(node.children ?? [], node.id, out); } return out; }
function tokens(text: string): Set<string> { return new Set(text.toLocaleLowerCase().normalize('NFKC').match(/[\p{L}\p{N}\p{M}]+/gu) ?? []); }
function jaccard(a: string, b: string): number { const left = tokens(a), right = tokens(b); let intersection = 0; for (const token of left) if (right.has(token)) intersection++; return intersection / (left.size + right.size - intersection || 1); }
async function outline(path: string, courseId: string, drillId: string): Promise<Outline> { return validateOutline(path, JSON.parse(await readFile(path, 'utf8')), courseId, drillId); }
function diff(oldEntries: Entry[], nextEntries: Entry[], retired: string[]): { lines: string[]; errors: string[] } {
  const oldById = new Map(oldEntries.map((entry) => [entry.id, entry])); const newById = new Map(nextEntries.map((entry) => [entry.id, entry]));
  const kept = nextEntries.filter((entry) => oldById.has(entry.id)).map((entry) => entry.id); const added = nextEntries.filter((entry) => !oldById.has(entry.id)); const removed = oldEntries.filter((entry) => !newById.has(entry.id)); const errors: string[] = [];
  for (const id of retired) if (newById.has(id)) errors.push(`REISSUED retired id "${id}"`);
  for (const entry of removed) if (!retired.includes(entry.id)) errors.push(`REMOVED id "${entry.id}" is not listed in retiredIds[]`);
  for (const entry of added) { const match = oldEntries.find((old) => old.parent === entry.parent && (old.text === entry.text || jaccard(old.text, entry.text) >= 0.6)); if (match) errors.push(`SUSPECTED RENAME "${match.id}" -> "${entry.id}" (same parent, matching text)`); }
  return { lines: [`ids kept: ${kept.length}${kept.length ? ` (${kept.join(', ')})` : ''}`, `ids added: ${added.length}${added.length ? ` (${added.map((entry) => entry.id).join(', ')})` : ''}`, `ids removed: ${removed.length}${removed.length ? ` (${removed.map((entry) => entry.id).join(', ')})` : ''}`, `suspected renames: ${errors.filter((error) => error.startsWith('SUSPECTED')).length}`], errors };
}
async function main(): Promise<void> {
  const args = process.argv.slice(2); if (args.includes('--help') || args.includes('-h')) { console.log('Usage: npm run outline-ids -- <course-id> [outline.json] [--check]'); console.log('--check  fail (exit 1) on any unexplained id drift; without it, report only'); return; }
  const check = args.includes('--check'); const repoIndex = args.indexOf('--repo'); const repoRoot = repoIndex >= 0 ? args[repoIndex + 1] : undefined; const courseId = args.find((arg, index) => !arg.startsWith('--') && !arg.endsWith('.json') && (repoIndex < 0 || index !== repoIndex + 1)) ?? usage(); const candidateArg = args.find((arg) => arg.endsWith('.json'));
  const root = repoRoot ? resolve(repoRoot) : requireRepoForCourse(courseId).root; const directory = resolve(root, 'outlines', courseId); const ledgerPath = resolve(directory, '.ids.json');
  try { await readdir(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { console.log(`Outline IDs ${courseId}: no outlines to check`); return; } throw error; }
  const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Ledger; if (ledger.version !== 1 || !ledger.drills) throw new Error(`Invalid ledger ${relative(root, ledgerPath)}`);
  const paths = candidateArg ? [resolve(root, candidateArg)] : (await readdir(directory)).filter((file) => file.endsWith('.json') && file !== '.ids.json').map((file) => resolve(directory, file));
  if (!paths.length) throw new Error(`No outline JSON files in ${relative(root, directory)}`);
  let failures = 0;
  for (const path of paths) {
    const drillId = basename(path, '.json'); const candidate = await outline(path, courseId, drillId); const previous = ledger.drills[drillId];
    if (!previous) { console.log(`Outline IDs ${courseId}/${drillId}`); console.log(`ids kept: 0\nids added: ${flatten(candidate.nodes).length}\nids removed: 0\nsuspected renames: 0`); if (check) { console.error(`ERROR no committed ledger entry for ${drillId}`); failures++; } continue; }
    const retired = [...new Set([...(previous.retiredIds ?? []), ...(candidate.retiredIds ?? [])])];
    const result = diff(previous.entries, flatten(candidate.nodes), retired); console.log(`Outline IDs ${courseId}/${drillId}`); for (const line of result.lines) console.log(line); for (const error of result.errors) console.error(`ERROR ${error}`); failures += result.errors.length;
  }
  if (check && failures) process.exitCode = 1;
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
