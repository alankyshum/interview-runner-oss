import { readFileSync } from 'node:fs';
import { DEFAULT_THEME } from '@mantine/core';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/course/cheatsheet.css', 'utf8');
const luminance = (hex: string) => {
  const [r, g, b] = hex.slice(1).match(/../g)!.map((part) => parseInt(part, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1] + 0.05) / (values[0] + 0.05);
};

describe('coverage rail palette', () => {
  it.each([
    ['unvisited', 'blue', 8, 4], ['low', 'grape', 7, 3],
    ['medium', 'orange', 8, 3], ['high', 'red', 8, 4],
  ] as const)('%s retains 3:1 contrast in both themes', (step, color, light, dark) => {
    expect(css).toContain(`.coverage-rail [data-color-step="${step}"] { background: var(--mantine-color-${color}-${light}); }`);
    expect(css).toContain(`[data-mantine-color-scheme="dark"] .coverage-rail [data-color-step="${step}"] { background: var(--mantine-color-${color}-${dark}); }`);
    expect(contrast(DEFAULT_THEME.colors[color][light], '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrast(DEFAULT_THEME.colors[color][dark], DEFAULT_THEME.colors.dark[7])).toBeGreaterThanOrEqual(3);
  });
});
