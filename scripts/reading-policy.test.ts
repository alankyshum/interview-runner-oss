// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { parseCourse } from '../shared/courseSchema';

it('cannot override the frozen reading inventory through the exported parser', () => {
  const reading = { id: 'new-book', title: 'Book', chapters: [{ id: 'one', title: 'One', drills: [{ id: 'chapter', title: 'Chapter', contentType: 'reading', kind: 'scratch', estMinutes: 1, sourcePath: 'reading/new-book/chapter.md', outlinePath: 'outlines/new-book/chapter.json', instructions: 'Read.' }] }] };
  expect(() => parseCourse('new-book.json', reading)).toThrow(/reading is deprecated/);
  // Deliberately simulate a JavaScript caller passing the removed override.
  expect(() => Reflect.apply(parseCourse, undefined, ['new-book.json', reading, false, () => true])).toThrow(/reading is deprecated/);
});

it('rejects new reading drills before scaffolding any files', () => {
  const root = mkdtempSync(join(tmpdir(), 'reading-policy-'));
  try {
    mkdirSync(join(root, 'courses'));
    writeFileSync(join(root, 'courses', 'new-book.json'), JSON.stringify({ id: 'new-book', title: 'Book', chapters: [{ id: 'one', title: 'One', drills: [{ id: 'chapter', title: 'Chapter', contentType: 'reading', kind: 'scratch', estMinutes: 1, sourcePath: 'reading/new-book/chapter.md', outlinePath: 'outlines/new-book/chapter.json', instructions: 'Read.' }] }] }));
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/scaffold-course.ts', 'new-book', '--repo', root], { cwd: process.cwd(), encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/contentType: "map".*mindmaps\/<course-id>\/<drill-id>\.md/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('scaffolds a map lesson as Markdown without overwriting it', () => {
  const root = mkdtempSync(join(tmpdir(), 'map-policy-'));
  try {
    mkdirSync(join(root, 'courses'));
    writeFileSync(join(root, 'courses', 'new-book.json'), JSON.stringify({ id: 'new-book', title: 'Book', chapters: [{ id: 'one', title: 'One', drills: [{ id: 'chapter', title: 'Chapter', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/new-book/chapter.md', instructions: 'Study.' }] }] }));
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/scaffold-course.ts', 'new-book', '--repo', root], { cwd: process.cwd(), encoding: 'utf8' });
    expect(run().status).toBe(0); const path = join(root, 'mindmaps/new-book/chapter.md'); expect(readFileSync(path, 'utf8')).toBe('# Chapter\n');
    writeFileSync(path, '# Authored'); expect(run().status).toBe(0); expect(readFileSync(path, 'utf8')).toBe('# Authored');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
