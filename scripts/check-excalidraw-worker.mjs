import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';

const root = resolve('dist/excalidraw-assets');
const seen = new Set();
const allowed = new Set(['subset-worker.chunk.js', 'chunk-EIO257PC.js', 'chunk-ZUYEQ4TG.js', 'chunk-SRAX5OIU.js']);
async function check(file) {
  if (!file.startsWith(`${root}${sep}`) || seen.has(file)) return;
  if (!allowed.has(basename(file))) throw new Error(`Unexpected worker dependency: ${basename(file)}`);
  seen.add(file);
  const source = await readFile(file, 'utf8');
  const imports = [...source.matchAll(/(?:import|export)\s*(?:[^;]*?\s*from\s*)?["']([^"']+)["']/g), ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)];
  for (const match of imports) {
    const dependency = match[1];
    if (!dependency.startsWith('./')) throw new Error(`Worker imports outside its asset directory: ${dependency}`);
    const target = resolve(dirname(file), dependency);
    if (!target.startsWith(`${root}${sep}`)) throw new Error(`Worker imports outside its asset directory: ${dependency}`);
    await check(target);
  }
}
await check(resolve(root, 'subset-worker.chunk.js'));
if (seen.size !== allowed.size) throw new Error('Excalidraw subset worker dependencies were not inspected');
const assets = resolve('dist/assets');
let used = false;
for (const file of await readdir(assets)) if (file.endsWith('.js') && (await readFile(resolve(assets, file), 'utf8')).includes('/excalidraw-assets/subset-worker.chunk.js')) { used = true; break; }
if (!used) throw new Error('Built application does not use the isolated subset worker');
console.log(`Excalidraw worker graph isolated (${seen.size} files).`);
