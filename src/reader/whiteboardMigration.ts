import { getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawProps } from '@excalidraw/excalidraw/types';

type Change = NonNullable<ExcalidrawProps['onChange']>;
export type WhiteboardScene = { elements: Parameters<Change>[0]; appState: Partial<Parameters<Change>[1]>; files: Parameters<Change>[2] };
export type WhiteboardSnapshot = { scene: WhiteboardScene; svg: string; updatedAt: number };

/** Preserve every legacy scene, moving each scene as a unit and keeping bindings local to it. */
export function combineLegacyScenes(snapshots: WhiteboardSnapshot[]): WhiteboardScene {
  const elements: Array<Record<string, unknown>> = [];
  const files: Record<string, unknown> = {};
  let cursor = 0;
  snapshots.forEach((snapshot, index) => {
    const scene = snapshot.scene; const visible = scene.elements.filter((element) => !element.isDeleted);
    const bounds = visible.length ? getCommonBounds(visible) : [0, 0, 0, 0];
    if (bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) throw new Error('A legacy whiteboard has invalid bounds');
    const [left, top, right] = bounds;
    const shiftX = cursor - left; const shiftY = -top;
    const elementId = (id: string) => `legacy-${index}-element-${id}`;
    const groupId = (id: string) => `legacy-${index}-group-${id}`;
    const fileId = (id: string) => `legacy-${index}-file-${id}`;
    const ids = new Set<string>();
    for (const [id, file] of Object.entries(scene.files)) {
      if (!file || typeof file !== 'object' || typeof file.dataURL !== 'string') throw new Error('A legacy whiteboard has an invalid image file');
      files[fileId(id)] = { ...file, id: fileId(id) };
    }
    for (const element of scene.elements) {
      const item = structuredClone(element) as unknown as Record<string, unknown>;
      if (typeof item.id !== 'string' || ids.has(item.id) || typeof item.x !== 'number' || typeof item.y !== 'number' || !Number.isFinite(item.x) || !Number.isFinite(item.y)) throw new Error('A legacy whiteboard has an invalid or duplicate element');
      ids.add(item.id);
      item.id = elementId(item.id); item.x += shiftX; item.y += shiftY; item.index = null;
      if (Array.isArray(item.groupIds)) item.groupIds = item.groupIds.map((id) => typeof id === 'string' ? groupId(id) : id);
      for (const field of ['frameId', 'containerId'] as const) if (typeof item[field] === 'string') item[field] = elementId(item[field]);
      if (typeof item.fileId === 'string') { if (!Object.hasOwn(scene.files, item.fileId)) throw new Error('A legacy whiteboard image file is missing'); item.fileId = fileId(item.fileId); }
      if (Array.isArray(item.boundElements)) item.boundElements = item.boundElements.map((bound: Record<string, unknown>) => { if (!bound || typeof bound !== 'object' || typeof bound.id !== 'string') throw new Error('A legacy whiteboard has an invalid binding'); return { ...bound, id: elementId(bound.id) }; });
      for (const field of ['startBinding', 'endBinding'] as const) {
        const binding = item[field];
        if (binding && typeof binding === 'object' && typeof (binding as Record<string, unknown>).elementId === 'string') item[field] = { ...binding, elementId: elementId((binding as { elementId: string }).elementId) };
      }
      elements.push(item);
    }
    if (visible.length) cursor += Math.max(0, right - left) + 160;
  });
  return { elements: elements as unknown as WhiteboardScene['elements'], appState: { ...(snapshots[0]?.scene.appState ?? {}), scrollX: 0, scrollY: 0, zoom: { value: 1 as never } }, files: files as WhiteboardScene['files'] };
}
