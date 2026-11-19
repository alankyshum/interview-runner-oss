import { DEFAULT_THEME } from '@mantine/core';
import { describe, expect, it } from 'vitest';

function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  };
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + .05) / (low + .05);
}
const c = DEFAULT_THEME.colors;
describe('semantic color contrast', () => {
  it.each([
    ['text light', c.gray[9], '#ffffff'], ['text dark', c.gray[1], c.dark[9]],
    ['secondary light', c.gray[7], c.gray[0]], ['secondary dark', c.dark[0], c.dark[7]],
    ['placeholder light', c.gray[7], '#ffffff'], ['placeholder dark', c.dark[0], c.dark[6]],
    ['focus light', c.blue[9], c.gray[2]], ['focus dark', c.blue[3], c.dark[4]],
    ['primary light', '#ffffff', c.blue[8]], ['primary dark', c.gray[9], c.blue[3]],
    ['selected light', c.blue[9], c.blue[0]], ['selected dark', c.blue[0], c.blue[9]],
    ['success light', c.gray[9], c.green[0]], ['success dark', c.green[3], c.dark[4]],
    ['warning light', c.gray[9], c.yellow[1]], ['warning dark', c.yellow[3], c.dark[4]],
    ['danger light', c.red[9], c.red[0]], ['danger dark', c.red[3], c.dark[4]],
    ['danger hover light', c.red[9], c.gray[2]], ['danger hover dark', c.red[3], c.dark[5]],
    ['info light', c.blue[9], c.blue[0]], ['info dark', c.blue[3], c.dark[4]],
  ])('%s meets 4.5:1', (_name, foreground, background) => expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5));
  it.each([
    ['control boundary light', c.gray[7], c.gray[0]],
    ['control boundary dark', c.dark[2], c.dark[7]],
  ])('%s meets 3:1', (_name, foreground, background) => expect(contrast(foreground, background)).toBeGreaterThanOrEqual(3));
});
