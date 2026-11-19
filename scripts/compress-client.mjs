import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

async function compress(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await compress(file);
    else if (entry.isFile() && /\.(?:html|css|js|json|svg)$/.test(entry.name)) {
      const bytes = await readFile(file);
      await writeFile(`${file}.br`, await brotli(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
      await writeFile(`${file}.gz`, await gz(bytes, { level: 9 }));
    }
  }
}

await compress('dist');
