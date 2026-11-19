export type MapHighlight = {
  id: string;
  nodeKey: string;
  nodeText: string;
  lineage: string[];
  quote: string;
  prefix: string;
  suffix: string;
  offset: number;
  // Absent on legacy records, whose capture-time identity cannot be proven.
  captureAmbiguous?: boolean;
};

export const MAP_HIGHLIGHT_MAX_RECORDS = 512;
export const MAP_HIGHLIGHT_ID = /^[a-f0-9]{32}$/;
export const MAP_HIGHLIGHT_KEY = /^[a-f0-9]{16}$/;

export function validMapHighlight(value: unknown): value is MapHighlight {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const h = value as Record<string, unknown>;
  const keys = Object.keys(h).sort().join(',');
  if (keys !== 'id,lineage,nodeKey,nodeText,offset,prefix,quote,suffix' && keys !== 'captureAmbiguous,id,lineage,nodeKey,nodeText,offset,prefix,quote,suffix') return false;
  const text = (v: unknown, max: number, nonempty = false): v is string => typeof v === 'string' && v.length <= max && (!nonempty || Boolean(v.trim()));
  return text(h.id, 32, true) && MAP_HIGHLIGHT_ID.test(h.id)
    && text(h.nodeKey, 16, true) && MAP_HIGHLIGHT_KEY.test(h.nodeKey)
    && text(h.nodeText, 4096, true) && text(h.quote, 2048, true)
    && text(h.prefix, 128) && text(h.suffix, 128)
    && Array.isArray(h.lineage) && h.lineage.length <= 32 && h.lineage.every((part) => text(part, 1024, true))
    && (h.captureAmbiguous === undefined || typeof h.captureAmbiguous === 'boolean')
    && typeof h.offset === 'number' && Number.isSafeInteger(h.offset) && h.offset >= 0
    && h.nodeText.slice(h.offset, h.offset + h.quote.length) === h.quote
    && h.nodeText.slice(Math.max(0, h.offset - h.prefix.length), h.offset) === h.prefix
    && h.nodeText.slice(h.offset + h.quote.length, h.offset + h.quote.length + h.suffix.length) === h.suffix;
}
