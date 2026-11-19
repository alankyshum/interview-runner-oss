import { join } from 'node:path';
import { invalid, safePath, stringField, unknownFields } from '../shared/courseSchema';

export type OutlineNodeType = 'claim' | 'mechanism' | 'framework' | 'step' | 'term' | 'boundary' | 'contrast' | 'question';
export type OutlineNode = {
  id: string; type: OutlineNodeType; text: string; children?: OutlineNode[];
  preformatted?: boolean;
  diagram?: { lang: 'mermaid'; src: string; caption?: string };
  term?: { en: string; zh?: string; definition: string; useWhen: string; contrast?: string };
  image?: { src: string; alt: string }; link?: { href: string; label: string }; hash?: string;
};
export type Outline = { courseId: string; drillId: string; title: string; retiredIds?: string[]; nodes: OutlineNode[] };

const nodeTypes = new Set<OutlineNodeType>(['claim', 'mechanism', 'framework', 'step', 'term', 'boundary', 'contrast', 'question']);
const nodeId = /^[a-z0-9][a-z0-9-]*$/;

function record(value: unknown, file: string, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(file, field);
  return value as Record<string, unknown>;
}
function validateNode(value: unknown, file: string, field: string, depth: number, ids: Set<string>): OutlineNode {
  const raw = record(value, file, field);
  const id = stringField(raw.id, file, `${field}.id`);
  if (!nodeId.test(id) || /^\d/.test(id) || id.includes('.')) invalid(file, `${field}.id`);
  if (ids.has(id)) invalid(file, `duplicate node id "${id}"`);
  ids.add(id);
  if (depth > 4) invalid(file, `depth exceeds L4 at node "${id}"`);
  unknownFields(raw, new Set(['id', 'type', 'text', 'children', 'preformatted', 'diagram', 'term', 'image', 'link', 'hash']), file, field);
  if (!nodeTypes.has(raw.type as OutlineNodeType)) invalid(file, `${field}.type`);
  const node: OutlineNode = { id, type: raw.type as OutlineNodeType, text: stringField(raw.text, file, `${field}.text`) };
  if (raw.preformatted !== undefined) {
    if (typeof raw.preformatted !== 'boolean') invalid(file, `${field}.preformatted`);
    node.preformatted = raw.preformatted;
  }
  if (raw.children !== undefined) {
    if (!Array.isArray(raw.children)) invalid(file, `${field}.children`);
    node.children = raw.children.map((child, index) => validateNode(child, file, `${field}.children[${index}]`, depth + 1, ids));
  }
  if (raw.diagram !== undefined) { const d = record(raw.diagram, file, `${field}.diagram`); unknownFields(d, new Set(['lang', 'src', 'caption']), file, `${field}.diagram`); if (d.lang !== 'mermaid') invalid(file, `${field}.diagram.lang`); node.diagram = { lang: 'mermaid', src: stringField(d.src, file, `${field}.diagram.src`), ...(d.caption === undefined ? {} : { caption: stringField(d.caption, file, `${field}.diagram.caption`) }) }; }
  if (raw.term !== undefined) { const t = record(raw.term, file, `${field}.term`); unknownFields(t, new Set(['en', 'zh', 'definition', 'useWhen', 'contrast']), file, `${field}.term`); node.term = { en: stringField(t.en, file, `${field}.term.en`), definition: stringField(t.definition, file, `${field}.term.definition`), useWhen: stringField(t.useWhen, file, `${field}.term.useWhen`), ...(t.zh === undefined ? {} : { zh: stringField(t.zh, file, `${field}.term.zh`) }), ...(t.contrast === undefined ? {} : { contrast: stringField(t.contrast, file, `${field}.term.contrast`) }) }; }
  if (raw.image !== undefined) { const image = record(raw.image, file, `${field}.image`); unknownFields(image, new Set(['src', 'alt']), file, `${field}.image`); node.image = { src: stringField(image.src, file, `${field}.image.src`), alt: stringField(image.alt, file, `${field}.image.alt`) }; }
  if (raw.link !== undefined) { const link = record(raw.link, file, `${field}.link`); unknownFields(link, new Set(['href', 'label']), file, `${field}.link`); node.link = { href: stringField(link.href, file, `${field}.link.href`), label: stringField(link.label, file, `${field}.link.label`) }; }
  if (raw.hash !== undefined) node.hash = stringField(raw.hash, file, `${field}.hash`);
  return node;
}

export function validateOutline(file: string, value: unknown, expectedCourseId?: string, expectedDrillId?: string): Outline {
  const raw = record(value, file, 'root');
  unknownFields(raw, new Set(['courseId', 'drillId', 'title', 'retiredIds', 'nodes']), file, 'root');
  const courseId = stringField(raw.courseId, file, 'courseId'); const drillId = stringField(raw.drillId, file, 'drillId');
  if (expectedCourseId !== undefined && courseId !== expectedCourseId) invalid(file, `courseId must match path "${expectedCourseId}"`);
  if (expectedDrillId !== undefined && drillId !== expectedDrillId) invalid(file, `drillId must match path "${expectedDrillId}"`);
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) invalid(file, 'nodes');
  const ids = new Set<string>();
  const nodes = raw.nodes.map((node, index) => validateNode(node, file, `nodes[${index}]`, 1, ids));
  let retiredIds: string[] | undefined;
  if (raw.retiredIds !== undefined) { if (!Array.isArray(raw.retiredIds) || raw.retiredIds.some((id) => typeof id !== 'string')) invalid(file, 'retiredIds'); retiredIds = raw.retiredIds as string[]; if (retiredIds.some((id) => ids.has(id))) invalid(file, 'retiredIds contains active node id'); }
  return { courseId, drillId, title: stringField(raw.title, file, 'title'), ...(retiredIds ? { retiredIds } : {}), nodes };
}

export async function loadOutline(courseId: string, drillId: string): Promise<Outline | undefined> {
  const { requireRepoForCourse } = await import('./courseRepos');
  const { contentReader, contentSource } = await import('./content/reader');
  const relativePath = `outlines/${courseId}/${drillId}.json`;
  const file = contentSource() === 'files' ? join(requireRepoForCourse(courseId).root, relativePath) : relativePath;
  safePath(file, relativePath, 'outline path');
  const bytes = await contentReader().readCourseFile(courseId, relativePath);
  return bytes === undefined ? undefined : validateOutline(file, JSON.parse(Buffer.from(bytes).toString('utf8')), courseId, drillId);
}

export function nodeInOutline(outline: Outline, nodeId: string): boolean {
  const visit = (node: OutlineNode): boolean => node.id === nodeId || (node.children?.some(visit) ?? false);
  return outline.nodes.some(visit);
}
