import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { unexpectedColors } from './check-ui-css.mjs';

describe('UI lint enforcement', () => {
  const eslint = new ESLint({ overrideConfigFile: 'tools/ui-lint/eslint.config.mjs' });
  it('rejects direct Mantine primitive imports and raw style colors in new screens', async () => {
    const [result] = await eslint.lintText("import { Button } from '@mantine/core'; export const Demo = () => <Button style={{ color: '#ffffff' }} />;", { filePath: 'src/ui-lint-probe.tsx' });
    expect(result.messages.map((message) => message.ruleId)).toEqual(expect.arrayContaining(['no-restricted-imports', 'ir/no-inline-color']));
  });
  it('allows semantic tokens and direct Mantine Tooltip for non-icon usage', async () => {
    const [result] = await eslint.lintText("import { Tooltip } from '@mantine/core'; export const Demo = () => <Tooltip label='Help'><span style={{ color: 'var(--ir-color-text)' }}>Help</span></Tooltip>;", { filePath: 'src/ui-lint-probe.tsx' });
    expect(result.errorCount).toBe(0);
  });
  it('rejects namespace imports that could bypass the primitive restriction', async () => {
    const [result] = await eslint.lintText("import * as Mantine from '@mantine/core'; export const Demo = () => <Mantine.Button>Run</Mantine.Button>;", { filePath: 'src/ui-lint-probe.tsx' });
    expect(result.messages.some((message) => message.ruleId === 'no-restricted-imports')).toBe(true);
  });
  it.each([
    ['embedded hex', '<style>{`.demo { color: #ff0000; }`}</style>'],
    ['embedded named color', '<style>{`.demo { background: rebeccapurple; }`}</style>'],
    ['embedded gradient names', '<style>{`.demo { background-image: linear-gradient(red, blue); }`}</style>'],
    ['embedded modern function', '<style>{`.demo { color: oklch(50% 0.2 20); }`}</style>'],
    ['embedded mixed raw colors', '<style>{`.demo { color: color-mix(in srgb, red, var(--ir-color-text)); }`}</style>'],
    ['dangerous style markup', '<style dangerouslySetInnerHTML={{ __html: ".demo { color: #ff0000; }" }} />'],
    ['inline named color', '<div style={{ color: "red" }} />'],
    ['nested styles', '<Thing styles={{ root: { color: "blue" } }} />'],
    ['inline modern function', '<div style={{ color: "lab(50% 30 20)" }} />'],
  ])('rejects %s in TSX', async (_label, markup) => {
    const [result] = await eslint.lintText(`export const Demo = () => ${markup};`, { filePath: 'src/ui-lint-probe.tsx' });
    expect(result.messages.some((message) => message.ruleId === 'ir/no-inline-color')).toBe(true);
  });
  it('accepts token-only mixes and non-color words in embedded styles', async () => {
    const [result] = await eslint.lintText('export const Demo = () => <style>{`.demo { content: "red"; background: color-mix(in srgb, var(--ir-color-text), var(--ir-color-surface)); }`}</style>;', { filePath: 'src/ui-lint-probe.tsx' });
    expect(result.errorCount).toBe(0);
  });
  it('rejects stylesheet templates in TypeScript files', async () => {
    const [result] = await eslint.lintText('export const css = `.demo { color: lab(50% 30 20); }`;', { filePath: 'src/ui-lint-probe.ts' });
    expect(result.messages.some((message) => message.ruleId === 'ir/no-inline-color')).toBe(true);
    const [tagged] = await eslint.lintText('export const css = style`color: red;`;', { filePath: 'src/ui-lint-probe.ts' });
    expect(tagged.messages.some((message) => message.ruleId === 'ir/no-inline-color')).toBe(true);
  });
});

describe('UI CSS literal ratchet', () => {
  it('rejects new literals and repeated exceptions but permits token roles', () => {
    expect(unexpectedColors('src/new.css', 'a { color: var(--ir-color-text); background: rgb(1 2 3); }')).toEqual(['rgb(1 2 3)']);
    expect(unexpectedColors('src/course/cheatsheet.css', 'a { color: #962459; } b { color: #962459; }')).toEqual(['#962459']);
    expect(unexpectedColors('src/ui/tokens.css', 'a { color: #fff; }')).toEqual([]);
  });
  it.each(['red', 'rebeccapurple', 'oklch(50% 0.2 20)', 'lab(50% 30 20)', 'lch(50% 30 20)', 'hwb(30 20% 30%)', 'color(display-p3 1 0 0)', 'color-mix(in srgb, red, var(--ir-color-text))', 'color-mix(in srgb, #f00, var(--ir-color-text))'])('rejects raw CSS color %s', (value) => {
    expect(unexpectedColors('src/new.css', `a { color: ${value}; }`).length).toBeGreaterThan(0);
  });
  it('allows semantic values and counts the documented atlas image backing once', () => {
    expect(unexpectedColors('src/new.css', 'a { color: currentColor; background: transparent; content: "red"; background-image: url(red.png); background-color: color-mix(in srgb, var(--ir-color-text), var(--ir-color-surface)); }')).toEqual([]);
    expect(unexpectedColors('src/course/cheatsheet.css', 'a { background: white; } b { color: white; }')).toEqual(['white']);
  });
  it('rejects named colors in gradients and text decorations', () => {
    expect(unexpectedColors('src/new.css', 'a { background-image: linear-gradient(red, blue); text-decoration: underline rebeccapurple; }')).toEqual(['red', 'blue', 'rebeccapurple']);
  });
});
