import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { bundleFromDirectory, imageReferences } from './bundle';
import { openContentDb } from './contentDb';

it.each([
  ['![https://example.com](/images/x.png)', ['images/x.png']],
  ['[text](https://a.b/images/x.png)', []],
  ['<a href="https://a.b"><img src="/images/x.png"></a>', ['images/x.png']],
  ['src="https://a.b/images/x.png"', []],
  ['https://example.com/?next=/images/x.png', []],
  ['https://example.com/path(redirect=/images/x.png', []],
  ['ftp://example.com/?next=/images/x.png', []],
  ['https://example.com/path]value=/images/x.png', []],
  ['https://example.com/path)value=/images/x.png', []],
])('resolves image references in %s', (text, expected) => {
  expect(imageReferences(Buffer.from(text))).toEqual(expected);
});

it('gathers and validates a local image following URL-shaped alt text', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'image-references-')); const repo = join(temp, 'repo');
  const oldState = process.env.XDG_STATE_HOME; const oldSource = process.env.INTERVIEW_RUNNER_CONTENT_SOURCE;
  async function file(path: string, value: string): Promise<void> { await mkdir(dirname(join(repo, path)), { recursive: true }); await writeFile(join(repo, path), value); }
  try {
    await file('interview-courses.json', JSON.stringify({ kind: 'interview-runner-courses', runner: 'interview-runner/interview-runner', schema: 2 }));
    await file('courses/map.json', JSON.stringify({ id: 'map', type: 'map-recall', title: 'Map', chapters: [{ id: 'chapter', title: 'Chapter', drills: [{ id: 'map', title: 'Map', contentType: 'map', kind: 'scratch', estMinutes: 1, sourcePath: 'mindmaps/map/map.md', instructions: 'Study.' }] }] }));
    await file('mindmaps/map/map.md', '![https://example.com](/images/x.png)'); await file('images/x.png', 'image');
    await mkdir(join(temp, 'state/interview-runner'), { recursive: true });
    await writeFile(join(temp, 'state/interview-runner/links.json'), JSON.stringify({ version: 1, runners: { 'interview-runner/interview-runner': { path: process.cwd(), supportedCourseSchema: 2 } }, courses: { 'owner/repo': { path: repo, runner: 'interview-runner/interview-runner', schema: 2 } } }));
    process.env.XDG_STATE_HOME = join(temp, 'state'); process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = 'files'; vi.resetModules();
    const { bundle, blobs } = await bundleFromDirectory(repo, 'map'); expect(bundle.files['images/x.png']).toBeDefined();
    const { putCourseBundle } = await import('./writer'); const db = await openContentDb(':memory:');
    try {
      expect(await putCourseBundle(db, bundle, blobs, { namespace: 'owner' })).toBe(1);
      delete bundle.files['images/x.png'];
      await expect(putCourseBundle(db, bundle, blobs, { namespace: 'owner' })).rejects.toMatchObject({ errors: expect.arrayContaining([{ field: 'mindmaps/map/map.md', message: 'Missing referenced image: images/x.png' }]) });
      await rm(join(repo, 'images/x.png'));
      await expect(bundleFromDirectory(repo, 'map')).rejects.toMatchObject({ errors: [{ field: 'mindmaps/map/map.md', message: 'Missing referenced image: images/x.png' }] });
    } finally { db.close(); }
  } finally {
    if (oldState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = oldState;
    if (oldSource === undefined) delete process.env.INTERVIEW_RUNNER_CONTENT_SOURCE; else process.env.INTERVIEW_RUNNER_CONTENT_SOURCE = oldSource;
    await rm(temp, { recursive: true, force: true });
  }
});
