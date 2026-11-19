import { isUtf8 } from 'node:buffer';

// Textual SVG is still an image, not searchable course text.
const binaryAssetExtension = /\.(?:7z|ai|apng|avif|bin|bmp|bz2|class|dmg|dng|dll|dylib|eot|eps|exe|gif|gz|heic|heif|ico|icns|jar|jpe?g|jfif|jxl|mov|mp3|mp4|nef|otf|pdf|png|psd|rar|so|svg|svgz|tar|tga|tiff?|ttf|wasm|wav|webm|webp|woff2?|xz|zip)$/i;

export function isTextAsset(path: string, bytes: Uint8Array): boolean {
  if (binaryAssetExtension.test(path) || !isUtf8(bytes)) return false;
  if (bytes.some((value) => value === 0 || (value < 32 && ![9, 10, 12, 13].includes(value)) || value === 127)) return false;
  const prefix = Buffer.from(bytes.subarray(0, 4096)).toString('utf8');
  if (prefix.startsWith('%PDF-') || /^\s*(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix)) return false;
  return true;
}

export function assetText(path: string, bytes: Uint8Array): string | undefined {
  if (!isTextAsset(path, bytes)) return undefined;
  const text = Buffer.from(bytes).toString('utf8');
  if (path.endsWith('.json')) {
    const strings: string[] = [];
    const visit = (value: unknown): void => { if (typeof value === 'string') strings.push(value); else if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') Object.values(value).forEach(visit); };
    try { visit(JSON.parse(text)); return strings.join(' '); } catch { return text; }
  }
  return /\.html?$/i.test(path) ? text.replace(/<[^>]*>/g, ' ') : text;
}
