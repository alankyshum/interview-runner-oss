import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('inverts only cheatsheet images and authored SVGs in dark screen mode', () => {
  const css = readFileSync(resolve(process.cwd(), 'src/course/cheatsheet.css'), 'utf8');
  const rule = css.match(/@media screen\s*\{\s*([^{}]+)\s*\{\s*filter:\s*invert\(1\) hue-rotate\(180deg\);\s*\}\s*\}/);
  expect(rule).not.toBeNull();
  const selector = rule![1].trim();
  const root = document.createElement('div');
  root.innerHTML = '<div class="cheatsheet-content"><img id="image"><img id="svg-image" src="diagram.svg"><svg id="diagram"><svg id="nested"></svg></svg><div data-markmap-src><svg id="map"></svg></div><div data-mermaid-src><svg id="mermaid"></svg></div></div><img id="outside"><svg id="icon"></svg>';
  document.body.append(root);
  const html = document.documentElement;
  const previous = html.getAttribute('data-mantine-color-scheme');
  try {
    html.setAttribute('data-mantine-color-scheme', 'light');
    expect(document.querySelectorAll(selector)).toHaveLength(0);
    html.setAttribute('data-mantine-color-scheme', 'dark');
    expect([...document.querySelectorAll(selector)].map((element) => element.id)).toEqual(['image', 'svg-image', 'diagram']);
    html.setAttribute('data-mantine-color-scheme', 'light');
    expect(document.querySelectorAll(selector)).toHaveLength(0);
  } finally {
    root.remove();
    if (previous === null) html.removeAttribute('data-mantine-color-scheme');
    else html.setAttribute('data-mantine-color-scheme', previous);
  }
});
