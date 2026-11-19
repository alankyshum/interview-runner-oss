import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Existing exceptional literals, counted so the allowlist cannot grow silently.
// cheatsheet: print, syntax highlighting and the two-color viewport marker;
// Native dialog backdrop: translucent overlay, not an opaque surface role.
const baseline = {
  // White is the intentional backing for authored light atlas image assets.
  'src/course/cheatsheet.css': ['white','#962459','#226b40','#775000','#1858a6','#576776','#ff9ac6','#8cdda8','#efc678','#9dc6ff','#b4c0ce','#fff','#111','#111','#fff','#eee','#777','#0645ad','#111','#f3f5f7','#111','#831548','#165b34','#644000','#114780','#46525e','#fff','#000'],
  // Native <dialog> backdrop is deliberately translucent and cannot be a surface token.
  'src/reader/reader.module.css': ['rgb(0 0 0 / 55%)'],
};
const color = /#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\da-z_-])|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\([^)]*\)/gi;
// CSS named colors, excluding transparent and currentColor, which are semantic values.
const names = 'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'.split(' ');
const namedColor = new RegExp(`(?<![\\w-])(?:${names.join('|')})(?![\\w-])`, 'gi');
const declarations = /(?:^|[`;{,\n])\s*['"]?([\w-]+)['"]?\s*:\s*/g;
const colorProperty = /^(?:--[\w-]+|color|background[\w-]*|border[\w-]*|outline[\w-]*|(?:box|text)[-\w]*shadow|text[-\w]*decoration[\w-]*|text[-\w]*emphasis[\w-]*|column[-\w]*rule[\w-]*|(?:-webkit-)?(?:filter|text-fill-color|text-stroke-color)|fill|stroke[\w-]*|stop-color|flood-color|lighting-color|caret[-\w]*|accent[-\w]*)$/i;
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith('.css') ? [join(dir, entry.name)] : []);
}
export function unexpectedColors(file, source) {
  if (file === 'src/ui/tokens.css') return [];
  const allowed = [...(baseline[file] ?? [])];
  const unexpected = [];
  const found = [...source.matchAll(color)].map((match) => ({ value: match[0], index: match.index }));
  for (const declaration of source.matchAll(declarations)) {
    if (!colorProperty.test(declaration[1])) continue;
    const start = declaration.index + declaration[0].length;
    const value = /^[^;}]*/.exec(source.slice(start))[0];
    const comparable = value.replace(/\/\*[\s\S]*?\*\/|url\([^)]*\)/gi, (part) => ' '.repeat(part.length));
    for (const match of comparable.matchAll(namedColor)) found.push({ value: match[0], index: start + match.index });
  }
  const distinct = [...new Map(found.map((match) => [match.index, match])).values()];
  for (const match of distinct.sort((a, b) => a.index - b.index)) {
    const index = allowed.indexOf(match.value);
    if (index >= 0) allowed.splice(index, 1);
    else unexpected.push(match.value);
  }
  return unexpected;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let failed = false;
  for (const file of walk('src')) {
    for (const value of unexpectedColors(file, readFileSync(file, 'utf8'))) {
      console.error(`${file}: raw color ${value} is not in the existing exception baseline`); failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  else console.log('UI CSS color check passed.');
}
