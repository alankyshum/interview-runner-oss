import { expect, it, vi } from 'vitest';
import { combineLegacyScenes, type WhiteboardSnapshot } from './whiteboardMigration';

vi.mock('@excalidraw/excalidraw', () => ({ getCommonBounds: (elements: Array<{ x: number; y: number; width: number; height: number }>) => [Math.min(...elements.map((e) => e.x)), Math.min(...elements.map((e) => e.y)), Math.max(...elements.map((e) => e.x + e.width)), Math.max(...elements.map((e) => e.y + e.height))] }));

it('combines legacy scenes side by side, preserving files, bindings and groups without ID collisions', () => {
  const scene = (text: string, x: number) => ({ scene: { elements: [{ id: 'box', type: 'rectangle', x, y: 30, width: 100, height: 50, groupIds: ['group'], boundElements: [{ id: 'arrow', type: 'arrow' }], frameId: null, isDeleted: false }, { id: 'arrow', type: 'arrow', x: x + 5, y: 40, width: 40, height: 10, groupIds: ['group'], startBinding: { elementId: 'box', focus: 0, gap: 1 }, endBinding: null, isDeleted: false }, { id: 'image', type: 'image', x: x + 10, y: 40, width: 20, height: 20, fileId: 'file', groupIds: [], isDeleted: false }], appState: {}, files: { file: { id: 'file', dataURL: text } } }, svg: '', updatedAt: 1 }) as unknown as WhiteboardSnapshot;
  const inputs = [scene('first', 10), scene('second', -50)]; const original = JSON.stringify(inputs);
  const merged = combineLegacyScenes(inputs); const items = merged.elements as unknown as Array<Record<string, any>>;
  expect(items).toHaveLength(6); expect(new Set(items.map((item) => item.id)).size).toBe(6);
  expect(items[3].x).toBeGreaterThan(items[0].x + items[0].width);
  expect(items[1].startBinding.elementId).toBe(items[0].id); expect(items[0].boundElements[0].id).toBe(items[1].id);
  expect(items[0].groupIds[0]).toBe(items[1].groupIds[0]); expect(items[3].groupIds[0]).not.toBe(items[0].groupIds[0]);
  expect(Object.keys(merged.files)).toHaveLength(2); expect(merged.files[items[2].fileId].dataURL).toBe('first'); expect(merged.files[items[5].fileId].dataURL).toBe('second');
  expect(JSON.stringify(inputs)).toBe(original);
});

it('fails without discarding malformed or missing image data', () => {
  const image = { id: 'image', type: 'image', x: 0, y: 0, width: 10, height: 10, fileId: 'missing', groupIds: [], isDeleted: false };
  const snapshot = { scene: { elements: [image], appState: {}, files: {} }, svg: '', updatedAt: 1 } as unknown as WhiteboardSnapshot;
  expect(() => combineLegacyScenes([snapshot])).toThrow('image file is missing');
  expect(() => combineLegacyScenes([{ ...snapshot, scene: { ...snapshot.scene, elements: [image, image] as never, files: { missing: { dataURL: 'data:image/png;base64,abc' } } as never } }])).toThrow('duplicate element');
});
