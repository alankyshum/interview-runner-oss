import { createHash } from 'node:crypto';
import { listCheatsheets, loadCheatsheet } from './courses';
import { contentReader } from './content/reader';
import type { Cheatsheet } from '../shared/courseSchema';

export async function availableCheatsheets() {
  return (await listCheatsheets()).map(({ id, title, repo }) => ({ id, title, repo }));
}

/** Read the layout and every declared section from the owning repository for each request. */
export async function readCheatsheetDocument(sheet: Cheatsheet): Promise<{ layout: string | null; sections: Array<{ id: string; html: string }> }> {
  const readContained = async (path: string) => {
    if (!path.startsWith(`cheatsheets/${sheet.id}/`)) throw new Error('Cheatsheet path escapes its directory');
    const bytes = await contentReader().readCourseFile(sheet.id, path);
    if (!bytes) throw Object.assign(new Error(`Missing ${path}`), { code: 'ENOENT' });
    return Buffer.from(bytes).toString('utf8');
  };
  const lessons = sheet.chapters.flatMap((chapter) => chapter.drills);
  const sections = await Promise.all(lessons.map(async (lesson) => {
    try { return { id: lesson.id, html: await readContained(lesson.sourcePath) }; }
    catch (error) { throw new Error(`Unable to read cheatsheet section "${lesson.title}": ${error instanceof Error ? error.message : 'unavailable'}`); }
  }));
  let layout: string | null = null;
  try { layout = await readContained(`cheatsheets/${sheet.id}/page.html`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { layout, sections };
}

const assetTypes: Record<string, { contentType: string; charset?: string }> = {
  '.html': { contentType: 'text/plain', charset: 'utf-8' },
  '.md': { contentType: 'text/plain', charset: 'utf-8' },
  '.mmd': { contentType: 'text/plain', charset: 'utf-8' },
  '.png': { contentType: 'image/png' },
  '.svg': { contentType: 'image/svg+xml' },
  '.pdf': { contentType: 'application/pdf' },
};

export async function readCheatsheetAsset(pathSegments: readonly string[]): Promise<{ body: Buffer; contentType: string; sha256: string } | undefined> {
  if (pathSegments.length < 2) return undefined;
  let segments: string[];
  try { segments = pathSegments.map((segment) => decodeURIComponent(segment)); } catch { return undefined; }
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || segment.startsWith('.') || /[\\/\0]/.test(segment))) return undefined;
  const [id, ...relativeSegments] = segments;
  const sheet = id ? await loadCheatsheet(id) : undefined;
  if (!id || !relativeSegments.length || !sheet) return undefined;
  const extension = relativeSegments.at(-1)?.slice(relativeSegments.at(-1)?.lastIndexOf('.') ?? -1).toLowerCase();
  const type = extension ? assetTypes[extension] : undefined;
  if (!type) return undefined;
  const requestedPath = `cheatsheets/${id}/${relativeSegments.join('/')}`;
  if (extension === '.md' && !/^diagrams\/mindmaps\/[a-zA-Z0-9_-]+\.md$/.test(relativeSegments.join('/'))) return undefined;
  if (extension === '.mmd' && !/^diagrams\/mermaid\/[a-zA-Z0-9_-]+\.mmd$/.test(relativeSegments.join('/'))) return undefined;
  if (extension === '.html' && requestedPath !== `cheatsheets/${id}/page.html` && !sheet.chapters.some((chapter) => chapter.drills.some((lesson) => lesson.sourcePath === requestedPath))) return undefined;
  try {
    const blob = await contentReader().readCourseBlob(id, requestedPath);
    if (!blob) return undefined;
    const { bytes, sha256 } = blob;
    const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (requestedPath === `cheatsheets/${id}/page.html`) {
      const expected = /^<!-- interview-runner-sections-sha256:([a-f0-9]{64}) -->\n/.exec(body.toString('utf8'))?.[1];
      if (!expected) return undefined;
      const lessons = sheet.chapters.flatMap((chapter) => chapter.drills);
      const sections = await Promise.all(lessons.map(async (lesson) => {
        if (!lesson.sourcePath.startsWith(`cheatsheets/${id}/`)) throw new Error('Invalid cheatsheet section path');
        const section = await contentReader().readCourseFile(id, lesson.sourcePath);
        if (!section) throw new Error('Missing cheatsheet section');
        return section;
      }));
      const digest = createHash('sha256');
      lessons.forEach((lesson, index) => digest.update(lesson.id).update('\0').update(sections[index]).update('\0'));
      if (digest.digest('hex') !== expected) return undefined;
    }
    return { body, sha256, contentType: `${type.contentType}${type.charset ? `; charset=${type.charset}` : ''}` };
  } catch { return undefined; }
}
