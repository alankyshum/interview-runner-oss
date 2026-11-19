import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const path = `${process.env.IR_USER_DATA_DIR ?? '/home/coder/.ir'}/User/settings.json`; const enabled = process.argv[2] === 'true';
await mkdir(dirname(path), { recursive: true });
const settings = JSON.parse(await readFile(path, 'utf8').catch(() => '{}'));
Object.assign(settings, enabled ? { 'editor.quickSuggestions': false, 'editor.suggestOnTriggerCharacters': false, 'editor.inlineSuggest.enabled': false, 'editor.parameterHints.enabled': false, 'editor.hover.enabled': false } : { 'editor.quickSuggestions': true, 'editor.suggestOnTriggerCharacters': true, 'editor.inlineSuggest.enabled': true, 'editor.parameterHints.enabled': true, 'editor.hover.enabled': true });
await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`);
process.stdout.write('IR_RESULT {"saved":true}\n');
